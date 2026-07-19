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
import type { HttpRequest, HttpResponse, WsConnection } from "./http.js";

/**
 * The frozen boundary every Runtime implementation must satisfy. Upper layers
 * (agent-tools → agent-core → app) depend on this interface, never on a
 * concrete Runtime. A Runtime never depends on anything above it.
 */
export interface Runtime {
  boot(): Promise<void>;
  shutdown(): Promise<void>;

  spawn(options: SpawnOptions): Promise<ProcessHandle>;
  /** Run a shell command line. The handle carries a REAL pid: the command
   *  appears in getProcesses() and can be awaited/killed via wait()/kill(). */
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
  /** Dispatch an HTTP request to whatever handler is serving `port`. A
   *  STREAMED response (see `HttpResponse.stream`) resolves at head-time —
   *  status + headers known, body chunks read by iterating `stream`; a
   *  buffered response resolves complete. The signature is unchanged either
   *  way. */
  dispatch(port: number, req: HttpRequest): Promise<HttpResponse>;
  /** OPTIONAL capability: upgrade an HTTP request to a WebSocket connection
   *  against whatever server listens on `port`. A kernel WITHOUT WebSocket
   *  support OMITS this method entirely — absence IS the fail-fast decline
   *  signal (the browser kernel omits it: it has no WebSocket-capable server
   *  producer, and a speculative surface would be a lie); callers must check
   *  for presence and surface a precise "not supported on this kernel" error.
   *  A kernel WITH support resolves on a COMPLETED 101 handshake and rejects
   *  fail-fast with a precise message when no server listens on `port`, the
   *  server refuses/mangles the upgrade, or the handshake times out. `req`
   *  carries the request line + headers verbatim (subprotocol offers ride in
   *  `sec-websocket-protocol`); `req.body` is ignored. Unlike `dispatch`, this
   *  MAY reject — a failed upgrade has no HttpResponse shape to resolve to. */
  upgrade?(port: number, req: HttpRequest): Promise<WsConnection>;
  /** Stop serving `port`, freeing it for a future serve. Idempotent — closing
   *  a port nothing serves is a no-op. Emits `port.closed` when something was
   *  actually closed (delivery may be asynchronous — see events.ts). */
  closePort(port: number): Promise<void>;

  getCapabilities(): Promise<RuntimeCapabilities>;
  subscribe(listener: RuntimeEventListener): Unsubscribe;
}
