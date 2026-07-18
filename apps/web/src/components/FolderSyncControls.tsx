import { useState, useSyncExternalStore } from "react";
import type { Studio } from "../lib/studio.js";

/** Explicit MANUAL folder-sync controls, shown ALONGSIDE the background
 *  auto-sync (never replacing it). Layout: a compact header with the mount
 *  state (dot + folder name) and a demoted text-style "Re-select folder…",
 *  then TWO direction buttons that carry their semantics visibly — both are
 *  TRUE MIRRORS (deletions included; the tooltips say so), while the background
 *  auto-sync stays additive/merge-like. Wired entirely through `studio`
 *  (pullFolderNow / pushFolderNow / reselectFolder); a sibling lane mounts this
 *  in the sidebar footer. Self-contained: one `busy` latch disables all three
 *  while an op runs, and a single live-region line always reports counts. */
export function FolderSyncControls({ studio }: { studio: Studio }) {
  const mounted = useSyncExternalStore(
    (cb) => studio.subscribe(cb),
    () => studio.mount !== null,
  );
  const mountName = useSyncExternalStore(
    (cb) => studio.subscribe(cb),
    () => studio.mountName,
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  async function run(pending: string, op: () => Promise<string>): Promise<void> {
    setBusy(true);
    setStatus(pending);
    try {
      setStatus(await op());
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="folder-sync">
      <div className="fs-head">
        <span
          className="fs-mount"
          title={mounted ? `Synced to local folder "${mountName}"` : "Folder not connected"}
        >
          <span className={mounted ? "dot on" : "dot"} />
          <span className="fs-name">{mountName ?? "No folder"}</span>
        </span>
        <button
          className="fs-reselect"
          disabled={busy}
          onClick={() =>
            void run("Selecting…", async () => {
              const ok = await studio.reselectFolder();
              return ok ? `Now synced to ${studio.mountName}.` : "Folder unchanged.";
            })
          }
        >
          Re-select folder…
        </button>
      </div>
      <div className="fs-row">
        <button
          className="btn ghost fs-dir"
          disabled={busy || !mounted}
          title="TRUE MIRROR, disk → workspace: load every folder file AND delete workspace files absent on disk (.git/node_modules/.erdou and image-owned VM dirs untouched). The background auto-sync stays additive/merge-like — only these two buttons delete."
          onClick={() =>
            void run("Pulling…", async () => {
              const r = await studio.pullFolderNow();
              if (!r) return "No folder mounted.";
              return `Pulled: ${r.loaded} loaded, ${r.deleted.length} deleted.`;
            })
          }
        >
          <span className="fs-verb">⬇ Pull</span>
          <span className="fs-sem">disk → workspace</span>
        </button>
        <button
          className="btn ghost fs-dir"
          disabled={busy || !mounted}
          title="TRUE MIRROR, workspace → disk: write every workspace file AND delete disk files absent from the workspace (.git/node_modules/.erdou untouched). Files edited on disk since the last sync are skipped as conflicts — Pull to resolve. The background auto-sync stays additive/merge-like — only these two buttons delete."
          onClick={() =>
            void run("Pushing…", async () => {
              const r = await studio.pushFolderNow();
              if (!r) return "No folder mounted.";
              const n = r.conflicts.length;
              const counts = `${r.written.length} written, ${r.deleted.length} deleted, ${n} conflict${n === 1 ? "" : "s"} skipped`;
              return n > 0 ? `Pushed: ${counts} — ⬇ Pull to resolve.` : `Pushed: ${counts}.`;
            })
          }
        >
          <span className="fs-verb">⬆ Push</span>
          <span className="fs-sem">workspace → disk</span>
        </button>
      </div>
      {status && (
        <div className="fs-status hint sm" aria-live="polite">
          {status}
        </div>
      )}
    </div>
  );
}
