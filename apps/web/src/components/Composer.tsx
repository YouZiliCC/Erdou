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

/** The keydown shape the submit decision needs — satisfied by a React
 *  `KeyboardEvent<HTMLTextAreaElement>` (structural, so it is unit-testable
 *  with a plain object, matching the panel-logic-extraction pattern). */
export interface ComposerKey {
  key: string;
  shiftKey: boolean;
  nativeEvent: { isComposing: boolean; keyCode: number };
}

/**
 * Whether a composer keydown should SEND the message. Enter sends; Shift+Enter
 * inserts a newline (returns false — the textarea's default runs). A keystroke
 * mid-IME-composition — confirming a Chinese/Japanese candidate with Enter —
 * must NEVER send: `isComposing` marks it, and browsers predating that flag
 * report `keyCode` 229 for a composing key. Non-Enter keys always return false.
 */
export function isSubmitKey(e: ComposerKey): boolean {
  if (e.key !== "Enter" || e.shiftKey) return false;
  if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return false;
  return true;
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
      {/* NOT disabled while running: you can compose your next message while the
          agent works. submit() still refuses to send mid-run (Studio.startRun
          rejects a concurrent run), so the text just waits until the run ends. */}
      <textarea ref={taRef} value={text} placeholder={replying ? "Reply…  (Shift+Enter for a new line)" : "Describe a task…  @ files  (Shift+Enter for a new line)"}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends, Shift+Enter is a newline, a composing Enter completes
          // the IME candidate (see isSubmitKey). preventDefault so sending never
          // leaves a stray newline behind in the (about-to-be-cleared) textarea.
          if (isSubmitKey(e)) {
            e.preventDefault();
            submit();
          }
        }} />
      <div className="composer-bar">
        <Select value={mode} options={MODE_OPTIONS} onChange={onModeChange} ariaLabel="Run mode" />
        {running && canStop ? (
          <button className="btn run" disabled={stopping} onClick={onStop}>{stopping ? "Stopping…" : "Stop"}</button>
        ) : (
          <button className="btn primary run" disabled={running || text.trim().length===0} onClick={submit}>
            {running ? "Working…" : "Run ⏎"}
          </button>
        )}
      </div>
    </div>
  );
}
