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

/**
 * Sensible baseUrl per provider:
 * - openai-compatible: the dev-server proxy path (its target is yunwu.ai
 *   unless VITE_LLM_TARGET is set at dev-server start — see vite.config.ts).
 * - anthropic: the API host directly; Anthropic permits browser requests via
 *   its browser-access header, so no proxy is needed.
 */
export const PROVIDER_DEFAULT_BASE_URL: Record<ModelConfig["provider"], string> = {
  "openai-compatible": "/llm/v1",
  anthropic: "https://api.anthropic.com",
};

export const DEFAULT_MODEL: ModelConfig = {
  provider: "openai-compatible",
  baseUrl: PROVIDER_DEFAULT_BASE_URL["openai-compatible"],
  apiKey: "",
  model: "gpt-4o-mini",
};

/**
 * Switch a config to another provider. If baseUrl still holds the outgoing
 * provider's default, swap it to the new provider's default; a user-customized
 * baseUrl is never clobbered.
 */
export function switchProvider(cfg: ModelConfig, provider: ModelConfig["provider"]): ModelConfig {
  if (provider === cfg.provider) return cfg;
  const baseUrl =
    cfg.baseUrl === PROVIDER_DEFAULT_BASE_URL[cfg.provider] ? PROVIDER_DEFAULT_BASE_URL[provider] : cfg.baseUrl;
  return { ...cfg, provider, baseUrl };
}

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
