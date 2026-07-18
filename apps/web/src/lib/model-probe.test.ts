import { describe, it, expect, vi } from "vitest";
import type { ChatOptions, ChatResult, ModelGateway } from "@erdou/model-gateway";
import { DEFAULT_MODEL } from "./model-config.js";
import { createProbeSession, probeModel } from "./model-probe.js";

// The chat-mock gateway idiom from the studio tests: each mockImplementation
// (or mockResolvedValueOnce) supplies one model turn; calls can be inspected.
type ChatMock = ReturnType<typeof vi.fn>;
function gatewayWith(chat: ChatMock): ModelGateway {
  return { chat } as unknown as ModelGateway;
}

const textTurn = (content: string): ChatResult => ({ content, toolCalls: [] });
const pingTurn: ChatResult = {
  content: "",
  toolCalls: [{ id: "t1", name: "ping", arguments: "{}" }],
};

describe("probeModel", () => {
  it("both checks pass: chatOk + toolsOk, success detail, both requests hit the gateway", async () => {
    const chat = vi.fn().mockResolvedValueOnce(textTurn("ok")).mockResolvedValueOnce(pingTurn);
    const result = await probeModel(gatewayWith(chat), DEFAULT_MODEL);

    expect(result.chatOk).toBe(true);
    expect(result.toolsOk).toBe(true);
    expect(result.detail).toContain("chat and tool calling both work");
    expect(chat).toHaveBeenCalledTimes(2);
    // Both requests carry the dialog's config — the same per-call config path runs use.
    expect(chat.mock.calls[0]![0]).toBe(DEFAULT_MODEL);
    expect(chat.mock.calls[1]![0]).toBe(DEFAULT_MODEL);
    // The chat probe sends NO tools (a provider that errors on `tools` still
    // gets a clean reachability verdict); the tool probe sends only "ping".
    expect((chat.mock.calls[0]![2] as ChatOptions).tools).toBeUndefined();
    expect((chat.mock.calls[1]![2] as ChatOptions).tools).toEqual([
      expect.objectContaining({ name: "ping" }),
    ]);
  });

  it("chat ok but the model ignores tools: warning path, toolsOk false", async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(textTurn("ok"))
      .mockResolvedValueOnce(textTurn("pong! (no tool call)"));
    const result = await probeModel(gatewayWith(chat), DEFAULT_MODEL);

    expect(result.chatOk).toBe(true);
    expect(result.toolsOk).toBe(false);
    expect(result.detail).toContain("tool calling did not work — the agent cannot act without it");
  });

  it("chat ok but the tools REQUEST errors: warning path carries the gateway error verbatim", async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(textTurn("ok"))
      .mockRejectedValueOnce(new Error('openai-compatible chat failed: 400 {"error":"tools not supported"}'));
    const result = await probeModel(gatewayWith(chat), DEFAULT_MODEL);

    expect(result.chatOk).toBe(true);
    expect(result.toolsOk).toBe(false);
    expect(result.detail).toContain("the agent cannot act without it");
    expect(result.detail).toContain('openai-compatible chat failed: 400 {"error":"tools not supported"}');
  });

  it("chat fails: the gateway's error surfaces VERBATIM and the tool probe is skipped", async () => {
    const chat = vi
      .fn()
      .mockRejectedValue(new Error('anthropic chat failed: 401 {"type":"authentication_error"}'));
    const result = await probeModel(gatewayWith(chat), DEFAULT_MODEL);

    expect(result.chatOk).toBe(false);
    expect(result.toolsOk).toBe(false);
    expect(result.detail).toBe('anthropic chat failed: 401 {"type":"authentication_error"}');
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("records the chat round-trip latency", async () => {
    const chat = vi
      .fn()
      .mockImplementationOnce(async () => {
        await new Promise((r) => setTimeout(r, 25));
        return textTurn("ok");
      })
      .mockResolvedValueOnce(pingTurn);
    const result = await probeModel(gatewayWith(chat), DEFAULT_MODEL);

    // Generous lower bound: timers may fire a hair early, but a recorded
    // latency of ~0 would mean the measurement is wired wrong.
    expect(result.latencyMs).toBeGreaterThanOrEqual(15);
    expect(result.detail).toContain(`${result.latencyMs} ms`);
  });

  it("records latency even when chat fails", async () => {
    const chat = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 25));
      throw new Error("openai-compatible chat failed: 503 upstream unavailable");
    });
    const result = await probeModel(gatewayWith(chat), DEFAULT_MODEL);

    expect(result.chatOk).toBe(false);
    expect(result.latencyMs).toBeGreaterThanOrEqual(15);
  });
});

// Stale-result race guard: the dialog's fields stay editable while a probe is
// in flight, so a verdict resolving after an edit must be DROPPED (null), never
// displayed against values it did not test.
describe("createProbeSession", () => {
  it("reports the result when nothing was edited mid-flight", async () => {
    const chat = vi.fn().mockResolvedValueOnce(textTurn("ok")).mockResolvedValueOnce(pingTurn);
    const result = await createProbeSession().run(gatewayWith(chat), DEFAULT_MODEL);

    expect(result).not.toBeNull();
    expect(result!.toolsOk).toBe(true);
  });

  it("drops the verdict (null) when invalidate() fires while the probe is in flight", async () => {
    // Deferred chat: the probe's first request stays pending until we release
    // it, giving the "edit" a real in-flight window to land in.
    let release!: (turn: ChatResult) => void;
    const chat = vi
      .fn()
      .mockImplementationOnce(() => new Promise<ChatResult>((r) => (release = r)))
      .mockResolvedValueOnce(pingTurn);
    const session = createProbeSession();
    const pending = session.run(gatewayWith(chat), DEFAULT_MODEL);

    session.invalidate(); // a config field was edited mid-flight
    release(textTurn("ok"));

    await expect(pending).resolves.toBeNull();
  });

  it("a fresh run AFTER an invalidation reports normally (edits don't poison the session)", async () => {
    const chat = vi.fn().mockResolvedValueOnce(textTurn("ok")).mockResolvedValueOnce(pingTurn);
    const session = createProbeSession();
    session.invalidate();
    const result = await session.run(gatewayWith(chat), DEFAULT_MODEL);

    expect(result).not.toBeNull();
    expect(result!.chatOk).toBe(true);
  });
});
