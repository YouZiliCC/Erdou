import type { ChatMessage, ChatResult, ChatOptions, ModelConfig, ToolCall } from "./types.js";
import { parseSSE } from "./sse.js";

function endpoint(config: ModelConfig): string {
  return `${config.baseUrl}/chat/completions`;
}

function headers(config: ModelConfig): Record<string, string> {
  return { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` };
}

interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Serialize our ChatMessage into the OpenAI wire shape. */
function toWireMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  }
  if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: m.content === "" ? null : m.content,
      tool_calls: m.toolCalls.map(
        (tc): WireToolCall => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        }),
      ),
    };
  }
  return { role: m.role, content: m.content };
}

function buildBody(config: ModelConfig, messages: ChatMessage[], options?: ChatOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: messages.map(toWireMessage),
  };
  if (options?.tools && options.tools.length > 0) {
    body.tools = options.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  return body;
}

export async function openaiChat(
  config: ModelConfig,
  messages: ChatMessage[],
  fetchFn: typeof fetch,
  options?: ChatOptions,
): Promise<ChatResult> {
  const res = await fetchFn(endpoint(config), {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify(buildBody(config, messages, options)),
  });
  if (!res.ok) {
    throw new Error(`openai-compatible chat failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: unknown; tool_calls?: WireToolCall[] } }[];
  };
  const message = json.choices?.[0]?.message;
  if (message === undefined) {
    throw new Error(`openai-compatible chat: unexpected response shape: ${JSON.stringify(json)}`);
  }
  const content = typeof message.content === "string" ? message.content : "";
  const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: tc.function.arguments,
  }));
  return { content, toolCalls };
}

export async function* openaiStream(
  config: ModelConfig,
  messages: ChatMessage[],
  fetchFn: typeof fetch,
): AsyncGenerator<string> {
  const res = await fetchFn(endpoint(config), {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ ...buildBody(config, messages), stream: true }),
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
