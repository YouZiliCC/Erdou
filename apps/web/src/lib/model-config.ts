import type { ModelConfig } from "@erdou/model-gateway";

const KEY = "erdou:model";
const APPROVAL_KEY = "erdou:approval-mode";

/**
 * How gated tools (run_shell/remove_path) are handled:
 * - "auto": run freely (today's autonomous behavior).
 * - "confirm": pause and ask the user to Allow/Deny before each one.
 * Persisted separately from ModelConfig — it must never reach the gateway.
 */
export type ApprovalMode = "auto" | "confirm";

export function loadApprovalMode(): ApprovalMode {
  return localStorage.getItem(APPROVAL_KEY) === "confirm" ? "confirm" : "auto";
}

export function saveApprovalMode(mode: ApprovalMode): void {
  localStorage.setItem(APPROVAL_KEY, mode);
}

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
