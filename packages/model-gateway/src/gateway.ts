import type { ChatMessage, ChatResult, ModelConfig } from "./types.js";
import { openaiChat, openaiStream } from "./openai.js";
import { anthropicChat, anthropicStream } from "./anthropic.js";

export interface ModelGatewayDeps {
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

/**
 * A thin BYO-key connector to OpenAI-compatible and Anthropic chat endpoints.
 * Config (base URL, key, model) is always passed in per call — never read from
 * a bundled secret. Non-2xx responses fail loudly with the status and body.
 */
export class ModelGateway {
  private readonly fetchFn: typeof fetch;

  constructor(deps: ModelGatewayDeps = {}) {
    this.fetchFn = deps.fetch ?? fetch;
  }

  chat(config: ModelConfig, messages: ChatMessage[]): Promise<ChatResult> {
    return config.provider === "anthropic"
      ? anthropicChat(config, messages, this.fetchFn)
      : openaiChat(config, messages, this.fetchFn);
  }

  chatStream(config: ModelConfig, messages: ChatMessage[]): AsyncGenerator<string> {
    return config.provider === "anthropic"
      ? anthropicStream(config, messages, this.fetchFn)
      : openaiStream(config, messages, this.fetchFn);
  }
}
