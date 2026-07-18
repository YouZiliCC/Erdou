import { useRef, useState } from "react";
import { ModelGateway, type ModelConfig } from "@erdou/model-gateway";
import { switchProvider, type ApprovalMode } from "../lib/model-config.js";
import { createProbeSession, type ProbeResult } from "../lib/model-probe.js";
import { Select } from "./ui/Select.js";

/**
 * The probe's gateway — the SAME zero-arg construction studio uses for runs
 * (studio.ts `new ModelGateway()`), so "Test" exercises the exact client +
 * provider path a run would, with the dialog's CURRENT (unsaved) field values
 * passed per call. No parallel HTTP client.
 */
const probeGateway = new ModelGateway();

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
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  // A probe result describes the values it tested — and fields stay EDITABLE
  // while a probe is in flight (up to ~40 s), so every config mutation goes
  // through `update`, which clears any shown result AND invalidates the
  // in-flight one: its session.run resolves null instead of a verdict for
  // values it never tested (the stale-result race).
  const session = useRef(createProbeSession()).current;
  const update = (fn: (c: ModelConfig) => ModelConfig) => {
    session.invalidate();
    setProbe(null);
    setCfg(fn);
  };
  const patch = (p: Partial<ModelConfig>) => update((c) => ({ ...c, ...p }));

  const runProbe = async () => {
    setProbing(true);
    setProbe(null);
    try {
      // session.run never rejects (probeModel maps every failure to a
      // structured result); null means an edit landed mid-flight and the now
      // stale verdict was dropped. The finally only guards the button against
      // a truly unexpected throw.
      const result = await session.run(probeGateway, cfg);
      if (result) setProbe(result);
    } finally {
      setProbing(false);
    }
  };

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
            onChange={(provider) => update((c) => switchProvider(c, provider))}
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
          <button className="btn" disabled={probing} onClick={() => void runProbe()}>
            {probing ? "Testing…" : "Test"}
          </button>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => onSave(cfg)}>
            Save
          </button>
        </div>
        {probe && (
          <p
            className={`note probe-result ${probe.chatOk ? (probe.toolsOk ? "ok" : "warn") : "err"}`}
            aria-live="polite"
          >
            {probe.detail}
          </p>
        )}
        <p className="note">
          The default <code>/llm/v1</code> is a dev-server proxy whose target is <code>yunwu.ai</code> unless{" "}
          <code>VITE_LLM_TARGET=&lt;url&gt;</code> is set when the dev server starts. A direct provider URL also works
          when the provider permits browser requests: Anthropic does (<code>https://api.anthropic.com</code>, via its
          browser-access header); some OpenAI-compatible providers allow CORS, but <code>api.openai.com</code> does not.
        </p>
      </div>
    </div>
  );
}
