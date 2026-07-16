import { ErrnoError } from "@erdou/runtime-contract";
import type { ByteStream, ExitStatus, ProcessInfo } from "@erdou/runtime-contract";
import { encodeJsonFrame, FrameReader, decodeJson, FrameType } from "./guestd-protocol.js";

export interface GuestChannel {
  send(bytes: Uint8Array): void;
  subscribe(cb: (bytes: Uint8Array) => void): void;
}

export interface GuestProcess {
  pid: number;
  stdout: ByteStream;
  stderr: ByteStream;
  wait(): Promise<ExitStatus>;
  kill(signal?: string): Promise<void>;
}

/** A ByteStream fed by pushed chunks, closed by end(). */
class ChunkStream implements ByteStream {
  private chunks: Uint8Array[] = [];
  private resolvers: Array<(r: IteratorResult<Uint8Array>) => void> = [];
  private closed = false;
  push(b: Uint8Array): void {
    if (this.resolvers.length) this.resolvers.shift()!({ value: b, done: false });
    else this.chunks.push(b);
  }
  end(): void {
    this.closed = true;
    while (this.resolvers.length) this.resolvers.shift()!({ value: undefined as unknown as Uint8Array, done: true });
  }
  read(): AsyncIterableIterator<Uint8Array> {
    const self = this;
    return {
      [Symbol.asyncIterator]() { return this; },
      next(): Promise<IteratorResult<Uint8Array>> {
        if (self.chunks.length) return Promise.resolve({ value: self.chunks.shift()!, done: false });
        if (self.closed) return Promise.resolve({ value: undefined as unknown as Uint8Array, done: true });
        return new Promise((res) => self.resolvers.push(res));
      },
    };
  }
  async text(): Promise<string> {
    const parts: Uint8Array[] = [];
    for await (const c of this.read()) parts.push(c);
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return new TextDecoder().decode(out);
  }
}

interface Pending {
  stdout: ChunkStream;
  stderr: ChunkStream;
  onStarted?: (pid: number) => void;
  onExit?: (s: ExitStatus) => void;
  onError?: (e: Error) => void;
}

export class GuestdClient {
  private readonly reader = new FrameReader();
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly control = new Map<number, (frame: { type: string; body: Uint8Array }) => void>();
  private readyResolve?: (v: { pid: number }) => void;
  private readonly readyPromise: Promise<{ pid: number }>;
  private pingTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly channel: GuestChannel) {
    this.readyPromise = new Promise((res) => { this.readyResolve = res; });
    this.channel.subscribe((bytes) => {
      for (const f of this.reader.push(bytes)) this.onFrame(f.type, f.id, f.body);
    });
  }

  /** Resolve when guestd is reachable. After a state RESTORE the guest sits idle
   *  and its one-time startup READY already fired (pre-snapshot) — so we KICK:
   *  send PING repeatedly until guestd replies READY. (Spike C: the first hvc0
   *  frame is the kick; without it boot() can hang forever.) */
  ready(): Promise<{ pid: number }> {
    if (!this.pingTimer) {
      const ping = () => this.channel.send(encodeJsonFrame(FrameType.PING, 0, {}));
      ping();
      this.pingTimer = setInterval(ping, 200);
      void this.readyPromise.then(() => { if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = undefined; } });
    }
    return this.readyPromise;
  }

  private onFrame(type: string, id: number, body: Uint8Array): void {
    if (type === FrameType.READY) { this.readyResolve?.(decodeJson(body) as { pid: number }); return; }
    const ctl = this.control.get(id);
    if (ctl) { ctl({ type, body }); return; }
    const p = this.pending.get(id);
    if (!p) return;
    switch (type) {
      case FrameType.STARTED: p.onStarted?.((decodeJson(body) as { pid: number }).pid); break;
      case FrameType.STDOUT: p.stdout.push(body); break;
      case FrameType.STDERR: p.stderr.push(body); break;
      case FrameType.EXIT: {
        p.stdout.end(); p.stderr.end();
        p.onExit?.(decodeJson(body) as ExitStatus);
        this.pending.delete(id);
        break;
      }
      case FrameType.ERROR: {
        p.stdout.end(); p.stderr.end();
        p.onError?.(new Error((decodeJson(body) as { message: string }).message));
        this.pending.delete(id);
        break;
      }
    }
  }

  private run(op: string, payload: Record<string, unknown>): Promise<GuestProcess> {
    const id = this.nextId++;
    const stdout = new ChunkStream();
    const stderr = new ChunkStream();
    let resolveStarted!: (pid: number) => void;
    let rejectStart!: (e: Error) => void;
    const started = new Promise<number>((res, rej) => { resolveStarted = res; rejectStart = rej; });
    let resolveExit!: (s: ExitStatus) => void;
    const exit = new Promise<ExitStatus>((res) => { resolveExit = res; });
    this.pending.set(id, {
      stdout, stderr,
      onStarted: resolveStarted,
      onExit: resolveExit,
      onError: (e) => rejectStart(e),
    });
    this.channel.send(encodeJsonFrame(op, id, payload));
    return started.then((pid) => ({
      pid, stdout, stderr,
      wait: () => exit,
      kill: (signal?: string) => this.kill(pid, signal),
    }));
  }

  exec(cmdline: string, opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<GuestProcess> {
    return this.run(FrameType.EXEC, { cmd: cmdline, cwd: opts.cwd, env: opts.env }).catch((e) => {
      throw e instanceof ErrnoError ? e : new ErrnoError("ENOENT", { path: cmdline, syscall: "exec" });
    });
  }

  spawn(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<GuestProcess> {
    return this.run(FrameType.SPAWN, { cmd, args, cwd: opts.cwd, env: opts.env }).catch(() => {
      throw new ErrnoError("ENOENT", { path: cmd, syscall: "spawn" });
    });
  }

  kill(pid: number, signal = "SIGTERM"): Promise<void> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.control.set(id, () => { this.control.delete(id); resolve(); });
      this.channel.send(encodeJsonFrame(FrameType.KILL, id, { pid, signal }));
    });
  }

  ps(): Promise<ProcessInfo[]> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.control.set(id, ({ body }) => {
        this.control.delete(id);
        resolve((decodeJson(body) as { procs: ProcessInfo[] }).procs);
      });
      this.channel.send(encodeJsonFrame(FrameType.PS, id, {}));
    });
  }
}
