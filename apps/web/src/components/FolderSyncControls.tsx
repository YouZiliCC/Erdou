import { useState, useSyncExternalStore } from "react";
import type { Studio } from "../lib/studio.js";

/** Explicit MANUAL folder-sync controls, shown ALONGSIDE the background
 *  auto-sync (never replacing it): one button per direction so the user can
 *  force a pull or a push on demand, plus a folder swap. Wired entirely through
 *  `studio` (pullFolderNow / pushFolderNow / reselectFolder); a sibling lane
 *  mounts this in the sidebar. Self-contained: one `busy` latch disables all
 *  three while an op runs, and a single live-region line reports the result. */
export function FolderSyncControls({ studio }: { studio: Studio }) {
  const mounted = useSyncExternalStore(
    (cb) => studio.subscribe(cb),
    () => studio.mount !== null,
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
      <div className="fs-row">
        <button
          className="btn ghost"
          disabled={busy || !mounted}
          onClick={() =>
            void run("Pulling…", async () => {
              const n = await studio.pullFolderNow();
              return `Pulled ${n} file${n === 1 ? "" : "s"} from disk.`;
            })
          }
        >
          Pull from disk ↓
        </button>
        <button
          className="btn ghost"
          disabled={busy || !mounted}
          onClick={() =>
            void run("Pushing…", async () => {
              await studio.pushFolderNow();
              return "Pushed workspace to disk.";
            })
          }
        >
          Push to disk ↑
        </button>
        <button
          className="btn ghost"
          disabled={busy}
          onClick={() =>
            void run("Selecting…", async () => {
              const ok = await studio.reselectFolder();
              return ok ? `Now synced to ${studio.mountName}.` : "Folder unchanged.";
            })
          }
        >
          Re-select folder
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
