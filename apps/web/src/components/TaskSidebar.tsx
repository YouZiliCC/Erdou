import { useEffect, useRef, useState } from "react";
import type { Studio, Run } from "../lib/studio.js";
import { FolderSyncControls } from "./FolderSyncControls.js";

/** Left rail: the list of agent "task threads", with hover-revealed rename and
 *  two-step delete per row. The only status affordance is a pulsing dot on the
 *  thread whose turn is currently in flight. */
export function TaskSidebar({
  studio,
  onNew,
  onOpenFolder,
  onCollapse,
}: {
  studio: Studio;
  onNew: () => void;
  onOpenFolder: () => void;
  onCollapse: () => void;
}) {
  // Inline rename: which run is being edited + the draft text.
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  // Two-step delete: the run whose × is currently armed as "Delete?".
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Set by Escape so the input's unmount-blur can't commit a cancelled edit.
  const cancelled = useRef(false);

  useEffect(() => () => clearTimeout(confirmTimer.current), []);

  const armDelete = (id: string): void => {
    clearTimeout(confirmTimer.current);
    setConfirmingId(id);
    confirmTimer.current = setTimeout(() => setConfirmingId(null), 3500);
  };
  const disarmDelete = (): void => {
    clearTimeout(confirmTimer.current);
    setConfirmingId(null);
  };
  const commitRename = (edit: { id: string; value: string }): void => {
    setEditing(null);
    if (cancelled.current) return;
    const title = edit.value.trim();
    const run = studio.runs.find((r) => r.id === edit.id);
    // Empty or unchanged commits cancel the edit — renameRun itself throws on
    // empty (fail-fast), so the UI never feeds it one. Unchanged also covers
    // the Enter-then-blur double fire: the first commit already updated title.
    if (!run || title === "" || title === run.title) return;
    void studio.renameRun(edit.id, title);
  };

  return (
    // Any click that bubbles here (row select, other buttons, empty space)
    // resets an armed "Delete?" — the action buttons stop propagation.
    <aside className="sidebar" onClick={disarmDelete}>
      <button className="btn newtask" onClick={onNew}>
        ＋ New task
      </button>
      <div className="sbh sbh-row">
        <span>Tasks</span>
        <button className="sb-collapse" onClick={onCollapse} title="Collapse sidebar" aria-label="Collapse sidebar">
          ‹
        </button>
      </div>
      <div className="threads">
        {studio.runs.length === 0 && <div className="hint sm">No tasks yet.</div>}
        {studio.runs.map((r) => (
          <div
            key={r.id}
            className={"thread " + (studio.activeRunId === r.id ? "sel" : "")}
            onClick={() => studio.selectRun(r.id)}
          >
            <div className="row">
              {r.status === "running" && <span className="run-dot" title="Running" />}
              {editing?.id === r.id ? (
                <input
                  className="ttl-edit"
                  value={editing.value}
                  autoFocus
                  onChange={(e) => setEditing({ id: r.id, value: e.target.value })}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename(editing);
                    else if (e.key === "Escape") {
                      cancelled.current = true;
                      setEditing(null);
                    }
                  }}
                  onBlur={() => commitRename(editing)}
                />
              ) : (
                <span className="ttl">{r.title}</span>
              )}
              <span
                className={"row-actions" + (confirmingId === r.id ? " open" : "")}
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  className="rowbtn"
                  title="Rename task"
                  aria-label="Rename task"
                  onClick={() => {
                    cancelled.current = false;
                    disarmDelete();
                    setEditing({ id: r.id, value: r.title });
                  }}
                >
                  ✎
                </button>
                {r.status === "running" ? (
                  // A running run can't be deleted (Studio.deleteRun refuses as
                  // a backstop, but its log line isn't visible while a run is
                  // active) — so disable the affordance itself and say why.
                  // This branch outranks an armed "Delete?", so a turn starting
                  // while the confirm is armed swaps it out on the next render.
                  <button
                    className="rowbtn"
                    title="Stop the task first, then delete it"
                    aria-label="Delete task (stop it first)"
                    disabled
                  >
                    ×
                  </button>
                ) : confirmingId === r.id ? (
                  <button
                    className="rowbtn danger"
                    title="Click again to delete"
                    onClick={() => {
                      disarmDelete();
                      void studio.deleteRun(r.id);
                    }}
                  >
                    Delete?
                  </button>
                ) : (
                  <button
                    className="rowbtn"
                    title="Delete task"
                    aria-label="Delete task"
                    onClick={() => armDelete(r.id)}
                  >
                    ×
                  </button>
                )}
              </span>
            </div>
            <div className="prev">{previewOf(r)}</div>
          </div>
        ))}
      </div>
      <div className="sbf">
        {/* The mounted state itself (dot + folder name) lives in
            FolderSyncControls' header — the footer only adds the affordances
            that widget doesn't carry: reconnecting a pending mount, or opening
            a folder when none is remembered. */}
        {!studio.mount &&
          (studio.pendingMount ? (
            <button className="btn ghost" onClick={() => void studio.reconnectMount()}>
              Reconnect 📁 {studio.mountName}
            </button>
          ) : (
            <button className="btn ghost" onClick={onOpenFolder}>
              Open folder
            </button>
          ))}
        {studio.mountName && <FolderSyncControls studio={studio} />}
        <div className="rt">
          <span className="dot on" /> runtime live
        </div>
      </div>
    </aside>
  );
}

function previewOf(r: Run): string {
  const last = r.trace[r.trace.length - 1];
  return last ? last.text.slice(0, 60) : r.task.slice(0, 60);
}
