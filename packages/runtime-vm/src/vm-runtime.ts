import { ErrnoError } from "@erdou/runtime-contract";
import type {
  Runtime, SpawnOptions, ProcessHandle, ProcessInfo, ExitStatus, Signal,
  Stat, FileEntry, WriteFileOptions, MkdirOptions, RmOptions,
  RuntimeCapabilities, RuntimeEvent, RuntimeEventListener, Unsubscribe, Snapshot,
  VirtualPort, HttpRequest, HttpResponse, WsConnection,
} from "@erdou/runtime-contract";
import { V86Host, type TcpConn } from "./v86-host.js";
import { Fs9pBridge } from "./fs-bridge.js";
import { GuestdClient, type GuestProcess } from "./guestd-client.js";
import { snapshotWorkspace, restoreWorkspace } from "./workspace-snapshot.js";
import { vmCapabilities } from "./capabilities.js";
import { PROFILE_META, type VmProfile } from "./profiles.js";
import { openPtySession, type PtySession } from "./pty.js";
import { SyncFs9pFs } from "./sync-fs.js";
import { serializeHttpRequest, parseHttpResponse, responseComplete, parseHead, ChunkedDecoder, type ParsedHead } from "./http-codec.js";
import {
  makeWsKey, buildUpgradeRequest, validateHandshake, encodeText, encodeBinary, encodePong,
  encodeClose, WsFrameParser,
} from "./ws-codec.js";

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
  /** Live WebSocket teardowns (see upgrade()) — run on shutdown so no
   *  connection outlives its emulator. */
  private readonly wsTeardowns = new Set<(cause: string) => void>();

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
    // Close live WebSockets first (fires their onClose with a truthful cause)
    // while the emulator can still deliver the conn.close().
    for (const t of [...this.wsTeardowns]) t("runtime shutdown");
    this.wsTeardowns.clear();
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
   *  the guest, write the serialized request on the async `connect` event, and
   *  accumulate `data`.
   *
   *  Two-phase (SSE streaming): each `data` event first tries to parse the
   *  response HEAD. A `content-type: text/event-stream` head resolves dispatch
   *  IMMEDIATELY with `HttpResponse.stream` fed by the subsequent `data`
   *  events (chunked framing decoded incrementally; an unframed body ends at
   *  conn close) — with NO idle timer (silence is legal in SSE) and the 15s
   *  hard cap cleared (it bounds head arrival only; a live stream may outlast
   *  it). A consumer `return()` (client gone) closes the guest conn, which
   *  also releases the emulator's tcp_conn entry.
   *
   *  Every OTHER response keeps the Round-12 buffered behavior byte-for-byte:
   *  finish on a self-describing completion rule (Content-Length satisfied /
   *  chunked terminator) OR a 600ms idle timer OR the unreliable `close` OR
   *  the 15s hard cap. Verified in the Round-12 spike + the SSE spike. */
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
    // (SSE head / self-describing complete / idle / close / hard cap) funnels
    // through a guarded resolve, even on a parse failure. (A streamed BODY may
    // still error its iterable — that is the stream's error channel, after
    // dispatch has already resolved.)
    return await new Promise<HttpResponse>((resolve) => {
      const conn = net.connect(port);
      const chunks: Uint8Array[] = [];
      let idle: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      // Head sniffing happens at most until it parses; the SSE decision is
      // made exactly once.
      let headKnown = false;
      let sse: { queue: ByteQueue; decoder: ChunkedDecoder | null } | null = null;
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
      // Release the conn from the emulator's tcp_conn table. python HTTP/1.0
      // FINs after responding, parking the conn in `close-wait`; only OUR
      // close() completes the passive close (→ release()). Guarded so a
      // close() throw can't disturb an already-resolved dispatch.
      const closeConn = (): void => { try { conn.close(); } catch { /* ignore */ } };
      const finish = (): void => {
        if (done) return;
        done = true;
        if (idle) clearTimeout(idle);
        clearTimeout(hard);
        resolve(toResponse(acc()));
        closeConn();
      };
      // Hard cap: never hang forever if the guest wedges mid-response.
      const hard = setTimeout(finish, 15_000);
      const endStream = (): void => { if (!sse) return; sse.queue.end(); closeConn(); };
      const feedStream = (c: Uint8Array): void => {
        if (!sse) return;
        if (!sse.decoder) { sse.queue.push(c); return; }
        let decoded: Uint8Array[];
        try { decoded = sse.decoder.push(c); }
        catch (err) {
          // Malformed chunked framing: error the stream (fail-fast, visible to
          // the consumer) instead of silently truncating, and drop the conn.
          sse.queue.fail(err instanceof Error ? err : new Error(String(err)));
          closeConn();
          return;
        }
        for (const d of decoded) sse.queue.push(d);
        if (sse.decoder.finished) endStream();
      };
      conn.on("connect", () => conn.write(raw));
      conn.on("data", (d) => {
        const chunk = d instanceof Uint8Array ? d : new Uint8Array(d as ArrayBufferLike);
        if (sse) { feedStream(chunk); return; }
        chunks.push(chunk);
        if (!headKnown) {
          let head: ParsedHead | null = null;
          // A malformed status line throws: stop sniffing — the buffered
          // path's guarded parse turns it into the usual 502.
          try { head = parseHead(acc()); headKnown = head !== null; }
          catch { headKnown = true; }
          if (head && isEventStream(head.headers["content-type"])) {
            // SSE: resolve at head-time and stream the body. No idle timer
            // (silence is legal between events) and no hard cap (a live
            // stream may outlast 15s); the consumer's return() is the exit.
            done = true; // any stray finish() is now a no-op
            if (idle) clearTimeout(idle);
            clearTimeout(hard);
            sse = {
              queue: byteQueue(closeConn),
              decoder: head.framing === "chunked" ? new ChunkedDecoder() : null,
            };
            const rest = acc().subarray(head.bodyOffset);
            chunks.length = 0;
            resolve({ status: head.status, headers: head.headers, body: new Uint8Array(), stream: sse.queue.iterable });
            if (rest.length > 0) feedStream(rest);
            return;
          }
        }
        // Buffered path — byte-identical to Round 12.
        // responseComplete → parseHeaderLines can throw on a malformed status line
        // inside this emulator callback (no reject path). Treat a throw as "not
        // complete yet" — the idle timer / hard cap + guarded parse finish it.
        let complete = false;
        try { complete = responseComplete(acc()); } catch { complete = false; }
        if (complete) { finish(); return; }
        if (idle) clearTimeout(idle);
        idle = setTimeout(finish, 600); // idle fallback for keep-alive servers with no length info
      });
      // unreliable — a backstop, not the primary condition. In SSE mode the
      // guest FIN is the normal end of an unframed event stream.
      conn.on("close", () => { if (sse) { endStream(); return; } finish(); });
    });
  }
  /** Upgrade a request to a live WebSocket against a real server in the guest
   *  (the contract's OPTIONAL `Runtime.upgrade` — this kernel supports it).
   *  Probe-first like dispatch (a closed/loopback-only port REJECTS with a
   *  precise message — unlike dispatch, upgrade has an error channel), then a
   *  raw guest TCP conn + the RFC6455 client codec (ws-codec.ts): write the
   *  handshake on `connect`, validate the 101 + Sec-WebSocket-Accept, and wrap
   *  the live conn as a WsConnection. The 15s cap bounds the HANDSHAKE only —
   *  an established connection carries NO idle/hard timers (an 11s-idle conn
   *  was spike-proven live; silence is legal on a WebSocket). Teardown: close
   *  handshake (either side), protocol violation (fail-fast 1006), the
   *  unreliable TcpConn "close" backstop, or runtime shutdown — each path also
   *  conn.close()es so the emulator's tcp_conn entry is released. */
  async upgrade(port: number, req: HttpRequest): Promise<WsConnection> {
    const net = this.host.networkAdapter();
    if (!(await net.tcp_probe(port))) {
      throw new Error(`WebSocket upgrade failed: no server listening on port ${port} (or it is bound to 127.0.0.1 only)`);
    }
    const key = makeWsKey();
    const offeredHeader = Object.entries(req.headers).find(([k]) => k.toLowerCase() === "sec-websocket-protocol")?.[1] ?? "";
    const offered = offeredHeader.split(",").map((s) => s.trim()).filter((s) => s !== "");
    const raw = buildUpgradeRequest(req, key);
    const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
    return await new Promise<WsConnection>((resolve, reject) => {
      const conn = net.connect(port);
      const hsBuf: Uint8Array[] = [];
      let ws: GuestWs | null = null; // null while handshaking
      let settled = false;
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(hsTimer);
        try { conn.close(); } catch { /* ignore */ }
        reject(err);
      };
      // Bounds the HANDSHAKE only — cleared the moment the 101 validates.
      const hsTimer = setTimeout(
        () => fail(new Error(`WebSocket upgrade on port ${port} timed out after 15s waiting for the 101 handshake`)),
        15_000,
      );
      conn.on("connect", () => conn.write(raw));
      conn.on("data", (d) => {
        const chunk = d instanceof Uint8Array ? d : new Uint8Array(d as ArrayBufferLike);
        if (ws) { ws.feed(chunk); return; }
        if (settled) return; // late bytes after a handshake failure
        hsBuf.push(chunk);
        const total = hsBuf.reduce((n, c) => n + c.length, 0);
        const acc = new Uint8Array(total);
        let o = 0;
        for (const c of hsBuf) { acc.set(c, o); o += c.length; }
        let head: ParsedHead | null;
        try { head = parseHead(acc); }
        catch (err) { fail(new Error(`WebSocket upgrade failed on port ${port}: malformed handshake response (${msg(err)})`)); return; }
        if (!head) return; // header terminator not in yet — keep accumulating
        let protocol: string;
        try { protocol = validateHandshake(head, key, offered); }
        catch (err) { fail(new Error(`WebSocket upgrade failed on port ${port}: ${msg(err)}`)); return; }
        settled = true;
        clearTimeout(hsTimer);
        const g = new GuestWs(conn, protocol, new WsFrameParser());
        const teardown = (cause: string): void => g.destroy(cause);
        g.onFinished = () => this.wsTeardowns.delete(teardown);
        this.wsTeardowns.add(teardown);
        ws = g;
        resolve(g);
        const rest = acc.subarray(head.bodyOffset);
        if (rest.length > 0) g.feed(rest); // frames coalesced behind the 101
      });
      conn.on("close", () => {
        if (ws) { ws.onTcpClose(); return; }
        fail(new Error(`WebSocket upgrade failed on port ${port}: connection closed before the handshake completed`));
      });
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

/**
 * A live guest WebSocket: wraps the raw TcpConn + ws-codec into the contract's
 * `WsConnection`. Single-subscriber callbacks with pre-subscription buffering
 * (per the contract doc: no frame may be lost between upgrade() resolving and
 * the consumer attaching); pings are auto-answered with pongs; `onClose` fires
 * exactly once. Created only by VmRuntime.upgrade().
 */
class GuestWs implements WsConnection {
  readonly protocol: string;
  /** Bookkeeping hook set by VmRuntime — removes this conn from the shutdown
   *  teardown set once it has finished by any path. */
  onFinished: () => void = () => {};
  private state: "open" | "closing" | "closed" = "open";
  private messageCb: ((data: string | Uint8Array) => void) | null = null;
  private closeCb: ((code: number, reason: string) => void) | null = null;
  private pendingMessages: Array<string | Uint8Array> = [];
  private pendingClose: { code: number; reason: string } | null = null;
  private closeBackstop: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly conn: TcpConn,
    protocol: string,
    private readonly parser: WsFrameParser,
  ) {
    this.protocol = protocol;
  }

  /** Incoming TCP bytes → frames → deliveries. A parser throw is a protocol
   *  violation: fail fast — tear down with 1006 + the precise reason (never
   *  deliver silently-wrong frames). */
  feed(bytes: Uint8Array): void {
    if (this.isClosed()) return;
    let events: ReturnType<WsFrameParser["push"]>;
    try { events = this.parser.push(bytes); }
    catch (err) {
      this.finish(1006, `WebSocket protocol violation: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const ev of events) {
      if (this.isClosed()) return; // a close event may end us mid-batch
      if (ev.type === "text" || ev.type === "binary") this.deliver(ev.data);
      else if (ev.type === "ping") this.write(encodePong(ev.payload));
      else if (ev.type === "close") {
        // Complete the handshake: echo when the guest initiated; when WE
        // initiated (state "closing") this IS the echo we were waiting for.
        if (this.state === "open") this.write(encodeClose(ev.code === 1005 ? undefined : ev.code, ev.reason));
        this.finish(ev.code, ev.reason);
      }
      // "pong": nothing to do — wave 1 never sends pings.
    }
  }

  /** The unreliable TcpConn "close" — a backstop, not the primary teardown.
   *  No Close frame preceded it, so this is abnormal closure (1006), exactly
   *  how a browser reports it. */
  onTcpClose(): void {
    this.finish(1006, "TCP connection closed without a WebSocket Close frame");
  }

  send(data: string | Uint8Array): void {
    if (this.state !== "open") throw new Error(`WsConnection.send: the connection is ${this.state}`);
    this.write(typeof data === "string" ? encodeText(data) : encodeBinary(data));
  }

  onMessage(cb: (data: string | Uint8Array) => void): void {
    this.messageCb = cb;
    const backlog = this.pendingMessages;
    this.pendingMessages = [];
    for (const m of backlog) cb(m);
  }

  onClose(cb: (code: number, reason: string) => void): void {
    this.closeCb = cb;
    if (this.pendingClose !== null) {
      const p = this.pendingClose;
      this.pendingClose = null;
      cb(p.code, p.reason);
    }
  }

  close(code?: number, reason = ""): void {
    if (this.state !== "open") return; // idempotent
    this.state = "closing";
    this.write(encodeClose(code, reason));
    // The guest should echo our Close frame; if it never does — or its FIN is
    // swallowed (TcpConn "close" is unreliable) — don't park forever.
    this.closeBackstop = setTimeout(() => this.finish(code ?? 1005, reason), 5_000);
  }

  /** Runtime-driven teardown (shutdown/kernel switch): abnormal closure with a
   *  truthful cause. */
  destroy(cause: string): void {
    this.finish(1006, cause);
  }

  /** Method (not an inline compare) so a finish() inside feed()'s loop isn't
   *  erased by TS's property-narrowing (the state DOES change mid-loop). */
  private isClosed(): boolean {
    return this.state === "closed";
  }

  private deliver(data: string | Uint8Array): void {
    if (this.messageCb) this.messageCb(data);
    else this.pendingMessages.push(data);
  }

  private write(bytes: Uint8Array): void {
    try { this.conn.write(bytes); } catch { /* conn already gone — a teardown path reports it */ }
  }

  private finish(code: number, reason: string): void {
    if (this.state === "closed") return;
    this.state = "closed";
    if (this.closeBackstop) clearTimeout(this.closeBackstop);
    try { this.conn.close(); } catch { /* ignore */ } // releases the emulator's tcp_conn entry
    this.onFinished();
    if (this.closeCb) this.closeCb(code, reason);
    else this.pendingClose = { code, reason };
  }
}

/** Media-type check for the streaming engage rule: `text/event-stream` ONLY
 *  (parameters like `; charset=utf-8` ignored). Everything else buffers. */
function isEventStream(contentType: string | undefined): boolean {
  return (contentType ?? "").split(";")[0]!.trim().toLowerCase() === "text/event-stream";
}

/** Single-consumer push→pull byte queue backing a streamed SSE body: `push`
 *  buffers, `end` completes, `fail` rejects the pending/next read (fail-fast —
 *  a malformed body must surface, never truncate silently). The consumer side
 *  is the contract's single-use AsyncIterable; its `return()` (client gone)
 *  drops the buffer and fires `onCancel` so the guest conn closes. */
interface ByteQueue {
  push(c: Uint8Array): void;
  end(): void;
  fail(err: Error): void;
  iterable: AsyncIterable<Uint8Array>;
}

function byteQueue(onCancel: () => void): ByteQueue {
  const buf: Uint8Array[] = [];
  let ended = false;
  let error: Error | null = null;
  let wake: (() => void) | null = null;
  const kick = (): void => { const w = wake; wake = null; w?.(); };
  const iterable: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          for (;;) {
            if (error) throw error;
            const c = buf.shift();
            if (c) return { value: c, done: false };
            if (ended) return { value: undefined, done: true };
            await new Promise<void>((r) => { wake = r; });
          }
        },
        async return(): Promise<IteratorResult<Uint8Array>> {
          if (!ended && !error) { ended = true; buf.length = 0; onCancel(); }
          return { value: undefined, done: true };
        },
      };
    },
  };
  return {
    push(c) { if (ended || error) return; buf.push(c); kick(); },
    end() { if (ended || error) return; ended = true; kick(); },
    fail(err) { if (ended || error) return; error = err; kick(); },
    iterable,
  };
}
