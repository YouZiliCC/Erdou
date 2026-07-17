import { ErrnoError } from "@erdou/runtime-contract";
import type {
  Runtime, SpawnOptions, ProcessHandle, ProcessInfo, ExitStatus, Signal,
  Stat, FileEntry, WriteFileOptions, MkdirOptions, RmOptions,
  RuntimeCapabilities, RuntimeEvent, RuntimeEventListener, Unsubscribe, Snapshot,
  VirtualPort, HttpRequest, HttpResponse,
} from "@erdou/runtime-contract";
import { V86Host } from "./v86-host.js";
import { Fs9pBridge } from "./fs-bridge.js";
import { GuestdClient, type GuestProcess } from "./guestd-client.js";
import { snapshotWorkspace, restoreWorkspace } from "./workspace-snapshot.js";
import { vmCapabilities } from "./capabilities.js";
import { PROFILE_META, type VmProfile } from "./profiles.js";
import { openPtySession, type PtySession } from "./pty.js";
import { SyncFs9pFs } from "./sync-fs.js";
import { serializeHttpRequest, parseHttpResponse, responseComplete } from "./http-codec.js";

const SIG = (s?: Signal): string => s ?? "SIGTERM";

/** A retained runtime-side process record (survives exit). */
interface ProcRecord {
  pid: number;
  cmd: string;
  args: string[];
  proc: GuestProcess;
  state: "running" | "exited" | "killed";
  status: ExitStatus | null;
  waited: Promise<ExitStatus>;
}

export class VmRuntime implements Runtime {
  private host: V86Host;
  private bridge!: Fs9pBridge;
  private guestd!: GuestdClient;
  private readonly listeners = new Set<RuntimeEventListener>();
  /** Ports currently reachable+listening (idempotent emit tracking). */
  private readonly openPorts = new Set<number>();
  /** Ports bound loopback-only (not previewable) — tracked so we emit the hint once. */
  private readonly loopbackPorts = new Set<number>();
  // Retained per pid — kept AFTER exit (unlike guestd.ps(), which only lists
  // live /proc) so wait()/kill()/getProcesses() honor the contract for an
  // already-exited process. BrowserRuntime's process table never deletes
  // records either; VmRuntime must match.
  private readonly procs = new Map<number, ProcRecord>();
  private readonly clock: () => number;
  private readonly bootTimeoutMs: number | undefined;
  /** Which baked image this runtime was constructed for — drives getCapabilities
   *  so the agent is told the truth about the running image (node reports node/npm,
   *  not a hardcoded python3). Passed in `opts` to preserve the (loader, opts)
   *  shape existing call sites use; defaults to "base" for single-image callers. */
  private readonly profile: VmProfile;
  private booted = false;
  private readonly ptyPorts = new Set<number>();

  constructor(
    private readonly loadInputs: () => Promise<import("./v86-host.js").V86BootInputs>,
    opts: { clock?: () => number; bootTimeoutMs?: number; profile?: VmProfile } = {},
  ) {
    this.host = new V86Host();
    this.clock = opts.clock ?? (() => Date.now());
    this.bootTimeoutMs = opts.bootTimeoutMs;
    this.profile = opts.profile ?? "base";
  }

  private emit(e: RuntimeEvent): void { for (const l of this.listeners) { try { l(e); } catch (err) { console.error("VmRuntime listener threw:", err); } } }

  async boot(): Promise<void> {
    if (this.booted) return;
    // Reset port-tracking bookkeeping so a boot() after shutdown() on the same
    // instance starts clean (a genuinely-reopened port must still emit
    // port.opened) — no-op on a fresh instance, where both Sets are empty already.
    this.openPorts.clear();
    this.loopbackPorts.clear();
    const inputs = await this.loadInputs();
    await this.host.boot(inputs, this.bootTimeoutMs ? { bootTimeoutMs: this.bootTimeoutMs } : {});
    this.bridge = new Fs9pBridge(this.host.fs9p, (e) => this.emit(e));
    this.bridge.attach();          // wraps fs9p + builds the workspace path index from the restored state
    this.host.run();               // resume the CPU from the baked state (guestd is already resident)
    this.guestd = new GuestdClient(this.host.channel());
    this.guestd.onPortEvent((e) => this.onGuestPortEvent(e));                    // real /proc/net/tcp watcher → port.opened/closed + loopback hint
    await this.guestd.ready({ deadlineMs: this.bootTimeoutMs ?? 60_000 });      // first hvc0 frame is the kick; guestd replies READY
    // Networking (eth0 DHCP + loopback) is fully baked into the saved state
    // (bake step 4.5 asserts both) — no per-boot setup.
    this.booted = true;
  }

