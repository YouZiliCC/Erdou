import { useEffect, useId, useRef, useState } from "react";
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

/** A mousedown/mouseup/click as the scrim's own handler sees it. */
type ScrimEvent = { target: EventTarget | null; currentTarget: EventTarget | null };

/**
 * Tracks one press→release gesture on the scrim to decide whether the click it
 * produces dismisses the dialog. A `click` is dispatched on the nearest common
 * ancestor of its mousedown and mouseup targets, so BOTH cross-edge drags —
 * pressing on the API key input and releasing past the dialog edge, and the
 * reverse, pressing on the scrim and releasing inside the input — dispatch
 * click on the SCRIM with target === currentTarget, indistinguishable from a
 * plain scrim click unless both ends are recorded. Dismissing on either threw
 * away every unsaved field (all dialog state is local useState, no
 * confirmation), so only a gesture whose press AND release both landed on the
 * scrim itself dismisses.
 */
export function createScrimGesture() {
  const onScrim = (e: ScrimEvent) => e.target === e.currentTarget;
  let pressedScrim = false;
  let releasedScrim = false;
  return {
    onMouseDown(e: ScrimEvent) {
      pressedScrim = onScrim(e);
      // Cleared here, not in the click: a release the scrim never sees (mouse
      // let go outside the window) must not leave the previous gesture's true.
      releasedScrim = false;
    },
    onMouseUp(e: ScrimEvent) {
      releasedScrim = onScrim(e);
    },
    dismisses: () => pressedScrim && releasedScrim,
  };
}

/** Selector for the controls the Tab wrap cycles through. */
const FOCUSABLE = "button, input, textarea, select, a[href], [tabindex]:not([tabindex='-1'])";

/**
 * Where Tab must send focus to keep it inside the dialog, or null to let the
 * browser move it normally. `aria-modal` tells assistive tech the rest of the
 * page is unavailable, but nothing here makes the background inert — without
 * this wrap Tab walks straight out into the titlebar/composer behind the scrim
 * and the ARIA claim is a lie. An `active` that is not one of the dialog's own
 * controls (clicking the scrim leaves focus on <body>) is pulled back to the
 * near end rather than let out.
 */
export function wrapTabTarget<T>(focusables: readonly T[], active: T | null, shiftKey: boolean): T | null {
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (first === undefined || last === undefined) return null;
  if (active === null || !focusables.includes(active)) return shiftKey ? last : first;
  if (shiftKey) return active === first ? last : null;
  return active === last ? first : null;
}

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

  /** Records the scrim press/release pair its click is judged by — see createScrimGesture. */
  const scrim = useRef(createScrimGesture()).current;

  // App auto-opens this dialog on first load whenever no API key is stored, so
  // it is the FIRST surface a new user meets — it has to behave like a modal:
  // labelled by its heading, focus moved inside (otherwise focus sits on <body>
  // and Tab walks straight out into the titlebar/composer behind the scrim) and
  // handed back to whatever opened it, plus Tab kept inside (what makes the
  // aria-modal claim true, since nothing marks the background inert) and
  // Escape-to-close on the same kind of document keydown listener ThemeMenu
  // already uses.
  const headingId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  // Initial focus lands on Base URL: the first EDITABLE field. The Provider
  // Select above it is the first focusable control, but it is a popover
  // trigger — focusing it makes Enter/Space open a listbox as the dialog's
  // first keystroke; Shift+Tab from here reaches it.
  const baseUrlRef = useRef<HTMLInputElement>(null);
  // onClose is a fresh arrow on every App render; keeping it in a ref keeps
  // this effect mount-only, so a re-render can't yank focus back to Base URL
  // while the user is typing in another field.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    baseUrlRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // An open ui/Select popover consumes its own Escape (handleSelectKey
        // stops the keydown at the React root, below this listener), so an
        // Escape arriving here means no inner layer wanted it — closing now
        // can't discard fields the user was only abandoning a popover over.
        closeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusables = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => !el.hasAttribute("disabled"), // the Test button while a probe is in flight
      );
      const next = wrapTabTarget(focusables, document.activeElement as HTMLElement | null, e.shiftKey);
      if (next) {
        e.preventDefault();
        next.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      opener?.focus();
    };
  }, []);

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
    <div
      className="scrim"
      onMouseDown={scrim.onMouseDown}
      onMouseUp={scrim.onMouseUp}
      onClick={() => {
        if (scrim.dismisses()) onClose();
      }}
    >
      {/* No stopPropagation here: the gesture already requires both ends of the
          press to land on the scrim, and a second guard would only hide it. */}
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={headingId} ref={dialogRef}>
        <h2 id={headingId}>Model connection</h2>
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
          <input
            ref={baseUrlRef}
            value={cfg.baseUrl}
            onChange={(e) => patch({ baseUrl: e.target.value })}
            placeholder="/llm/v1"
          />
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
