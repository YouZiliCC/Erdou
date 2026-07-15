import { describe, it, expect, vi } from "vitest";
import { BrowserRuntime } from "@erdou/runtime-browser";
import { ModelGateway, type ModelConfig, type ChatMessage } from "@erdou/model-gateway";
import { CodingAgent } from "./agent.js";
import type { AgentEvent } from "./types.js";

const model: ModelConfig = {
  provider: "openai-compatible",
  baseUrl: "https://x",
  apiKey: "k",
  model: "m",
};

const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

function toolCall(name: string, args: unknown, id = "c1"): unknown {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
  };
}
const final = (content: string): unknown => ({ choices: [{ message: { content } }] });

function scriptedGateway(responses: unknown[]): ModelGateway {
  let i = 0;
  const fetch = (async () => {
    const body = responses[i++] ?? final("done");
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof globalThis.fetch;
  return new ModelGateway({ fetch });
}

async function freshRuntime(): Promise<BrowserRuntime> {
  const rt = new BrowserRuntime({ clock: () => 0 });
  await rt.boot();
  return rt;
}

describe("CodingAgent", () => {
  it("executes a tool call against the runtime, then finishes", async () => {
    const runtime = await freshRuntime();
    const events: AgentEvent[] = [];
    const gateway = scriptedGateway([
      toolCall("write_file", { path: "/hello.txt", content: "hi" }),
      final("Created hello.txt."),
    ]);
    const agent = new CodingAgent({ runtime, gateway, model, onEvent: (e) => events.push(e) });
    const result = await agent.run("create hello.txt containing hi");

    expect(result.stoppedReason).toBe("done");
    expect(result.finalMessage).toBe("Created hello.txt.");
    expect(decode(await runtime.readFile("/hello.txt"))).toBe("hi");
    expect(events.some((e) => e.type === "tool_result" && e.ok)).toBe(true);
  });

  it("runs a multi-step task", async () => {
    const runtime = await freshRuntime();
    const gateway = scriptedGateway([
      toolCall("make_dir", { path: "/proj" }),
      toolCall("write_file", { path: "/proj/README.md", content: "# Hi" }),
      toolCall("run_shell", { command: "ls /proj" }),
      final("Project created."),
    ]);
    const agent = new CodingAgent({ runtime, gateway, model });
    const result = await agent.run("make a project");

    expect(result.stoppedReason).toBe("done");
    expect(result.steps).toBe(4);
    expect(decode(await runtime.readFile("/proj/README.md"))).toBe("# Hi");
  });

  it("stops at maxSteps when the model never finishes", async () => {
    const runtime = await freshRuntime();
    let i = 0;
    const fetch = (async () =>
      new Response(JSON.stringify(toolCall("list_dir", { path: "/" }, `c${i++}`)), {
        status: 200,
      })) as typeof globalThis.fetch;
    const gateway = new ModelGateway({ fetch });
    const agent = new CodingAgent({ runtime, gateway, model, maxSteps: 3 });
    const result = await agent.run("loop");

    expect(result.stoppedReason).toBe("max_steps");
    expect(result.steps).toBe(3);
  });

  it("handles a malformed tool call and still terminates", async () => {
    const runtime = await freshRuntime();
    const badCall = {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: "{not json" } }],
          },
        },
      ],
    };
    const gateway = scriptedGateway([badCall, final("Recovered.")]);
    const agent = new CodingAgent({ runtime, gateway, model });
    const result = await agent.run("x");

    expect(result.stoppedReason).toBe("done");
    expect(result.finalMessage).toBe("Recovered.");
  });
});

function fakeGateway(): ModelGateway {
  const chat = vi
    .fn()
    .mockResolvedValueOnce({
      content: "",
      toolCalls: [{ id: "1", name: "run_shell", arguments: JSON.stringify({ command: "echo hi > /x.txt" }) }],
    })
    .mockResolvedValueOnce({ content: "done", toolCalls: [] });
  return { chat } as unknown as ModelGateway;
}

