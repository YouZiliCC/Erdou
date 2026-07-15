import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { Studio, TraceLine } from "../lib/studio.js";
import { ApprovalPrompt } from "./ApprovalPrompt.js";

const EXAMPLES = ["Open a local folder", "Scaffold a Vite app", "Write & run a Python script"];

/** Center column: the active run's transcript, or a first-run empty state. */
export function Conversation({ studio }: { studio: Studio }) {
  const run = studio.activeRun;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [run?.id, run?.trace.length, studio.systemLog.length, studio.pendingApproval]);

  if (!run) {
    return (
      <div className="tr empty" ref={ref}>
        <div className="empty-hero">
          <h4>Describe a task to begin</h4>
          <p>
            The agent operates a full browser OS — filesystem, shell, Python/WASI, in-browser build &amp; git. No
            install, your data never leaves the tab.
          </p>
          <div className="ex">
            {EXAMPLES.map((e) => (
              <span key={e}>{e}</span>
            ))}
          </div>
        </div>
        {studio.systemLog.length > 0 && (
          <div className="syslog">
            {studio.systemLog.map((line) => (
              <SystemLine key={line.id} line={line} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="tr" ref={ref}>
      <div className="msg">
        <div className="who">you</div>
        <div className="you">{run.task}</div>
      </div>
      {renderTrace(run.trace)}
      {studio.pendingApproval && run.status === "running" && <ApprovalPrompt studio={studio} />}
    </div>
  );
}

function renderTrace(trace: TraceLine[]) {
  const blocks: ReactNode[] = [];
  for (let i = 0; i < trace.length; i++) {
    const line = trace[i];
    if (!line) continue;
    if (line.kind === "tool") {
      const next = trace[i + 1];
      const result = next?.kind === "result" ? next : undefined;
      blocks.push(<ToolBlock key={line.id} call={line} result={result} />);
      if (result) i++;
      continue;
    }
    blocks.push(<TraceBlock key={line.id} line={line} />);
  }
  return blocks;
}

function TraceBlock({ line }: { line: TraceLine }) {
  switch (line.kind) {
    case "user":
      return (
        <div className="msg">
          <div className="who">you</div>
          <div className="you">{line.text}</div>
        </div>
      );
    case "thought":
      return (
        <div className="msg">
          <div className="who">agent · thinking</div>
          <div className="think">{line.text}</div>
        </div>
      );
    case "result":
      // Only reached for a result with no preceding tool call.
      return <ToolBlock result={line} />;
    case "done":
      return <div className="done">◆ {line.text}</div>;
    case "error":
      return <div className="err">✖ {line.text}</div>;
    case "system":
      return <SystemLine line={line} />;
  }
}

function ToolBlock({ call, result }: { call?: TraceLine; result?: TraceLine }) {
  const status = result ? (result.ok ? "ok" : "fail") : "busy";
  return (
    <div className="tool-block">
      <div className="tool">
        <span className={`dot ${status}`} />
        <span className="name">{call ? call.text : result?.text}</span>
        {call?.detail && <span className="arg">{call.detail}</span>}
      </div>
      {call && result && (
        <div className={`tool-result ${status === "fail" ? "fail" : ""}`}>{clip(result.detail ?? result.text)}</div>
      )}
    </div>
  );
}

function SystemLine({ line }: { line: TraceLine }) {
  return (
    <div className={`sysline ${line.kind === "error" ? "err" : ""}`}>
      <span className="dot" />
      {line.text}
      {line.detail && line.detail !== line.text && <span className="detail"> — {line.detail}</span>}
    </div>
  );
}

function clip(s: string): string {
  return s.length > 1400 ? s.slice(0, 1400) + "…" : s;
}
