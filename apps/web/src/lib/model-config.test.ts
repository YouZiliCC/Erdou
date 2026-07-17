import { describe, it, expect } from "vitest";
import type { ModelConfig } from "@erdou/model-gateway";
import { DEFAULT_MODEL, PROVIDER_DEFAULT_BASE_URL, switchProvider } from "./model-config.js";

describe("switchProvider", () => {
  it("swaps a default baseUrl to the new provider's default (openai-compatible → anthropic)", () => {
    const next = switchProvider({ ...DEFAULT_MODEL }, "anthropic");
    expect(next.provider).toBe("anthropic");
    expect(next.baseUrl).toBe("https://api.anthropic.com");
  });

  it("swaps back to the proxy default (anthropic → openai-compatible)", () => {
    const cfg: ModelConfig = {
      provider: "anthropic",
      baseUrl: PROVIDER_DEFAULT_BASE_URL.anthropic,
      apiKey: "ak",
      model: "claude-x",
    };
    const next = switchProvider(cfg, "openai-compatible");
    expect(next.provider).toBe("openai-compatible");
    expect(next.baseUrl).toBe("/llm/v1");
  });

  it("never clobbers a user-customized baseUrl", () => {
    const cfg: ModelConfig = {
      provider: "openai-compatible",
      baseUrl: "https://my-gateway.example.com/v1",
      apiKey: "sk",
      model: "gpt-x",
    };
    const next = switchProvider(cfg, "anthropic");
    expect(next.provider).toBe("anthropic");
    expect(next.baseUrl).toBe("https://my-gateway.example.com/v1");
  });

  it("preserves apiKey and model across the switch", () => {
    const next = switchProvider({ ...DEFAULT_MODEL, apiKey: "sk-abc" }, "anthropic");
    expect(next.apiKey).toBe("sk-abc");
    expect(next.model).toBe(DEFAULT_MODEL.model);
  });

  it("is a no-op when the provider is unchanged", () => {
    const cfg = { ...DEFAULT_MODEL };
    expect(switchProvider(cfg, "openai-compatible")).toEqual(cfg);
  });
});
