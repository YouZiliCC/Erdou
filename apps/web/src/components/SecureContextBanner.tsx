/**
 * A visible warning shown when the page lacks the capabilities preview and
 * folder-mount depend on: a secure context and a Service Worker. Both are
 * withheld by browsers on a plain `http://<ip>` origin, which silently breaks
 * the preview reverse-proxy (`preview-bridge.ts`) — so we surface the cause
 * instead of letting the feature fail mutely.
 *
 * Self-contained (inline styles, no external CSS): App.tsx — owned by a separate
 * lane — mounts it near the top of the shell. Renders nothing when the context
 * is already secure and a Service Worker is available.
 *
 * The still-works list includes the agent: startRun() uses newRunId()
 * (crypto.getRandomValues — not secure-context-gated) precisely so agent runs
 * keep working on the http://<ip> origins this banner targets. If that ever
 * regresses to a [SecureContext]-only API, drop the agent from the copy and
 * from SecureContextBanner.test.ts again.
 */
export function SecureContextBanner() {
  if (typeof window === "undefined") return null;
  const secure = window.isSecureContext && "serviceWorker" in navigator;
  if (secure) return null;

  return (
    <div
      role="alert"
      style={{
        padding: "8px 14px",
        background: "#7a5b00",
        color: "#fff8e1",
        borderBottom: "1px solid #a67c00",
        fontSize: 13,
        lineHeight: 1.4,
      }}
    >
      <div>
        <strong>Preview</strong> and <strong>local folder-mount</strong> are
        disabled: this page is not a secure context (plain{" "}
        <strong>http://&lt;ip&gt;</strong>). The agent, terminal and model calls
        still work.
      </div>
      <div>
        Fix: tunnel it — <code>ssh -L 5173:localhost:5173 user@host</code>, then
        open <code>http://localhost:5173</code> — or serve Erdou behind a TLS
        (https) reverse proxy.
      </div>
    </div>
  );
}
