import type {
  Runtime, SpawnOptions, ProcessHandle, ProcessInfo, ExitStatus, Signal,
  Stat, FileEntry, WriteFileOptions, MkdirOptions, RmOptions,
  RuntimeCapabilities, RuntimeEventListener, Unsubscribe, Snapshot,
  VirtualPort, HttpRequest, HttpResponse,
} from "@erdou/runtime-contract";
import { vmCapabilities } from "./capabilities.js";

const notBooted = (): never => {
  throw new Error("VmRuntime: not booted — call boot() first (full implementation lands in Task 9)");
};

/** A Runtime backed by a v86 + Alpine guest. Stub in Task 2; composed in Task 9. */
export class VmRuntime implements Runtime {
  async boot(): Promise<void> { notBooted(); }
  async shutdown(): Promise<void> {}
  async spawn(_o: SpawnOptions): Promise<ProcessHandle> { return notBooted(); }
  async exec(_c: string, _o?: Omit<SpawnOptions, "cmd" | "args">): Promise<ProcessHandle> { return notBooted(); }
  async kill(_p: number, _s?: Signal): Promise<void> { notBooted(); }
  async wait(_p: number): Promise<ExitStatus> { return notBooted(); }
  async getProcesses(): Promise<ProcessInfo[]> { return notBooted(); }
  async readFile(_p: string): Promise<Uint8Array> { return notBooted(); }
  async writeFile(_p: string, _d: Uint8Array | string, _o?: WriteFileOptions): Promise<void> { notBooted(); }
  async readdir(_p: string): Promise<FileEntry[]> { return notBooted(); }
  async mkdir(_p: string, _o?: MkdirOptions): Promise<void> { notBooted(); }
  async rm(_p: string, _o?: RmOptions): Promise<void> { notBooted(); }
  async rename(_f: string, _t: string): Promise<void> { notBooted(); }
  async stat(_p: string): Promise<Stat> { return notBooted(); }
  async createSnapshot(): Promise<Snapshot> { return notBooted(); }
  async restoreSnapshot(_s: Snapshot): Promise<void> { notBooted(); }
  async listen(_p: number): Promise<VirtualPort> { return notBooted(); }
  async exposePort(_p: number): Promise<string> { return notBooted(); }
  async dispatch(_p: number, _r: HttpRequest): Promise<HttpResponse> { return notBooted(); }
  async closePort(_p: number): Promise<void> { notBooted(); }
  async getCapabilities(): Promise<RuntimeCapabilities> { return vmCapabilities(["python3"]); }
  subscribe(_l: RuntimeEventListener): Unsubscribe { return () => {}; }
}
