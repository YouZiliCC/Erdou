import { describe, it, expect } from "vitest";
import { anthropicChat, anthropicStream } from "./anthropic.js";
import type { ChatMessage, ModelConfig, ToolSpec } from "./types.js";

interface Captured {
  url: string;
  init: RequestInit;
}

function jsonFetch(status: number, body: unknown): { fetch: typeof globalThis.fetch; captured: Captured[] } {
  const captured: Captured[] = [];
  const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { fetch: impl, captured };
}

function sseFetch(chunks: string[]): { fetch: typeof globalThis.fetch; captured: Captured[] } {
  const captured: Captured[] = [];
  const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetch: impl, captured };
}

function config(baseUrl: string): ModelConfig {
  return { provider: "anthropic", baseUrl, apiKey: "ak-test", model: "claude-x" };
}

const okBody = { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" };

const shellTool: ToolSpec = {
  name: "run_shell",
  description: "run a shell command",
  parameters: { type: "object", properties: { command: { type: "string" } } },
};

function requestBody(captured: Captured[]): Record<string, unknown> {
  return JSON.parse(String(captured[0]!.init.body)) as Record<string, unknown>;
}

describe("anthropicChat — URL joining", () => {
  it("appends /v1/messages to a bare host", async () => {
    const { fetch, captured } = jsonFetch(200, okBody);
    await anthropicChat(config("https://api.anthropic.com"), [{ role: "user", content: "hi" }], fetch);
    expect(captured[0]!.url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("does not double /v1 for a base that already ends in /v1 (dev proxy)", async () => {
    const { fetch, captured } = jsonFetch(200, okBody);
    await anthropicChat(config("/llm/v1"), [{ role: "user", content: "hi" }], fetch);
    expect(captured[0]!.url).toBe("/llm/v1/messages");
  });

  it("tolerates a trailing slash", async () => {
    const { fetch, captured } = jsonFetch(200, okBody);
    await anthropicChat(config("https://api.anthropic.com/"), [{ role: "user", content: "hi" }], fetch);
    expect(captured[0]!.url).toBe("https://api.anthropic.com/v1/messages");
  });
});

describe("anthropicChat — headers", () => {
  it("sends x-api-key, anthropic-version, and the browser-access opt-in", async () => {
    const { fetch, captured } = jsonFetch(200, okBody);
    await anthropicChat(config("https://api.anthropic.com"), [{ role: "user", content: "hi" }], fetch);
    const headers = captured[0]!.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("ak-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
  });
});

describe("anthropicChat — request body mapping", () => {
  it("hoists system messages, sets max_tokens, and maps tools to input_schema", async () => {
    const { fetch, captured } = jsonFetch(200, okBody);
    await anthropicChat(
      config("https://api.anthropic.com"),
      [
        { role: "system", content: "be nice" },
        { role: "user", content: "hello" },
      ],
      fetch,
      { tools: [shellTool] },
    );
    const body = requestBody(captured);
    expect(body.system).toBe("be nice");
    expect(typeof body.max_tokens).toBe("number");
    expect(body.max_tokens as number).toBeGreaterThan(0);
    expect(body.tools).toEqual([
      { name: "run_shell", description: "run a shell command", input_schema: shellTool.parameters },
    ]);
    expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("omits tools when none are given", async () => {
    const { fetch, captured } = jsonFetch(200, okBody);
    await anthropicChat(config("https://api.anthropic.com"), [{ role: "user", content: "hi" }], fetch);
    expect("tools" in requestBody(captured)).toBe(false);
  });

  it("round-trips a tool-use turn: assistant toolCalls become tool_use blocks and consecutive tool results share one user turn", async () => {
    const { fetch, captured } = jsonFetch(200, okBody);
    const messages: ChatMessage[] = [
      { role: "user", content: "list files then read a.txt" },
      {
        role: "assistant",
        content: "on it",
        toolCalls: [
          { id: "toolu_1", name: "run_shell", arguments: '{"command":"ls"}' },
          { id: "toolu_2", name: "read_file", arguments: '{"path":"a.txt"}' },
        ],
      },
      { role: "tool", toolCallId: "toolu_1", content: "a.txt" },
      { role: "tool", toolCallId: "toolu_2", content: "hello world" },
      { role: "assistant", content: "done" },
    ];
    await anthropicChat(config("https://api.anthropic.com"), messages, fetch, { tools: [shellTool] });
    const body = requestBody(captured);
    expect(body.messages).toEqual([
      { role: "user", content: "list files then read a.txt" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "on it" },
          { type: "tool_use", id: "toolu_1", name: "run_shell", input: { command: "ls" } },
          { type: "tool_use", id: "toolu_2", name: "read_file", input: { path: "a.txt" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "a.txt" },
          { type: "tool_result", tool_use_id: "toolu_2", content: "hello world" },
        ],
      },
      { role: "assistant", content: "done" },
    ]);
  });

  it("encodes empty tool-call arguments as an empty input object and omits the text block for empty assistant content", async () => {
    const { fetch, captured } = jsonFetch(200, okBody);
    await anthropicChat(
      config("https://api.anthropic.com"),
      [
        { role: "user", content: "go" },
        { role: "assistant", content: "", toolCalls: [{ id: "toolu_1", name: "list_dir", arguments: "" }] },
        { role: "tool", toolCallId: "toolu_1", content: "ok" },
      ],
      fetch,
    );
    const body = requestBody(captured);
    expect(body.messages).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "list_dir", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
    ]);
  });

  it("throws a precise error on a role:tool message with no toolCallId", async () => {
    const { fetch } = jsonFetch(200, okBody);
    await expect(
      anthropicChat(
        config("https://api.anthropic.com"),
        [
          { role: "user", content: "go" },
          { role: "tool", content: "orphan result" },
        ],
        fetch,
      ),
    ).rejects.toThrow(/role:"tool" message has no toolCallId.*orphan result/);
  });

  it("throws a precise error on non-JSON tool-call arguments", async () => {
    const { fetch } = jsonFetch(200, okBody);
    await expect(
      anthropicChat(
        config("https://api.anthropic.com"),
        [
          { role: "user", content: "go" },
          { role: "assistant", content: "", toolCalls: [{ id: "toolu_1", name: "run_shell", arguments: "{oops" }] },
        ],
        fetch,
      ),
    ).rejects.toThrow(/run_shell.*non-JSON arguments.*\{oops/);
  });
});

describe("anthropicChat — response parsing", () => {
  it("parses tool_use blocks into toolCalls with JSON-string arguments and captures the raw turn", async () => {
    const rawTurn = [
      { type: "text", text: "let me check" },
      { type: "tool_use", id: "toolu_9", name: "run_shell", input: { command: "ls /app" } },
    ];
    const { fetch } = jsonFetch(200, { content: rawTurn, stop_reason: "tool_use" });
    const result = await anthropicChat(
      config("https://api.anthropic.com"),
      [{ role: "user", content: "list" }],
      fetch,
      { tools: [shellTool] },
    );
    expect(result.content).toBe("let me check");
    expect(result.toolCalls).toEqual([
      { id: "toolu_9", name: "run_shell", arguments: '{"command":"ls /app"}', rawContent: rawTurn },
    ]);
  });

  it("concatenates multiple text blocks", async () => {
    const { fetch } = jsonFetch(200, {
      content: [
        { type: "text", text: "part one " },
        { type: "text", text: "part two" },
      ],
      stop_reason: "end_turn",
    });
    const result = await anthropicChat(config("https://api.anthropic.com"), [{ role: "user", content: "x" }], fetch);
    expect(result.content).toBe("part one part two");
    expect(result.toolCalls).toEqual([]);
  });

  it("fails loudly on a non-2xx response with status and body", async () => {
    const { fetch } = jsonFetch(401, { error: "bad key" });
    await expect(
      anthropicChat(config("https://api.anthropic.com"), [{ role: "user", content: "x" }], fetch),
    ).rejects.toThrow(/401.*bad key/);
  });

  it("throws on an unexpected response shape", async () => {
    const { fetch } = jsonFetch(200, { nope: true });
    await expect(
      anthropicChat(config("https://api.anthropic.com"), [{ role: "user", content: "x" }], fetch),
    ).rejects.toThrow(/unexpected response shape/);
  });

  it("throws on a malformed tool_use block", async () => {
    const { fetch } = jsonFetch(200, { content: [{ type: "tool_use", input: {} }], stop_reason: "tool_use" });
    await expect(
      anthropicChat(config("https://api.anthropic.com"), [{ role: "user", content: "x" }], fetch),
    ).rejects.toThrow(/malformed tool_use block/);
  });

  it('throws when the response was truncated (stop_reason "max_tokens")', async () => {
    const { fetch } = jsonFetch(200, {
      content: [{ type: "text", text: "half an ans" }],
      stop_reason: "max_tokens",
    });
    await expect(
      anthropicChat(config("https://api.anthropic.com"), [{ role: "user", content: "x" }], fetch),
    ).rejects.toThrow(/truncated by max_tokens.*half an ans/);
  });

  it('throws when the model refused (stop_reason "refusal")', async () => {
    const { fetch } = jsonFetch(200, { content: [], stop_reason: "refusal" });
    await expect(
      anthropicChat(config("https://api.anthropic.com"), [{ role: "user", content: "x" }], fetch),
    ).rejects.toThrow(/refused.*refusal/);
  });
});

describe("anthropicChat — thinking-block echo (thinking-default models)", () => {
  // A tool-use response as claude-sonnet-5 / claude-fable-5 produce it:
  // thinking blocks (one with an empty summary, as under display:"omitted",
  // one with text — both signed) ahead of the text and tool_use blocks.
  // Anthropic requires these to be passed back UNCHANGED, signatures and
  // empty-text blocks included, when the turn is continued.
  const thinkingTurn = [
    { type: "thinking", thinking: "", signature: "sig-A" },
    { type: "thinking", thinking: "I should list the files first.", signature: "sig-B" },
    { type: "text", text: "listing" },
    { type: "tool_use", id: "toolu_t1", name: "run_shell", input: { command: "ls" } },
  ];

  it("keeps thinking text out of the assistant content but captures the blocks verbatim", async () => {
    const { fetch } = jsonFetch(200, { content: thinkingTurn, stop_reason: "tool_use" });
    const result = await anthropicChat(
      config("https://api.anthropic.com"),
      [{ role: "user", content: "list" }],
      fetch,
      { tools: [shellTool] },
    );
    expect(result.content).toBe("listing");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.rawContent).toEqual(thinkingTurn);
  });

  it("echoes the captured turn verbatim on the follow-up request (as the agent loop rebuilds it)", async () => {
    const first = jsonFetch(200, { content: thinkingTurn, stop_reason: "tool_use" });
    const result = await anthropicChat(
      config("https://api.anthropic.com"),
      [{ role: "user", content: "list" }],
      first.fetch,
      { tools: [shellTool] },
    );

    // Rebuild the transcript exactly as agent-core does: the assistant turn is
    // reconstructed from result.content + result.toolCalls (same objects).
    const messages: ChatMessage[] = [
      { role: "user", content: "list" },
      { role: "assistant", content: result.content, toolCalls: result.toolCalls },
      { role: "tool", toolCallId: "toolu_t1", content: "a.txt" },
    ];
    const second = jsonFetch(200, okBody);
    await anthropicChat(config("https://api.anthropic.com"), messages, second.fetch, { tools: [shellTool] });

    const body = requestBody(second.captured);
    expect(body.messages).toEqual([
      { role: "user", content: "list" },
      // The whole turn — thinking blocks, signatures, empty thinking text —
      // must round-trip byte-identical, not be rebuilt from content+toolCalls.
      { role: "assistant", content: thinkingTurn },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_t1", content: "a.txt" }] },
    ]);
  });

  it("still echoes verbatim after a JSON persistence round-trip of the transcript", async () => {
    const first = jsonFetch(200, { content: thinkingTurn, stop_reason: "tool_use" });
    const result = await anthropicChat(
      config("https://api.anthropic.com"),
      [{ role: "user", content: "list" }],
      first.fetch,
      { tools: [shellTool] },
    );
    // Runs are persisted to IndexedDB as plain JSON and rehydrated on reload —
    // the captured turn must survive that round-trip.
    const persisted = JSON.parse(
      JSON.stringify([
        { role: "user", content: "list" },
        { role: "assistant", content: result.content, toolCalls: result.toolCalls },
        { role: "tool", toolCallId: "toolu_t1", content: "a.txt" },
      ]),
    ) as ChatMessage[];
    const second = jsonFetch(200, okBody);
    await anthropicChat(config("https://api.anthropic.com"), persisted, second.fetch, { tools: [shellTool] });
    const body = requestBody(second.captured) as { messages: unknown[] };
    expect(body.messages[1]).toEqual({ role: "assistant", content: thinkingTurn });
  });

  it("reconstructs from content + toolCalls when no captured turn exists (hand-seeded or pre-capture transcript)", async () => {
    const { fetch, captured } = jsonFetch(200, okBody);
    await anthropicChat(
      config("https://api.anthropic.com"),
      [
        { role: "user", content: "list" },
        {
          role: "assistant",
          content: "on it",
          toolCalls: [{ id: "toolu_h1", name: "run_shell", arguments: '{"command":"ls"}' }],
        },
        { role: "tool", toolCallId: "toolu_h1", content: "a.txt" },
      ],
      fetch,
      { tools: [shellTool] },
    );
    const body = requestBody(captured) as { messages: unknown[] };
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "on it" },
        { type: "tool_use", id: "toolu_h1", name: "run_shell", input: { command: "ls" } },
      ],
    });
  });
});

describe("anthropicStream", () => {
  it("hits the joined endpoint with the browser-access header and yields text deltas", async () => {
    const { fetch, captured } = sseFetch([
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"He"}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"llo"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
    ]);
    const out: string[] = [];
    for await (const delta of anthropicStream(config("/llm/v1"), [{ role: "user", content: "x" }], fetch)) {
      out.push(delta);
    }
    expect(out).toEqual(["He", "llo"]);
    expect(captured[0]!.url).toBe("/llm/v1/messages");
    const headers = captured[0]!.init.headers as Record<string, string>;
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(JSON.parse(String(captured[0]!.init.body))).toMatchObject({ stream: true });
  });

  it("throws when the stream ends truncated by max_tokens", async () => {
    const { fetch } = sseFetch([
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\n',
    ]);
    const run = async () => {
      const out: string[] = [];
      for await (const delta of anthropicStream(
        config("https://api.anthropic.com"),
        [{ role: "user", content: "x" }],
        fetch,
      )) {
        out.push(delta);
      }
      return out;
    };
    await expect(run()).rejects.toThrow(/stop_reason "max_tokens"/);
  });
});
