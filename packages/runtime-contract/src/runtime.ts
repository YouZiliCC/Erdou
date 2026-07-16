import type {
  Stat,
  FileEntry,
  WriteFileOptions,
  MkdirOptions,
  RmOptions,
} from "./fs.js";
import type {
  SpawnOptions,
  ProcessHandle,
  ProcessInfo,
  ExitStatus,
  Signal,
} from "./process.js";
import type { RuntimeEventListener, Unsubscribe } from "./events.js";
import type { RuntimeCapabilities } from "./capabilities.js";
import type { Snapshot } from "./snapshot.js";
import type { VirtualPort } from "./port.js";
import type { HttpRequest, HttpResponse } from "./http.js";

/**
 * The frozen boundary every Runtime implementation must satisfy. Upper layers
 * (agent-tools → agent-core → app) depend on this interface, never on a
 * concrete Runtime. A Runtime never depends on anything above it.
 */
export interface Runtime {
  boot(): Promise<void>;
  shutdown(): Promise<void>;

  spawn(options: SpawnOptions): Promise<ProcessHandle>;
  exec(
    commandLine: string,
    options?: Omit<SpawnOptions, "cmd" | "args">,
  ): Promise<ProcessHandle>;
  kill(pid: number, signal?: Signal): Promise<void>;
  wait(pid: number): Promise<ExitStatus>;
  getProcesses(): Promise<ProcessInfo[]>;

  readFile(path: string): Promise<Uint8Array>;
  writeFile(
    path: string,
    data: Uint8Array | string,
    options?: WriteFileOptions,
  ): Promise<void>;
  readdir(path: string): Promise<FileEntry[]>;
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  rm(path: string, options?: RmOptions): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  stat(path: string): Promise<Stat>;

  createSnapshot(): Promise<Snapshot>;
  restoreSnapshot(snapshot: Snapshot): Promise<void>;

  listen(port: number): Promise<VirtualPort>;
  exposePort(port: number): Promise<string>;
  /** Dispatch an HTTP request to whatever handler is serving `port`. */
  dispatch(port: number, req: HttpRequest): Promise<HttpResponse>;
  /** Stop serving `port`, freeing it for a future serve. Idempotent — closing
   *  a port nothing serves is a no-op. Emits `port.closed` when something was
   *  actually closed (delivery may be asynchronous — see events.ts). */
  closePort(port: number): Promise<void>;

  getCapabilities(): Promise<RuntimeCapabilities>;
  subscribe(listener: RuntimeEventListener): Unsubscribe;
}
