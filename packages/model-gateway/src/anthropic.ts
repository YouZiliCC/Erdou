import type { ChatMessage, ChatResult, ChatOptions, ModelConfig, ToolCall } from "./types.js";
import { parseSSE } from "./sse.js";

const VERSION = "2023-06-01";
// Anthropic requires max_tokens; sized so tool calls that write whole files
// don't truncate mid-JSON (truncation is detected and thrown — see stop_reason).
const MAX_TOKENS = 16000;

/**
 * Build the /v1/messages endpoint from the configured base URL. Accepts both a
 * bare host ("https://api.anthropic.com") and bases that already end in "/v1"
 * (e.g. the dev-server proxy "/llm/v1") without doubling the version segment.
 */
function endpoint(config: ModelConfig): string {
  const base = config.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${base}/v1/messages`;
}

function headers(config: ModelConfig): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-api-key": config.apiKey,
    "anthropic-version": VERSION,
    // Required opt-in for browser-origin requests — without it Anthropic's API
    // rejects the CORS preflight and the app sees a bare "Failed to fetch".
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

interface WireTextBlock {
  type: "text";
  text: string;
}
interface WireToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
interface WireToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}
type WireBlock = WireTextBlock | WireToolUseBlock | WireToolResultBlock;

interface WireMessage {
  role: "user" | "assistant";
  content: string | WireBlock[];
}

/**
 * An assistant tool-use turn echoed back verbatim from a captured response
 * (`ToolCall.rawContent`). The blocks are provider-opaque JSON — they include
 * `thinking` blocks (with their signatures), which Anthropic requires to be
 * returned UNCHANGED when continuing a tool-use turn on the same model.
 * Thinking is on by default on e.g. claude-sonnet-5 / claude-fable-5, and
 * `thinking: {type: "disabled"}` is rejected on claude-fable-5, so echoing is
 * the one correct path — reconstructing the turn from content + toolCalls
 * would drop the thinking blocks and the API would reject the request.
 */
interface WireEchoedMessage {
  role: "assistant";
  content: unknown[];
}

/** Parse a gateway ToolCall's JSON-string arguments into the object Anthropic expects. */
function parseArguments(call: ToolCall): unknown {
  if (call.arguments.trim().length === 0) return {};
  try {
    return JSON.parse(call.arguments);
  } catch {
    throw new Error(
      `anthropic chat: tool call "${call.name}" (${call.id}) has non-JSON arguments: ${call.arguments}`,
    );
  }
}

/**
 * Map gateway messages onto the Anthropic Messages shape: system messages are
 * hoisted into the top-level `system` string; assistant toolCalls become
 * tool_use content blocks; role:"tool" results become tool_result blocks, with
 * consecutive results grouped into a single user turn (parallel tool results
 * must share one message).
 */
function split(messages: ChatMessage[]): {
  system: string | undefined;
  turns: (WireMessage | WireEchoedMessage)[];
} {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
  const turns: (WireMessage | WireEchoedMessage)[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      if (m.toolCallId === undefined) {
        throw new Error(`anthropic chat: role:"tool" message has no toolCallId: ${m.content}`);
      }
      const block: WireToolResultBlock = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
      const prev = turns[turns.length - 1];
      if (prev !== undefined && prev.role === "user" && Array.isArray(prev.content)) {
        prev.content.push(block);
      } else {
        turns.push({ role: "user", content: [block] });
      }
      continue;
    }
    if (m.role === "assistant" && m.toolCalls !== undefined && m.toolCalls.length > 0) {
      // A turn captured from a live Anthropic response is echoed back verbatim
      // so its thinking blocks survive (see WireEchoedMessage). Turns without a
      // capture (hand-seeded transcripts, runs persisted before this field
      // existed, or tool-use turns produced by the OpenAI-compatible provider
      // before a mid-thread provider switch) are reconstructed from
      // content + toolCalls as before.
      const raw = m.toolCalls[0]?.rawContent;
      if (Array.isArray(raw) && raw.length > 0) {
        turns.push({ role: "assistant", content: raw });
        continue;
      }
      const blocks: WireBlock[] = [];
      if (m.content.length > 0) blocks.push({ type: "text", text: m.content });
      for (const call of m.toolCalls) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: parseArguments(call) });
      }
      turns.push({ role: "assistant", content: blocks });
      continue;
    }
    turns.push({ role: m.role, content: m.content });
  }
  return { system: system.length > 0 ? system : undefined, turns };
}

function buildBody(
  config: ModelConfig,
  messages: ChatMessage[],
  options?: ChatOptions,
): Record<string, unknown> {
  const { system, turns } = split(messages);
  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: MAX_TOKENS,
    system,
    messages: turns,
  };
  if (options?.tools && options.tools.length > 0) {
    body.tools = options.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }
  return body;
}

interface WireResponseBlock {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
}

export async function anthropicChat(
  config: ModelConfig,
  messages: ChatMessage[],
  fetchFn: typeof fetch,
  options?: ChatOptions,
): Promise<ChatResult> {
  const res = await fetchFn(endpoint(config), {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify(buildBody(config, messages, options)),
    signal: options?.signal,
  });
  if (!res.ok) {
    throw new Error(`anthropic chat failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { content?: unknown; stop_reason?: unknown };
  if (!Array.isArray(json.content)) {
    throw new Error(`anthropic chat: unexpected response shape: ${JSON.stringify(json)}`);
  }
  let content = "";
  const toolCalls: ToolCall[] = [];
  for (const block of json.content as WireResponseBlock[]) {
    if (block.type === "text" && typeof block.text === "string") {
      content += block.text;
    } else if (block.type === "tool_use") {
      if (typeof block.id !== "string" || typeof block.name !== "string") {
        throw new Error(`anthropic chat: malformed tool_use block: ${JSON.stringify(block)}`);
      }
      toolCalls.push({ id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
    }
  }
  // The agent loop treats "no tool calls" as task-complete, so a truncated or
  // refused turn must fail loudly instead of masquerading as a finished answer.
  if (json.stop_reason === "max_tokens") {
    throw new Error(
      `anthropic chat: response truncated by max_tokens=${MAX_TOKENS} (stop_reason "max_tokens"); ` +
        `partial content: ${content.slice(0, 200)}`,
    );
  }
  if (json.stop_reason === "refusal") {
    throw new Error('anthropic chat: the model refused this request (stop_reason "refusal")');
  }
  // Capture the response content verbatim on tool-use turns so the follow-up
  // request can echo it unchanged. On thinking-default models (claude-sonnet-5,
  // claude-fable-5) the array carries thinking blocks that MUST be returned
  // unmodified when the turn is continued — see ToolCall.rawContent.
  if (toolCalls.length > 0) {
    toolCalls[0]!.rawContent = json.content as unknown[];
  }
  return { content, toolCalls };
}

export async function* anthropicStream(
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
    throw new Error(`anthropic stream failed: ${res.status} ${await res.text()}`);
  }
  if (!res.body) throw new Error("anthropic stream: response has no body");
  for await (const payload of parseSSE(res.body)) {
    const json = JSON.parse(payload) as {
      type?: string;
      delta?: { type?: string; text?: unknown; stop_reason?: unknown };
    };
    if (json.type === "content_block_delta" && json.delta?.type === "text_delta") {
      if (typeof json.delta.text === "string") yield json.delta.text;
    } else if (
      json.type === "message_delta" &&
      (json.delta?.stop_reason === "max_tokens" || json.delta?.stop_reason === "refusal")
    ) {
      throw new Error(`anthropic stream: model stopped with stop_reason "${String(json.delta.stop_reason)}"`);
    }
  }
}