  async shutdown(): Promise<void> {
    if (!this.booted) { if (this.host) await this.host.destroy().catch(() => {}); return; }
    this.booted = false;
    this.guestd?.dispose();   // ends open ChunkStreams + rejects pending (via its own `pending` map)
    this.bridge?.dispose();
    await this.host.destroy().catch(() => {});
  }

  // ---- process (guestd) ----
  private track(p: GuestProcess, cmd: string, args: string[]): ProcessHandle {
    const rec: ProcRecord = { pid: p.pid, cmd, args, proc: p, state: "running", status: null, waited: p.wait() };
    this.procs.set(p.pid, rec);
    this.emit({ type: "process.started", pid: p.pid, cmd });
    void rec.waited.then((s) => {
      rec.status = s;
      rec.state = s.signal ? "killed" : "exited"; // record survives (NOT deleted)
      this.emit({ type: "process.exited", pid: p.pid, code: s.code, signal: s.signal });
    });
    const stdinEnded = { write() {}, end() {} };
    return { pid: p.pid, stdout: p.stdout, stderr: p.stderr, stdin: stdinEnded, wait: () => rec.waited, kill: (s?: Signal) => p.kill(SIG(s)) };
  }

  async exec(commandLine: string, options?: Omit<SpawnOptions, "cmd" | "args">): Promise<ProcessHandle> {
    return this.track(await this.guestd.exec(commandLine, { cwd: options?.cwd, env: options?.env }), commandLine, []);
  }
  async spawn(options: SpawnOptions): Promise<ProcessHandle> {
    return this.track(await this.guestd.spawn(options.cmd, options.args ?? [], { cwd: options.cwd, env: options.env }), options.cmd, options.args ?? []);
  }
  async kill(pid: number, signal?: Signal): Promise<void> {
    const rec = this.procs.get(pid);
    if (!rec) throw new ErrnoError("ESRCH", { path: String(pid), syscall: "kill" });
    if (rec.state !== "running") return; // killing an already-exited pid is a no-op, not an error
    await rec.proc.kill(SIG(signal));
  }
  async wait(pid: number): Promise<ExitStatus> {
    const rec = this.procs.get(pid);
    if (!rec) throw new ErrnoError("ESRCH", { path: String(pid), syscall: "wait" });
    return rec.status ?? rec.waited; // stored status if already exited, else the live promise
  }
  async getProcesses(): Promise<ProcessInfo[]> {
    // Merge live guest /proc with our retained exited records (dedup by pid), so
    // a process that has exited still appears with state "exited"/"killed".
    const live = await this.guestd.ps();
    const seen = new Set(live.map((p) => p.pid));
    const retained: ProcessInfo[] = [];
    for (const rec of this.procs.values()) {
      if (seen.has(rec.pid)) continue;
      retained.push({ pid: rec.pid, ppid: 0, cmd: rec.cmd, args: rec.args, cwd: "/", state: rec.state, startTimeMs: 0, exitCode: rec.status?.code ?? null });
    }
    return [...live, ...retained];
  }

  // ---- pty ----
  async openPty(opts: { cols?: number; rows?: number } = {}): Promise<PtySession> {
    const port = [1, 2, 3].find((p) => !this.ptyPorts.has(p));
    if (port === undefined) throw new Error("VmRuntime: all 3 PTY ports are in use");
    this.ptyPorts.add(port);
    try {
      // Subscribe (inside openPtySession) BEFORE ptyOpen fires — see the ordering
      // note in pty.ts. openPtySession calls launch() only after it has subscribed.
      const channel = this.host.terminal(port as 1 | 2 | 3);
      const session = await openPtySession(
        channel,
        () => this.guestd.ptyOpen(port),
        (pid) => this.guestd.kill(pid, "SIGKILL"),
        { deadlineMs: 15_000 },
      );
      session.resize(opts.cols ?? 80, opts.rows ?? 24); // hvc<port> starts 0×0 — send an initial size
      const origDispose = session.dispose;
      session.dispose = async () => { this.ptyPorts.delete(port); await origDispose(); };
      return session;
    } catch (e) {
      this.ptyPorts.delete(port); // release the port if the bridge never came up
      throw e;
    }
  }

