import { useEffect, useRef } from "react";
import type { TraceLine, TraceKind } from "../lib/studio.js";

const GLYPH: Record<TraceKind, string> = {
  user: "»",
  thought: "*",
  tool: "▸",
  result: "←",
  done: "◆",
  system: "·",
  error: "!",
};

const LABEL: Record<TraceKind, string> = {
  user: "task",
  thought: "agent",
  tool: "call",
  result: "",
  done: "done",
  system: "sys",
  error: "error",
};

export function TraceTape({ trace, running }: { trace: TraceLine[]; running: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [trace.length]);

  return (
    <div className="tape" ref={ref}>
      {trace.length === 0 ? (
        <div className="empty">
          <b>Nothing running yet.</b>
          <br />
          Give the agent a task above. It reads and writes files, runs shell commands, and verifies its work — every
          step it takes to operate the runtime shows up here as a live trace.
        </div>
      ) : (
        trace.map((line, i) => {
          const last = i === trace.length - 1;
          const resultClass = line.kind === "result" ? (line.ok ? "ok" : "fail") : "";
          return (
            <div
              key={line.id}
              className={`line k-${line.kind} ${resultClass} ${last ? "latest" : ""} ${
                running && last ? "running" : ""
              }`}
            >
              <span className="ts">{formatTime(line.ts)}</span>
              <span className="glyph">{GLYPH[line.kind]}</span>
              <span className="body">
                {LABEL[line.kind].length > 0 && <span className="label">{LABEL[line.kind]} </span>}
                {line.text}
                {line.detail && line.detail !== line.text && <span className="detail">{clip(line.detail)}</span>}
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}

function formatTime(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 8);
}
function clip(s: string): string {
  return s.length > 1400 ? s.slice(0, 1400) + "…" : s;
}
