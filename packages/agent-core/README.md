# @erdou/agent-core

The reference **Coding Agent** — the first core application on the Erdou runtime. Given a task and a BYO-key model, it drives a `Runtime` through `@erdou/agent-tools` in a plan → act → observe loop until the model finishes with a tool-free reply (or the step budget runs out).

```ts
import { CodingAgent } from "@erdou/agent-core";
import { ModelGateway } from "@erdou/model-gateway";
import { BrowserRuntime } from "@erdou/runtime-browser";

const runtime = new BrowserRuntime();
await runtime.boot();

const agent = new CodingAgent({
  runtime,
  gateway: new ModelGateway(),
  model: { provider: "openai-compatible", baseUrl: "https://…/v1", apiKey: KEY, model: "gpt-4o-mini" },
  onEvent: (e) => console.log(e),
});

const result = await agent.run("Create /app/greet.txt containing 'Hello Erdou', then verify it.");
```

All task-level judgment (what to do, whether it's done) lives here; the runtime only reports facts. Uses OpenAI-compatible tool calling via the gateway. Depends on `@erdou/agent-tools`, `@erdou/model-gateway`, `@erdou/runtime-contract`.

A live end-to-end test (`src/live.e2e.test.ts`) runs against a real endpoint when `ERDOU_LIVE_KEY` is set (skipped otherwise).
