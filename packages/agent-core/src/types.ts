import type { Runtime } from "@erdou/runtime-contract";
import type { ModelGateway, ModelConfig, ChatMessage } from "@erdou/model-gateway";
import type { ToolDef } from "@erdou/agent-tools";

export type AgentEvent =
  | { type: "step"; step: number }
  | { type: "assistant"; content: string }
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; ok: boolean; output: string }
  | { type: "done"; reason: "done" | "max_steps"; summary: string };

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

export interface AgentOptions {
  runtime: Runtime;
  gateway: ModelGateway;
  model: ModelConfig;
  /** Defaults to createTools(). */
  tools?: ToolDef[];
  /** Max model turns before stopping. Default 20. */
  maxSteps?: number;
  /** Overrides the generated system prompt entirely. */
  systemPrompt?: string;
  /** Specifics for the generated environment brief. */
  environment?: EnvironmentInfo;
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentRunResult {
  steps: number;
  finalMessage: string;
  stoppedReason: "done" | "max_steps";
  transcript: ChatMessage[];
}
