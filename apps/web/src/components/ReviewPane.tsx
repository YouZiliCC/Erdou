import { useEffect, useState } from "react";
import type { Studio } from "../lib/studio.js";
import { DiffPanel } from "./DiffPanel.js";
import { FilePanel } from "./FilePanel.js";
import { TerminalPanel } from "./TerminalPanel.js";
import { PreviewPanel } from "./PreviewPanel.js";
import { ProcessPanel } from "./ProcessPanel.js";

type Tab = "Diff" | "Files" | "Terminal" | "Preview" | "Processes";

const MAIN_TABS: Tab[] = ["Diff", "Files", "Terminal", "Preview"];

/** Tab host for the right-hand review region: diff, files, terminal, preview, processes. */
export function ReviewPane({ studio }: { studio: Studio }) {
  const [tab, setTab] = useState<Tab>(
    (studio.activeRun?.changes?.length ?? 0) > 0 ? "Diff" : "Terminal",
  );

  const run = studio.activeRun;

  // Auto-select the Diff tab whenever the active run finishes with changes, so
  // DiffPanel mounts and its markReviewed effect fires (review -> done). Keyed
  // on run id + change count so it doesn't yank the user off a tab they picked
  // manually on unrelated re-renders.
  useEffect(() => {
    if (run && run.changes.length > 0) setTab("Diff");
  }, [run?.id, run?.changes.length]);

  return (
    <div className="review-pane">
      <div className="tabs">
        {MAIN_TABS.map((t) => (
          <button key={t} className={"tab" + (tab === t ? " sel" : "")} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
        <span className="sp" />
        <button className={"tab muted" + (tab === "Processes" ? " sel" : "")} onClick={() => setTab("Processes")}>
          Processes
        </button>
      </div>
      <div className="tab-body">
        {tab === "Diff" &&
          (run ? <DiffPanel run={run} studio={studio} /> : <div className="hint">No active run selected.</div>)}
        {tab === "Files" && <FilePanel studio={studio} />}
        {/* Terminal and Preview stay MOUNTED across tab switches (hidden, not
            unmounted) — both own expensive live state that conditional
            rendering would destroy: leaving Terminal would dispose the VM
            PtySession (kills ptybridge → "reconnect" on return), and leaving
            Preview would tear down the running iframe (reload on return). The
            wrapper carries `flex:1; min-height:0` via `.tab-body > *`; the
            panel's own `height:100%` fills it. `display:none` while inactive
            drops it from flex layout without unmounting, so no effect re-runs.
            The cheap panels (Diff/Files/Processes) stay conditional. */}
        <div style={{ display: tab === "Terminal" ? undefined : "none" }}>
          <TerminalPanel studio={studio} />
        </div>
        <div style={{ display: tab === "Preview" ? undefined : "none" }}>
          <PreviewPanel studio={studio} />
        </div>
        {tab === "Processes" && <ProcessPanel studio={studio} />}
      </div>
    </div>
  );
}
