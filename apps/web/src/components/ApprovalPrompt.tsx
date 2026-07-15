import type { Studio } from "../lib/studio.js";

/**
 * Inline Confirm-mode prompt for a single gated command. Rendered at the bottom
 * of the running transcript while `studio.pendingApproval` is set; each button
 * resolves the agent's parked `approve` Promise (which also clears the prompt).
 */
export function ApprovalPrompt({ studio }: { studio: Studio }) {
  const pending = studio.pendingApproval;
  if (!pending) return null;
  const { req, resolve, allowAlways } = pending;
  const detail = req.command ?? (typeof req.args.path === "string" ? req.args.path : JSON.stringify(req.args));

  return (
    <div className="approval">
      <div className="approval-head">
        Approve <code>{req.tool}</code>?
      </div>
      <div className="approval-cmd">{detail}</div>
      <div className="approval-actions">
        <button className="btn primary" onClick={() => resolve("allow")}>
          Allow
        </button>
        <button className="btn" onClick={() => allowAlways()}>
          Always allow
        </button>
        <button className="btn ghost" onClick={() => resolve("deny")}>
          Deny
        </button>
      </div>
    </div>
  );
}
