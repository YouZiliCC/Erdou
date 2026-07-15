/**
 * Generic runtime events. These carry facts about the execution environment
 * only — never agent-business meaning. The Runtime reports "process 4 exited
 * with code 1"; deciding what that means is the Agent layer's job.
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
