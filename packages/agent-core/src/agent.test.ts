import { describe, it, expect } from "vitest";
import { BrowserRuntime } from "@erdou/runtime-browser";
import { ModelGateway, type ModelConfig } from "@erdou/model-gateway";
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
