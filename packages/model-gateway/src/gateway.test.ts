import { describe, it, expect } from "vitest";
import { ModelGateway } from "./gateway.js";
import type { ModelConfig } from "./types.js";

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

function sseFetch(chunks: string[]): typeof globalThis.fetch {
  return (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof globalThis.fetch;
}

const openaiConfig: ModelConfig = {
  provider: "openai-compatible",
  baseUrl: "https://api/v1",
  apiKey: "sk-test",
  model: "gpt-x",
};
const anthropicConfig: ModelConfig = {
  provider: "anthropic",
  baseUrl: "https://claude",
  apiKey: "ak-test",
  model: "claude-x",
};

describe("ModelGateway", () => {
  it("posts to the OpenAI endpoint with bearer auth and returns content", async () => {
    const { fetch, captured } = jsonFetch(200, { choices: [{ message: { content: "hi there" } }] });
    const gw = new ModelGateway({ fetch });
    const result = await gw.chat(openaiConfig, [{ role: "user", content: "hello" }]);
    expect(result.content).toBe("hi there");
    expect(captured[0]!.url).toBe("https://api/v1/chat/completions");
    expect((captured[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
  });

  it("posts to the Anthropic endpoint with x-api-key and returns text", async () => {
    const { fetch, captured } = jsonFetch(200, { content: [{ text: "hey" }] });
    const gw = new ModelGateway({ fetch });
    const result = await gw.chat(anthropicConfig, [
      { role: "system", content: "be nice" },
      { role: "user", content: "hello" },
    ]);
    expect(result.content).toBe("hey");
    expect(captured[0]!.url).toBe("https://claude/v1/messages");
    expect((captured[0]!.init.headers as Record<string, string>)["x-api-key"]).toBe("ak-test");
  });

  it("fails loudly on a non-2xx response", async () => {
    const { fetch } = jsonFetch(401, { error: "bad key" });
    const gw = new ModelGateway({ fetch });
    await expect(gw.chat(openaiConfig, [{ role: "user", content: "x" }])).rejects.toThrow(/401.*bad key/);
  });

  it("streams OpenAI deltas", async () => {
    const gw = new ModelGateway({
      fetch: sseFetch([
        'data: {"choices":[{"delta":{"content":"He"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    });
    const out: string[] = [];
    for await (const delta of gw.chatStream(openaiConfig, [{ role: "user", content: "x" }])) out.push(delta);
    expect(out).toEqual(["He", "llo"]);
  });
});
