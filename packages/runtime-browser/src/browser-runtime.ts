import type {
  Runtime,
  SpawnOptions,
  ProcessHandle,
  ProcessInfo,
  ExitStatus,
  Signal,
  Stat,
  FileEntry,
  WriteFileOptions,
  MkdirOptions,
  RmOptions,
  RuntimeCapabilities,
  RuntimeEventListener,
  Unsubscribe,
  Snapshot,
  VirtualPort,
  Executor,
  FileSystemApi,
} from "@erdou/runtime-contract";
import { EventBus } from "./core/event-bus.js";
import { PipeStream } from "./core/byte-stream.js";
import { Vfs } from "./vfs/vfs.js";
import { ProcessTable, type ProcessRecord } from "./process/process-table.js";
import type { ProgramRegistry } from "./process/program.js";
import { createBuiltins } from "./builtins/index.js";
import { Shell } from "./shell/interpreter.js";
import { createShellSession, type ShellSession } from "./shell/session.js";
import { PortRegistry } from "./port/registry.js";
import { snapshotVfs, restoreVfs } from "./snapshot/serialize.js";

export interface BrowserRuntimeOptions {
  clock?: () => number;
}

/**
 * The reference browser-native Runtime: a Vfs, a process table backed by an
 * in-process executor, a POSIX-ish shell, snapshots and virtual ports, all
 * wired to a single event bus and exposed through the Runtime contract.
 */
export class BrowserRuntime implements Runtime {
  private readonly clock: () => number;
  private readonly bus = new EventBus();
  private readonly registry: ProgramRegistry = new Map();
  private readonly vfs: Vfs;
  private readonly table: ProcessTable;
  private readonly ports: PortRegistry;

  constructor(options: BrowserRuntimeOptions = {}) {
    this.clock = options.clock ?? (() => Date.now());
    this.vfs = new Vfs({ clock: this.clock, onEvent: (e) => this.bus.emit(e) });
    this.table = new ProcessTable({
      vfs: this.vfs,
      bus: this.bus,
      registry: this.registry,
      clock: this.clock,
    });
    createBuiltins({
      registry: this.registry,
      listProcesses: () => this.table.list(),
      killProcess: (pid, signal) => this.table.kill(pid, signal),
    });
    this.ports = new PortRegistry(this.bus);
  }

  async boot(): Promise<void> {}

  async shutdown(): Promise<void> {
    for (const p of this.table.list()) {
      if (p.state === "running") this.table.kill(p.pid, "SIGKILL");
    }
  }

  async spawn(options: SpawnOptions): Promise<ProcessHandle> {
    return this.toHandle(this.table.spawn({ ...options }));
  }

  async exec(
    commandLine: string,
    options?: Omit<SpawnOptions, "cmd" | "args">,
  ): Promise<ProcessHandle> {
    // A fresh, isolated shell per call: cwd/env never leak between exec calls.
    const shell = new Shell({
      table: this.table,
      vfs: this.vfs,
      cwd: options?.cwd ?? "/",
      env: options?.env ? { ...options.env } : {},
    });
    const result = shell.execute(commandLine);
    const stdin = new PipeStream();
    stdin.end();
    return {
      pid: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      stdin,
      wait: async (): Promise<ExitStatus> => ({ code: await result.wait(), signal: null }),
      kill: async (signal?: Signal) => result.kill(signal),
    };
  }

  /** Open a persistent interactive shell whose cwd/env survive across commands. */
  openShell(opts?: { cwd?: string; env?: Record<string, string> }): ShellSession {
    return createShellSession({ table: this.table, vfs: this.vfs, cwd: opts?.cwd, env: opts?.env });
  }

  async kill(pid: number, signal?: Signal): Promise<void> {
    this.table.kill(pid, signal);
  }

  async wait(pid: number): Promise<ExitStatus> {
    return this.table.wait(pid);
  }

  async getProcesses(): Promise<ProcessInfo[]> {
    return this.table.list();
  }

  /**
   * Register a program / language runtime under a command name (e.g. "python",
   * "ruby", "wasi"). Once registered, the shell, `exec` and the agent can run
   * it like any built-in — the extension point for new languages.
   */
  registerProgram(name: string, executor: Executor): void {
    this.table.register(name, executor);
  }

  /** The runtime's synchronous filesystem — for in-process tools like the bundler. */
  get fs(): FileSystemApi {
    return this.vfs;
  }

  async readFile(path: string): Promise<Uint8Array> {
    return this.vfs.readFile(path);
  }

  async writeFile(path: string, data: Uint8Array | string, options?: WriteFileOptions): Promise<void> {
    this.vfs.writeFile(path, data, options);
  }

  async readdir(path: string): Promise<FileEntry[]> {
    return this.vfs.readdir(path);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    this.vfs.mkdir(path, options);
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    this.vfs.rm(path, options);
  }

  async rename(from: string, to: string): Promise<void> {
    this.vfs.rename(from, to);
  }

  async stat(path: string): Promise<Stat> {
    return this.vfs.stat(path);
  }

  async createSnapshot(): Promise<Snapshot> {
    return snapshotVfs(this.vfs, this.clock());
  }

  async restoreSnapshot(snapshot: Snapshot): Promise<void> {
    restoreVfs(this.vfs, snapshot, this.clock());
  }

  async listen(port: number): Promise<VirtualPort> {
    return this.ports.listen(port);
  }

  async exposePort(port: number): Promise<string> {
    return this.ports.exposePort(port);
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      nativeProcesses: true,
      virtualPorts: true,
      persistentStorage: true,
      network: true,
      threads: false,
      nativeAddons: false,
    };
  }

  subscribe(listener: RuntimeEventListener): Unsubscribe {
    return this.bus.subscribe(listener);
  }

  private toHandle(record: ProcessRecord): ProcessHandle {
    return {
      pid: record.pid,
      stdout: record.stdout,
      stderr: record.stderr,
      stdin: record.stdin,
      wait: () => record.wait(),
      kill: async (signal?: Signal) => record.kill(signal),
    };
  }
}
