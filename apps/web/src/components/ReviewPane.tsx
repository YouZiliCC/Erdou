import { useState } from "react";
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
        {tab === "Terminal" && <TerminalPanel studio={studio} />}
        {tab === "Preview" && <PreviewPanel studio={studio} />}
        {tab === "Processes" && <ProcessPanel studio={studio} />}
      </div>
    </div>
  );
}
