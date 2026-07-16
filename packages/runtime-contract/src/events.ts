/**
 * Generic runtime events. These carry facts about the execution environment
 * only — never agent-business meaning. The Runtime reports "process 4 exited
 * with code 1"; deciding what that means is the Agent layer's job.
 *
 * Delivery timing is NOT guaranteed to be synchronous with the operation that
 * caused an event: a runtime may deliver on a later tick (e.g. a VM-backed
 * runtime forwarding guest activity). The bound: events caused by a runtime
 * API call are delivered no later than ONE MACROTASK after that call's
 * promise resolves — an implementation that forwards events asynchronously
 * must flush them before or within one macrotask of responding. Consumers
 * that need a barrier: await the call, then one macrotask (setTimeout 0).
 */
export type RuntimeEvent =
  | { type: "process.started"; pid: number; cmd: string }
  | { type: "process.stdout"; pid: number; data: Uint8Array }
  | { type: "process.stderr"; pid: number; data: Uint8Array }
  | { type: "process.exited"; pid: number; code: number; signal: string | null }
  | { type: "file.changed"; path: string; kind: "create" | "modify" | "delete" }
  | { type: "port.opened"; port: number; url: string }
  | { type: "port.closed"; port: number }
  | { type: "resource.warning"; resource: string; detail: string };

export type RuntimeEventListener = (event: RuntimeEvent) => void;

export interface Unsubscribe {
  (): void;
}