describe("multi-turn continuation", () => {
  it("carries prior transcript into the next turn without a duplicate system prompt", async () => {
    const runtime = await freshRuntime();
    // `messages` is mutated in place by the agent during a run, so snapshot (shallow-copy) it
    // at call time rather than relying on the reference captured in `chat.mock.calls`.
    const seenMessages: ChatMessage[][] = [];
    const chat = vi
      .fn()
      .mockImplementationOnce(async (_model: unknown, messages: ChatMessage[]) => {
        seenMessages.push([...messages]);
        return {
          content: "",
          toolCalls: [{ id: "1", name: "list_dir", arguments: JSON.stringify({ path: "/" }) }],
        };
      })
      .mockImplementationOnce(async (_model: unknown, messages: ChatMessage[]) => {
        seenMessages.push([...messages]);
        return { content: "turn 1 done", toolCalls: [] };
      })
      .mockImplementationOnce(async (_model: unknown, messages: ChatMessage[]) => {
        seenMessages.push([...messages]);
        return { content: "turn 2 done", toolCalls: [] };
      });
    const gateway = { chat } as unknown as ModelGateway;
    const agent = new CodingAgent({ runtime, gateway, model });

    const r1 = await agent.run("t1");
    expect(r1.stoppedReason).toBe("done");

    const r2 = await agent.run("t2", r1.transcript);
    expect(r2.stoppedReason).toBe("done");

    expect(chat).toHaveBeenCalledTimes(3);
    const turn2FirstMessages = seenMessages[2];
    if (!turn2FirstMessages) throw new Error("expected a 3rd chat call");

    // Exactly one system message, and it's the one already present in r1.transcript.
    const systemMessages = turn2FirstMessages.filter((m) => m.role === "system");
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0]).toBe(r1.transcript[0]);

    // Turn-1 context (user task, assistant tool call, tool result, assistant done) is carried.
    expect(turn2FirstMessages.some((m) => m.role === "user" && m.content === "t1")).toBe(true);
    expect(
      turn2FirstMessages.some(
        (m) => m.role === "assistant" && m.toolCalls?.some((tc) => tc.name === "list_dir"),
      ),
    ).toBe(true);
    expect(turn2FirstMessages.some((m) => m.role === "tool" && m.toolCallId === "1")).toBe(true);
    expect(turn2FirstMessages.some((m) => m.role === "assistant" && m.content === "turn 1 done")).toBe(true);

    // The new turn's user message is appended at the end (the state at call time, before any
    // further mutation of the shared array by the rest of the run).
    expect(turn2FirstMessages[turn2FirstMessages.length - 1]).toEqual({ role: "user", content: "t2" });
  });

  it("still starts fresh with [system, user, ...] when priorMessages is omitted", async () => {
    const runtime = await freshRuntime();
    const gateway = scriptedGateway([final("ok")]);
    const agent = new CodingAgent({ runtime, gateway, model });
    const result = await agent.run("fresh task");

    expect(result.transcript[0]?.role).toBe("system");
    expect(result.transcript[1]).toEqual({ role: "user", content: "fresh task" });
    expect(result.transcript.filter((m) => m.role === "system")).toHaveLength(1);
  });
});

describe("approval gate", () => {
  it("does not run a gated command when denied", async () => {
    const runtime = new BrowserRuntime();
    await runtime.boot();
    const agent = new CodingAgent({
      runtime,
      gateway: fakeGateway(),
      model: {} as ModelConfig,
      maxSteps: 3,
      approve: async () => "deny",
    });
    await agent.run("make x");
    expect(runtime.fs.exists("/x.txt")).toBe(false);
  });

  it("runs the gated command when allowed", async () => {
    const runtime = new BrowserRuntime();
    await runtime.boot();
    const agent = new CodingAgent({
      runtime,
      gateway: fakeGateway(),
      model: {} as ModelConfig,
      maxSteps: 3,
      approve: async () => "allow",
    });
    await agent.run("make x");
    expect(runtime.fs.exists("/x.txt")).toBe(true);
  });
});
