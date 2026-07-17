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
      Preview and folder-mount need a secure context — open Erdou over{" "}
      <strong>https://</strong> or <strong>http://localhost</strong>, not{" "}
      <strong>http://&lt;ip&gt;</strong>.
    </div>
  );
}
