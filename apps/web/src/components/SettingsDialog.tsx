import { useState } from "react";
import type { ModelConfig } from "@erdou/model-gateway";
import type { ApprovalMode } from "../lib/model-config.js";
import { Select } from "./ui/Select.js";

const PROVIDER_OPTIONS: { value: ModelConfig["provider"]; label: string }[] = [
  { value: "openai-compatible", label: "OpenAI-compatible" },
  { value: "anthropic", label: "Anthropic" },
];

const APPROVAL_OPTIONS: { value: ApprovalMode; label: string }[] = [
  { value: "auto", label: "Auto — run shell & delete commands without asking" },
  { value: "confirm", label: "Confirm — ask before each shell or delete command" },
];

export function SettingsDialog({
  initial,
  approvalMode,
  onApprovalModeChange,
  onSave,
  onClose,
}: {
  initial: ModelConfig;
  approvalMode: ApprovalMode;
  onApprovalModeChange: (mode: ApprovalMode) => void;
  onSave: (cfg: ModelConfig) => void;
  onClose: () => void;
}) {
  const [cfg, setCfg] = useState<ModelConfig>(initial);
  const patch = (p: Partial<ModelConfig>) => setCfg((c) => ({ ...c, ...p }));

  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Model connection</h2>
        <p className="sub">Bring your own key. It's stored only in this browser and sent to your provider — never to Erdou.</p>

        <div className="field">
          <label>Provider</label>
          <Select
            className="block"
            value={cfg.provider}
            options={PROVIDER_OPTIONS}
            onChange={(provider) => patch({ provider })}
            ariaLabel="Provider"
          />
        </div>
        <div className="field">
          <label>Base URL</label>
          <input value={cfg.baseUrl} onChange={(e) => patch({ baseUrl: e.target.value })} placeholder="/llm/v1" />
        </div>
        <div className="field">
          <label>Model</label>
          <input value={cfg.model} onChange={(e) => patch({ model: e.target.value })} placeholder="gpt-4o-mini" />
        </div>
        <div className="field">
          <label>API key</label>
          <input
            type="password"
            value={cfg.apiKey}
            onChange={(e) => patch({ apiKey: e.target.value })}
            placeholder="sk-…"
          />
        </div>

        <div className="field">
          <label>Command approvals</label>
          <Select
            className="block"
            value={approvalMode}
            options={APPROVAL_OPTIONS}
            onChange={onApprovalModeChange}
            ariaLabel="Command approvals"
          />
        </div>

        <div className="actions">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => onSave(cfg)}>
            Save
          </button>
        </div>
        <p className="note">
          The default base URL <code>/llm/v1</code> is proxied by the dev server to your provider, avoiding browser CORS.
          Point it elsewhere with the VITE_LLM_TARGET env var.
        </p>
      </div>
    </div>
  );
}
