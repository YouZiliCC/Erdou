import { useState } from "react";
export function Composer({
  running, replying, mode, onModeChange, onRun,
}: {
  running: boolean;
  /** A thread is selected, so the next send replies into it instead of starting a new one. */
  replying: boolean;
  mode: "auto"|"confirm";
  onModeChange: (m:"auto"|"confirm")=>void;
  onRun: (task:string)=>void;
}) {
  const [text, setText] = useState("");
  function submit() { const t = text.trim(); if (!t || running) return; setText(""); onRun(t); }
  return (
    <div className="composer">
      <textarea value={text} placeholder={replying ? "Reply…" : "Describe a task…  @ files"} disabled={running}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }} />
      <div className="composer-bar">
        <select className="mode" value={mode} onChange={(e) => onModeChange(e.target.value as "auto"|"confirm")}>
          <option value="auto">Auto</option>
          <option value="confirm">Confirm</option>
        </select>
        <button className="btn primary run" disabled={running || text.trim().length===0} onClick={submit}>
          {running ? "Working…" : "Run ⌘⏎"}
        </button>
      </div>
    </div>
  );
}
