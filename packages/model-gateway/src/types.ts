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
  /**
   * Provider-opaque raw content blocks of the assistant turn that produced
   * this call, set by the Anthropic path on the FIRST call of each turn.
   * Anthropic requires `thinking` blocks to be echoed back unchanged when a
   * tool-use turn is continued on the same model (thinking is on by default
   * on e.g. claude-sonnet-5 / claude-fable-5, and there is no universally
   * accepted way to disable it), so the whole turn is captured verbatim here
   * and re-sent as-is. It rides on the ToolCall because callers rebuild the
   * assistant history message from `content` + `toolCalls` — the ToolCall
   * objects (and their JSON persistence) pass through untouched, so the turn
   * survives both the in-memory agent loop and a persisted-transcript reload.
   * Plain JSON — safe to structured-clone/serialize. Ignored by the
   * OpenAI-compatible path.
   */
  rawContent?: unknown[];
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
  /** Aborts the in-flight HTTP request (e.g. the user pressed Stop mid-call);
   *  without it a stop only takes effect after the response arrives. */
  signal?: AbortSignal;
}
