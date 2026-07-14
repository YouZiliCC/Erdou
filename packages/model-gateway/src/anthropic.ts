import type { ChatMessage, ChatResult, ModelConfig } from "./types.js";
import { parseSSE } from "./sse.js";

const VERSION = "2023-06-01";

function endpoint(config: ModelConfig): string {
  return `${config.baseUrl}/v1/messages`;
}

function headers(config: ModelConfig): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-api-key": config.apiKey,
    "anthropic-version": VERSION,
  };
}

function split(messages: ChatMessage[]): {
  system: string | undefined;
  turns: { role: "user" | "assistant"; content: string }[];
} {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
  const turns = messages
    .filter((m): m is ChatMessage & { role: "user" | "assistant" } => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));
  return { system: system.length > 0 ? system : undefined, turns };
}

export async function anthropicChat(
  config: ModelConfig,
  messages: ChatMessage[],
  fetchFn: typeof fetch,
): Promise<ChatResult> {
  const { system, turns } = split(messages);
  const res = await fetchFn(endpoint(config), {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ model: config.model, max_tokens: 4096, system, messages: turns }),
  });
  if (!res.ok) {
    throw new Error(`anthropic chat failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { content?: { text?: unknown }[] };
  const content = json.content?.[0]?.text;
  if (typeof content !== "string") {
    throw new Error(`anthropic chat: unexpected response shape: ${JSON.stringify(json)}`);
  }
  // Anthropic tool calling is deferred; openai-compatible is the tool path.
  return { content, toolCalls: [] };
}

export async function* anthropicStream(
  config: ModelConfig,
  messages: ChatMessage[],
  fetchFn: typeof fetch,
): AsyncGenerator<string> {
  const { system, turns } = split(messages);
  const res = await fetchFn(endpoint(config), {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ model: config.model, max_tokens: 4096, system, messages: turns, stream: true }),
  });
  if (!res.ok) {
    throw new Error(`anthropic stream failed: ${res.status} ${await res.text()}`);
  }
  if (!res.body) throw new Error("anthropic stream: response has no body");
  for await (const payload of parseSSE(res.body)) {
    const json = JSON.parse(payload) as { type?: string; delta?: { type?: string; text?: unknown } };
    if (json.type === "content_block_delta" && json.delta?.type === "text_delta") {
      if (typeof json.delta.text === "string") yield json.delta.text;
    }
  }
}
