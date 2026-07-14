import { describe, it, expect } from "vitest";
import { BrowserRuntime } from "@erdou/runtime-browser";
import { ModelGateway } from "@erdou/model-gateway";
import { CodingAgent } from "./agent.js";

// Live end-to-end test against a real OpenAI-compatible endpoint. Skipped
// unless ERDOU_LIVE_KEY is set, so CI stays hermetic.
const KEY = process.env.ERDOU_LIVE_KEY;
const BASE = process.env.ERDOU_LIVE_BASE ?? "https://yunwu.ai/v1";
const MODEL = process.env.ERDOU_LIVE_MODEL ?? "gpt-4o-mini";

describe.skipIf(!KEY)("CodingAgent (live)", () => {
  it(
    "completes a real multi-step task against a live model",
    async () => {
      const runtime = new BrowserRuntime();
      await runtime.boot();
      const gateway = new ModelGateway();
      const agent = new CodingAgent({
        runtime,
        gateway,
        model: { provider: "openai-compatible", baseUrl: BASE, apiKey: KEY!, model: MODEL },
        maxSteps: 15,
        onEvent: (e) => {
          if (e.type === "tool_call") console.log(`  → ${e.name}(${JSON.stringify(e.args)})`);
          if (e.type === "done") console.log(`  ✓ done (${e.reason}): ${e.summary}`);
        },
      });

      const result = await agent.run(
        "Create a directory /app. Inside it, create a file greet.txt whose content is exactly 'Hello Erdou'. Then verify it by listing /app and reading the file back.",
      );

      expect(result.stoppedReason).toBe("done");
      const content = new TextDecoder().decode(await runtime.readFile("/app/greet.txt"));
      expect(content.trim()).toBe("Hello Erdou");
    },
    90_000,
  );
});
