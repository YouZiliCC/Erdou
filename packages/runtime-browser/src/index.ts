export { BrowserRuntime, type BrowserRuntimeOptions } from "./browser-runtime.js";

// Kernel building blocks (for advanced consumers / alternative compositions).
export { Vfs, type VfsOptions } from "./vfs/vfs.js";
export { EventBus } from "./core/event-bus.js";
export { PipeStream } from "./core/byte-stream.js";
export { ProcessTable, type ProcessRecord, type InternalSpawnOptions } from "./process/process-table.js";
export type { Program, ProgramRegistry, ProcessContext } from "./process/program.js";
export { createBuiltins, type BuiltinDeps } from "./builtins/index.js";
export { Shell, type ShellResult, type ShellDeps } from "./shell/interpreter.js";
export { createShellSession, type ShellSession } from "./shell/session.js";
export { PortRegistry } from "./port/registry.js";
export { NetworkManager, type NetworkOptions } from "./net/network.js";
export { snapshotVfs, restoreVfs } from "./snapshot/serialize.js";
export { MemorySnapshotStore } from "./snapshot/memory-store.js";
export { IndexedDbSnapshotStore } from "./snapshot/indexeddb-store.js";
