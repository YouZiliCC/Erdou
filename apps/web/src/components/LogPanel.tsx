import { useEffect, useRef } from "react";
import type { Studio } from "../lib/studio.js";
import { ArtifactCard } from "./Conversation.js";
import type { TraceLine } from "../lib/studio.js";

/** The system channel's home: the full `studio.systemLog` (mount/restore/sync
 *  chatter plus errors), newest at the bottom. Auto-scroll stays pinned to the
 *  bottom like the terminal — new lines keep the view at the tail unless the
 *  user has scrolled up to read history. Lines reuse Conversation's exported
 *  `SystemLine`/`ArtifactCard` (shared `.sysline`/`.artifact` styling); a
 *  kind:"artifact" entry here is a no-run project export
 *  (studio.exportProject) and this card is that flow's download affordance. */
export function LogPanel({ studio }: { studio: Studio }) {
  const log = studio.systemLog;
  const ref = useRef<HTMLDivElement>(null);
  // Pinned until the user scrolls away from the bottom; scrolling back re-pins.
  const pinned = useRef(true);

  useEffect(() => {
    if (pinned.current) ref.current?.scrollTo({ top: ref.current.scrollHeight });
    // Keyed on the ARRAY, not log.length: at SYSTEM_LOG_LIMIT the slice keeps
    // the length constant while content still shifts, so a length key would
    // stop firing exactly when the log is busiest. logSystem always replaces
    // the array, so the reference changes on every append — and the pinned
    // guard above keeps this from yanking a reader who scrolled up.
  }, [log]);

  return (
    <div className="log-panel-host">
      {log.length > 0 && (
        <div className="log-head">
          <button className="btn ghost" onClick={() => studio.clearSystemLog()}>
            Clear
          </button>
        </div>
      )}
      <div
        className="log-panel"
        ref={ref}
        onScroll={() => {
          const el = ref.current;
          if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
        }}
      >
        {log.length === 0 && <div className="hint">No system messages yet.</div>}
        {log.map((line) =>
          line.kind === "artifact" ? (
            <ArtifactCard key={line.id} line={line} studio={studio} />
          ) : (
            <TimedLine key={line.id} line={line} />
          ),
        )}
      </div>
    </div>
  );
}

/** One Log-tab line: wall-clock time + content (the user asked for time, not a
 *  status dot, in this surface; the sysbar/empty-state keep SystemLine's dot).
 *  `ts` is epoch ms (Studio.line stamps Date.now()); local HH:MM:SS. */
function TimedLine({ line }: { line: TraceLine }) {
  const d = new Date(line.ts);
  const two = (n: number) => String(n).padStart(2, "0");
  const t = `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  return (
    <div className={`sysline ${line.kind === "error" ? "err" : ""}`}>
      <span className="log-time">{t}</span>
      {line.text}
      {line.detail && line.detail !== line.text && <span className="detail"> — {line.detail}</span>}
    </div>
  );
}
