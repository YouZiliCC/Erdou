import type { Runtime } from "@erdou/runtime-contract";
import type { ModelGateway, ModelConfig, ChatMessage } from "@erdou/model-gateway";
import type { ToolDef } from "@erdou/agent-tools";

export type AgentEvent =
  | { type: "step"; step: number }
  | { type: "assistant"; content: string }
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; ok: boolean; output: string }
  | { type: "done"; reason: "done" | "max_steps"; summary: string };

export interface AgentOptions {
  runtime: Runtime;
  gateway: ModelGateway;
  model: ModelConfig;
  /** Defaults to createTools(). */
  tools?: ToolDef[];
  /** Max model turns before stopping. Default 20. */
  maxSteps?: number;
  /** Overrides the default system prompt. */
  systemPrompt?: string;
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentRunResult {
  steps: number;
  finalMessage: string;
  stoppedReason: "done" | "max_steps";
  transcript: ChatMessage[];
}
