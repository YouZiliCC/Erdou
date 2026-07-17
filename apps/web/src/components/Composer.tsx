import { useEffect, useRef, useState } from "react";
import { Select } from "./ui/Select.js";

const MODE_OPTIONS: { value: "auto" | "confirm"; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "confirm", label: "Confirm" },
];

/** External request to seed the composer text (e.g. an empty-state example
 *  chip). `nonce` distinguishes repeat clicks of the same text; 0 = none yet. */
export interface ComposerPrefill {
  text: string;
  nonce: number;
}

export function Composer({
  running, canStop, stopping, replying, mode, prefill, onModeChange, onRun, onStop,
}: {
  running: boolean;
  /** True when what's running is a stoppable agent run (not e.g. a kernel switch). */
  canStop: boolean;
  /** Stop was clicked but the run hasn't reached its abort checkpoint yet (an
   *  in-flight model call can take a while) — show "Stopping…", disabled. */
  stopping: boolean;
  /** A thread is selected, so the next send replies into it instead of starting a new one. */
  replying: boolean;
  mode: "auto"|"confirm";
  prefill: ComposerPrefill;
  onModeChange: (m:"auto"|"confirm")=>void;
  onRun: (task:string)=>void;
  onStop: ()=>void;
}) {
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (prefill.nonce === 0) return;
    setText(prefill.text);
    taRef.current?.focus();
    // Only a new prefill click (nonce bump) may overwrite what the user typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill.nonce]);
  function submit() { const t = text.trim(); if (!t || running) return; setText(""); onRun(t); }
  return (
    <div className="composer">
      <textarea ref={taRef} value={text} placeholder={replying ? "Reply…" : "Describe a task…  @ files"} disabled={running}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }} />
      <div className="composer-bar">
        <Select value={mode} options={MODE_OPTIONS} onChange={onModeChange} ariaLabel="Run mode" />
        {running && canStop ? (
          <button className="btn run" disabled={stopping} onClick={onStop}>{stopping ? "Stopping…" : "Stop"}</button>
        ) : (
          <button className="btn primary run" disabled={running || text.trim().length===0} onClick={submit}>
            {running ? "Working…" : "Run ⌘⏎"}
          </button>
        )}
      </div>
    </div>
  );
}
