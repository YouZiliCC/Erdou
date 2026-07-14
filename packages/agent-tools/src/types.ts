import type { Runtime } from "@erdou/runtime-contract";

export interface ToolContext {
  runtime: Runtime;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

/**
 * A tool the agent can call. Tools operate on the Runtime *contract* only, so
 * the same toolset works against any Runtime implementation. Failures are
 * returned as `{ ok: false, output }` rather than thrown — the agent must be
 * able to observe and react to them.
 */
export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: object;
  execute(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
}
