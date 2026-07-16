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
import { PortRegistry } from "./port-registry.js";
import { snapshotWorkspace, restoreWorkspace } from "./workspace-snapshot.js";
import { vmCapabilities } from "./capabilities.js";
import { openPtySession, type PtySession } from "./pty.js";
import { SyncFs9pFs } from "./sync-fs.js";

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
  private ports!: PortRegistry;
  private readonly listeners = new Set<RuntimeEventListener>();
  // Retained per pid — kept AFTER exit (unlike guestd.ps(), which only lists
  // live /proc) so wait()/kill()/getProcesses() honor the contract for an
  // already-exited process. BrowserRuntime's process table never deletes
  // records either; VmRuntime must match.
  private readonly procs = new Map<number, ProcRecord>();
  private readonly clock: () => number;
  private readonly bootTimeoutMs: number | undefined;
  private booted = false;
  private readonly ptyPorts = new Set<number>();

  constructor(
    private readonly loadInputs: () => Promise<import("./v86-host.js").V86BootInputs>,
    opts: { clock?: () => number; bootTimeoutMs?: number } = {},
  ) {
    this.host = new V86Host();
    this.clock = opts.clock ?? (() => Date.now());
    this.bootTimeoutMs = opts.bootTimeoutMs;
  }

  private emit(e: RuntimeEvent): void { for (const l of this.listeners) { try { l(e); } catch (err) { console.error("VmRuntime listener threw:", err); } } }

  async boot(): Promise<void> {
    if (this.booted) return;
    const inputs = await this.loadInputs();
    await this.host.boot(inputs, this.bootTimeoutMs ? { bootTimeoutMs: this.bootTimeoutMs } : {});
    this.ports = new PortRegistry((e) => this.emit(e));
    this.bridge = new Fs9pBridge(this.host.fs9p, (e) => this.emit(e));
    this.bridge.attach();          // wraps fs9p + builds the workspace path index from the restored state
    this.host.run();               // resume the CPU from the baked state (guestd is already resident)
    this.guestd = new GuestdClient(this.host.channel());
    await this.guestd.ready({ deadlineMs: this.bootTimeoutMs ?? 60_000 });      // first hvc0 frame is the kick; guestd replies READY
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
   *  CreateDirectory, and Unlink — both observe the same fs9p mutation) — harmless,
   *  deduped by consumers (the app's file.changed handler keys by path). After boot(). */
  syncFs(): SyncFs9pFs {
    if (!this.booted) throw new Error("VmRuntime.syncFs(): not booted");
    return new SyncFs9pFs(this.host.fs9p, (e) => this.emit(e));
  }

  // ---- snapshot (workspace-scoped) ----
  async createSnapshot(): Promise<Snapshot> { this.bridge.flush(); return snapshotWorkspace(this.host.fs9p, this.clock); }
  async restoreSnapshot(s: Snapshot): Promise<void> { await restoreWorkspace(this.host.fs9p, this.bridge, s); }

  // ---- ports (in-VM for 11a; real guest proxy is Round 12) ----
  async listen(port: number): Promise<VirtualPort> {
    const reg = this.ports; reg.serve(port, () => ({ status: 502, headers: {}, body: new Uint8Array() }));
    return { port, close: async () => reg.close(port) };
  }
  async exposePort(port: number): Promise<string> { return this.ports.exposePort(port); }
  async dispatch(port: number, req: HttpRequest): Promise<HttpResponse> { return this.ports.dispatch(port, req); }
  async closePort(port: number): Promise<void> { this.ports.close(port); }

  async getCapabilities(): Promise<RuntimeCapabilities> { return vmCapabilities(["python3"]); }
  subscribe(l: RuntimeEventListener): Unsubscribe { this.listeners.add(l); return () => this.listeners.delete(l); }
}
