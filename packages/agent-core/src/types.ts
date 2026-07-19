import type { Runtime } from "@erdou/runtime-contract";
import type { ModelGateway, ModelConfig, ChatMessage } from "@erdou/model-gateway";
import type { ToolDef } from "@erdou/agent-tools";

export type AgentEvent =
  | { type: "step"; step: number }
  | { type: "assistant"; content: string }
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; ok: boolean; output: string }
  | { type: "done"; reason: "done" | "max_steps" | "aborted"; summary: string };

/**
 * What the agent is told about its environment, so it plans against reality
 * (a simulated browser OS) instead of assuming a full Linux box. The base
 * facts are generated from the runtime's capabilities; this fills in the
 * specifics the caller knows (which language runtimes were registered, etc.).
 */
export interface EnvironmentInfo {
  /** Language runtimes registered on the runtime, e.g. ["python", "wasi"]. */
  languages?: string[];
  /** Extra shell commands beyond the built-ins, e.g. ["git"]. */
  commands?: string[];
  /** Free-form notes appended to the environment brief. */
  notes?: string;
}

export interface ApprovalRequest {
  tool: string;
  /** The shell command line, when tool === "run_shell". */
  command?: string;
  args: Record<string, unknown>;
}
export type ApprovalDecision = "allow" | "deny";

export interface AgentOptions {
  runtime: Runtime;
  gateway: ModelGateway;
  model: ModelConfig;
  /** Defaults to createTools(). */
  tools?: ToolDef[];
  /** Appended after the built-ins (or after `tools` when given), e.g. app-bound tools like switch_environment. */
  extraTools?: ToolDef[];
  /** Max model turns before stopping. Default 20. */
  maxSteps?: number;
  /** Overrides the generated system prompt entirely. */
  systemPrompt?: string;
  /** Specifics for the generated environment brief. */
  environment?: EnvironmentInfo;
  onEvent?: (event: AgentEvent) => void;
  /** When set, gated tools (run_shell, remove_path, switch_environment, open_preview, delegate)
   *  must be approved before running. The delegate gate covers the whole batch: its sub-agents
   *  run unapproved inside their isolated sandboxes and only the approved call merges diffs back. */
  approve?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /** Cancels the run: checked at the top of each step (before the next model
   *  call) and before each tool execution. On abort the loop exits cleanly
   *  with `stoppedReason: "aborted"` — not an error. */
  signal?: AbortSignal;
}

export interface AgentRunResult {
  steps: number;
  finalMessage: string;
  /** "aborted" = the caller's AbortSignal fired (user stop), distinguishable from a real failure (which throws). */
  stoppedReason: "done" | "max_steps" | "aborted";
  transcript: ChatMessage[];
}
