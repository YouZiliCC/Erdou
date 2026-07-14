import type { ChatMessage, ChatResult, ModelConfig } from "./types.js";
import { parseSSE } from "./sse.js";

function endpoint(config: ModelConfig): string {
  return `${config.baseUrl}/chat/completions`;
}

function headers(config: ModelConfig): Record<string, string> {
  return { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` };
}

export async function openaiChat(
  config: ModelConfig,
  messages: ChatMessage[],
  fetchFn: typeof fetch,
): Promise<ChatResult> {
  const res = await fetchFn(endpoint(config), {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ model: config.model, messages }),
  });
  if (!res.ok) {
    throw new Error(`openai-compatible chat failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error(`openai-compatible chat: unexpected response shape: ${JSON.stringify(json)}`);
  }
  return { content };
}

export async function* openaiStream(
  config: ModelConfig,
  messages: ChatMessage[],
  fetchFn: typeof fetch,
): AsyncGenerator<string> {
  const res = await fetchFn(endpoint(config), {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ model: config.model, messages, stream: true }),
  });
  if (!res.ok) {
    throw new Error(`openai-compatible stream failed: ${res.status} ${await res.text()}`);
  }
  if (!res.body) throw new Error("openai-compatible stream: response has no body");
  for await (const payload of parseSSE(res.body)) {
    if (payload === "[DONE]") return;
    const json = JSON.parse(payload) as { choices?: { delta?: { content?: unknown } }[] };
    const delta = json.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta.length > 0) yield delta;
  }
}
