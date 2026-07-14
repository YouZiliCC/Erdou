import type { ModelConfig } from "@erdou/model-gateway";

const KEY = "erdou:model";

export const DEFAULT_MODEL: ModelConfig = {
  provider: "openai-compatible",
  // Same-origin path proxied by the dev server to the model provider (see vite.config.ts).
  baseUrl: "/llm/v1",
  apiKey: "",
  model: "gpt-4o-mini",
};

export function loadModel(): ModelConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_MODEL };
    return { ...DEFAULT_MODEL, ...(JSON.parse(raw) as Partial<ModelConfig>) };
  } catch {
    return { ...DEFAULT_MODEL };
  }
}

export function saveModel(cfg: ModelConfig): void {
  localStorage.setItem(KEY, JSON.stringify(cfg));
}