  // ---- filesystem (bridge) ----
  readFile(p: string): Promise<Uint8Array> { return this.bridge.readFile(p); }
  writeFile(p: string, d: Uint8Array | string, o?: WriteFileOptions): Promise<void> { return this.bridge.writeFile(p, d, o); }
  readdir(p: string): Promise<FileEntry[]> { return this.bridge.readdir(p); }
  mkdir(p: string, o?: MkdirOptions): Promise<void> { return this.bridge.mkdir(p, o); }
  rm(p: string, o?: RmOptions): Promise<void> { return this.bridge.rm(p, o); }
  rename(f: string, t: string): Promise<void> { return this.bridge.rename(f, t); }
  stat(p: string): Promise<Stat> { return this.bridge.stat(p); }

  /** A synchronous FileSystemApi over the guest workspace, sharing this runtime's
   *  event bus. Page-side creates, deletes, and directory-creates can double with
   *  the async bridge's coalesced event (Fs9pBridge.attach wraps CreateFile,
   *  CreateDirectory, and Unlink — both observe the same fs9p mutation). Harmless for
   *  the app: its file.changed handler only bumps an fsVersion counter + debounces
   *  saves (idempotent under a duplicate), and the turn-scoped diff capture keys by
   *  path. A consumer that COUNTS events would over-count. Available after boot(). */
  syncFs(): SyncFs9pFs {
    if (!this.booted) throw new Error("VmRuntime.syncFs(): not booted");
    return new SyncFs9pFs(this.host.fs9p, (e) => this.emit(e));
  }

  // ---- snapshot (workspace-scoped) ----
  async createSnapshot(): Promise<Snapshot> { this.bridge.flush(); return snapshotWorkspace(this.host.fs9p, this.clock); }
  async restoreSnapshot(s: Snapshot): Promise<void> { await restoreWorkspace(this.host.fs9p, this.bridge, s); }

  // ---- ports (real guest proxy; Round 12) ----
  private emitOpened(port: number): void {
    this.loopbackPorts.delete(port);
    if (this.openPorts.has(port)) return;
    this.openPorts.add(port);
    this.emit({ type: "port.opened", port, url: `/__port__/${port}/` });
  }
  private emitClosed(port: number): void {
    this.loopbackPorts.delete(port);
    if (!this.openPorts.delete(port)) return;
    this.emit({ type: "port.closed", port });
  }
  private emitLoopback(port: number): void {
    if (this.openPorts.has(port) || this.loopbackPorts.has(port)) return;
    this.loopbackPorts.add(port);
    this.emit({
      type: "resource.warning",
      resource: `port:${port}`,
      detail: `Server on port ${port} is bound to loopback (127.0.0.1) — bind 0.0.0.0 to make it previewable.`,
    });
  }
  /** guestd /proc/net/tcp watcher → runtime bus. Reachable listen → opened;
   *  gone → closed; loopback-only listen → a visible "bind 0.0.0.0" hint. */
  private onGuestPortEvent(e: { port: number; listening: boolean; loopback: boolean }): void {
    if (!e.listening) { this.emitClosed(e.port); return; }
    if (e.loopback) this.emitLoopback(e.port);
    else this.emitOpened(e.port);
  }

  async listen(port: number): Promise<VirtualPort> {
    this.emitOpened(port);
    return { port, close: async () => this.emitClosed(port) };
  }
  async exposePort(port: number): Promise<string> {
    this.emitOpened(port);
    return `/__port__/${port}/`;
  }

