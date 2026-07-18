import { useEffect, useRef, useState } from "react";
import type { Studio } from "../lib/studio.js";
import { DiffPanel } from "./DiffPanel.js";
import { FilePanel } from "./FilePanel.js";
import { TerminalPanel } from "./TerminalPanel.js";
import { PreviewPanel } from "./PreviewPanel.js";
import { ProcessPanel } from "./ProcessPanel.js";
import { LogPanel } from "./LogPanel.js";

type Tab = "Diff" | "Files" | "Terminal" | "Preview" | "Processes" | "Log";

const MAIN_TABS: Tab[] = ["Diff", "Files", "Terminal", "Preview"];

/** Tab host for the right-hand review region: diff, files, terminal, preview, processes. */
export function ReviewPane({ studio }: { studio: Studio }) {
  const [tab, setTab] = useState<Tab>(
    (studio.activeRun?.changes?.length ?? 0) > 0 ? "Diff" : "Terminal",
  );

  const run = studio.activeRun;

  // True while the agent's open_preview has claimed the tab for the CURRENT
  // turn. run.changes is only assigned at the turn's settle (Studio's finally
  // block), typically a LATER commit than the mid-turn open_preview nonce bump
  // — without this, the settle's diff auto-select would yank the user off the
  // preview the agent just showed them.
  const previewedThisTurn = useRef(false);

  // Scope the claim to the thread it was made on: switching threads restores
  // the normal diff auto-select. Declared before the diff effect so the clear
  // lands first when both fire in one commit (React runs effects in order).
  const activeRunId = run?.id;
  useEffect(() => {
    previewedThisTurn.current = false;
  }, [activeRunId]);

  // ...and to a single turn: the next turn starting releases the claim. Only
  // the false->true edge clears — the true->false edge IS the settle, where
  // the claim must still hold.
  const running = studio.running;
  useEffect(() => {
    if (running) previewedThisTurn.current = false;
  }, [running]);

  // Auto-select the Diff tab whenever the active run settles with changes, so
  // DiffPanel mounts and its markReviewed effect fires (review -> done). Keyed
  // on run id + change count so it doesn't yank the user off a tab they picked
  // manually on unrelated re-renders. Skipped when open_preview claimed this
  // turn: the run then simply stays "review" until the user opens Diff.
  useEffect(() => {
    if (run && run.changes.length > 0 && !previewedThisTurn.current) setTab("Diff");
  }, [run?.id, run?.changes.length]);

  // Follow the agent's open_preview tool: a bumped previewRequest.nonce means
  // "show the user the running app", so switch to the Preview tab and claim
  // the turn (see above). Declared AFTER the diff auto-select so that in the
  // rare same-commit case (changes AND nonce land together) this setTab runs
  // last and Preview still wins. The ref seeds with the mount-time nonce so a
  // stale pre-existing request can't yank a freshly mounted pane to Preview.
  const previewNonce = studio.previewRequest?.nonce;
  const seenPreviewNonce = useRef(previewNonce);
  useEffect(() => {
    if (previewNonce === undefined || previewNonce === seenPreviewNonce.current) return;
    seenPreviewNonce.current = previewNonce;
    previewedThisTurn.current = true;
    setTab("Preview");
  }, [previewNonce]);

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
        <button className={"tab muted" + (tab === "Log" ? " sel" : "")} onClick={() => setTab("Log")}>
          Log
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
        {tab === "Log" && <LogPanel studio={studio} />}
      </div>
    </div>
  );
}
