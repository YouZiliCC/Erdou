import type { Studio, Run } from "../lib/studio.js";
import { FolderSyncControls } from "./FolderSyncControls.js";

/** Left rail: the list of agent "task threads" with live status chips. */
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
  return (
    <aside className="sidebar">
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
              <span className="ttl">{r.title}</span>
              <span className={"chip " + r.status}>{r.status}</span>
            </div>
            <div className="prev">{previewOf(r)}</div>
          </div>
        ))}
      </div>
      <div className="sbf">
        {studio.mount ? (
          <div>📁 {studio.mountName} · synced</div>
        ) : studio.pendingMount ? (
          <button className="btn ghost" onClick={() => void studio.reconnectMount()}>
            Reconnect 📁 {studio.mountName}
          </button>
        ) : (
          <button className="btn ghost" onClick={onOpenFolder}>
            Open folder
          </button>
        )}
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