  /** Reverse-proxy an HTTP request into a real server running inside the guest.
   *  Probe-first (fast + reliable): a closed OR loopback-only bind probes false →
   *  a real 502, never a hang. Otherwise open a per-request TCP connection into
   *  the guest, write the serialized request on the async `connect` event,
   *  accumulate `data`, and finish on a self-describing completion rule
   *  (Content-Length satisfied / chunked terminator) OR a 600ms idle timer OR
   *  the unreliable `close` OR a 15s hard cap. Verified in the Round-12 spike. */
  async dispatch(port: number, req: HttpRequest): Promise<HttpResponse> {
    const net = this.host.networkAdapter();
    // Probe-first: fast + reliable (mac fix). A closed OR loopback-only bind
    // probes false → a real 502, never a hang.
    if (!(await net.tcp_probe(port))) {
      return { status: 502, headers: { "content-type": "text/plain" }, body: new TextEncoder().encode(`No server listening on port ${port}`) };
    }
    const raw = serializeHttpRequest(req);
    // dispatch() ALWAYS resolves an HttpResponse — it must NEVER reject.
    // `Promise<HttpResponse>` has no error contract, so every completion path
    // (self-describing complete / idle / close / hard cap) funnels through the
    // guarded `toResponse` below and resolves, even on a parse failure.
    return await new Promise<HttpResponse>((resolve) => {
      const conn = net.connect(port);
      const chunks: Uint8Array[] = [];
      let idle: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      const acc = (): Uint8Array => {
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total);
        let o = 0;
        for (const c of chunks) { out.set(c, o); o += c.length; }
        return out;
      };
      const plain502 = (msg: string): HttpResponse => (
        { status: 502, headers: { "content-type": "text/plain" }, body: new TextEncoder().encode(msg) }
      );
      const toResponse = (bytes: Uint8Array): HttpResponse => {
        // M2: a no-bytes close (closed-port RST / connect that produced nothing)
        // reads as 502, not a false "timed out within 15s".
        if (bytes.length === 0) return plain502(`No response from port ${port}`);
        // parseHttpResponse throws when bytes arrived but no CRLFCRLF header
        // terminator has (guest paused mid-headers → reachable via the idle timer
        // / hard cap). A parse failure resolves to a neutral 502 — never rejects.
        try { return parseHttpResponse(bytes); }
        catch { return plain502(`Bad Gateway: malformed or incomplete response from port ${port}`); }
      };
      const finish = (): void => {
        if (done) return;
        done = true;
        if (idle) clearTimeout(idle);
        clearTimeout(hard);
        resolve(toResponse(acc()));
        // Release the conn from the emulator's tcp_conn table. python HTTP/1.0
        // FINs after responding, parking the conn in `close-wait`; only OUR
        // close() completes the passive close (→ release()). Guarded so a
        // close() throw can't disturb the already-resolved dispatch.
        try { conn.close(); } catch { /* already-resolved; ignore */ }
      };
      // Hard cap: never hang forever if the guest wedges mid-response.
      const hard = setTimeout(finish, 15_000);
      conn.on("connect", () => conn.write(raw));
      conn.on("data", (d) => {
        chunks.push(d instanceof Uint8Array ? d : new Uint8Array(d as ArrayBufferLike));
        // responseComplete → parseHeaderLines can throw on a malformed status line
        // inside this emulator callback (no reject path). Treat a throw as "not
        // complete yet" — the idle timer / hard cap + guarded parse finish it.
        let complete = false;
        try { complete = responseComplete(acc()); } catch { complete = false; }
        if (complete) { finish(); return; }
        if (idle) clearTimeout(idle);
        idle = setTimeout(finish, 600); // idle fallback for keep-alive servers with no length info
      });
      conn.on("close", finish); // unreliable — a backstop, not the primary condition
    });
  }
  async closePort(port: number): Promise<void> { this.emitClosed(port); }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    // Per-profile, not hardcoded: report exactly what this image bakes so a run
    // started on vm:node surfaces node/npm (PROFILE_META is the single source of truth).
    const meta = PROFILE_META[this.profile];
    return vmCapabilities(meta.interpreters, meta.packageManagers);
  }
  subscribe(l: RuntimeEventListener): Unsubscribe { this.listeners.add(l); return () => this.listeners.delete(l); }
}
