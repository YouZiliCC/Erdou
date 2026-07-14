export interface ModelConfig {
  provider: "openai-compatible" | "anthropic";
  /** Base URL, e.g. "https://api.openai.com/v1" or "https://api.anthropic.com". */
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  content: string;
}
