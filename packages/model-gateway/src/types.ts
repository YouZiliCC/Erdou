export interface ModelConfig {
  provider: "openai-compatible" | "anthropic";
  /** Base URL, e.g. "https://api.openai.com/v1" or "https://api.anthropic.com". */
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** A tool the model may call (OpenAI-compatible function-calling shape). */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: object;
}

/** A tool call the model requested. `arguments` is a JSON string. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Present on assistant messages that requested tool calls. */
  toolCalls?: ToolCall[];
  /** Present on role:"tool" messages — which call this result answers. */
  toolCallId?: string;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
}

export interface ChatOptions {
  tools?: ToolSpec[];
}
