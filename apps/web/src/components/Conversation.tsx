import { useEffect, useRef, useState } from "react";
import type { ReactNode, SVGProps } from "react";
import { parseArtifactDetail, truncate, type Studio, type TraceLine } from "../lib/studio.js";
import { parseSubagentDetail, type SubagentDetail } from "../lib/delegate.js";
import { formatByteSize } from "../lib/project-zip.js";
import { ApprovalPrompt } from "./ApprovalPrompt.js";
import { Chevron } from "./ui/icons.js";

const EXAMPLES = [
  "Build a small Python HTTP server and preview it",
  "Scaffold a Vite app",
  "Write & run a Python script",
];

/** How many recent system-channel errors stay pinned below the transcript once a run is open. */
const SYSTEM_ERROR_STRIP_LIMIT = 3;

/** Center column: the active run's transcript, or a first-run empty state. */
export function Conversation({ studio, onExample }: { studio: Studio; onExample: (task: string) => void }) {
  const run = studio.activeRun;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [run?.id, run?.trace.length, run?.status, studio.pendingApproval]);

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
              <button type="button" key={e} onClick={() => onExample(e)}>
                {e}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // The system channel (folder-sync failures, mount/kernel errors) is invisible
  // once a run is selected — pin its recent errors in a strip so data-safety
  // messages like "Failed to sync to local folder" can't be missed (audit B3).
  const systemErrors = studio.systemLog.filter((l) => l.kind === "error").slice(-SYSTEM_ERROR_STRIP_LIMIT);

  return (
    <>
      <div className="tr" ref={ref}>
        <div className="msg">
          <div className="who">you</div>
          <div className="you">{run.task}</div>
        </div>
        {renderTrace(run.trace, studio)}
        {run.status === "running" && !studio.pendingApproval && (
          <ActivityIndicator lastLine={run.trace[run.trace.length - 1]} />
        )}
        {studio.pendingApproval && run.status === "running" && <ApprovalPrompt studio={studio} />}
      </div>
      {systemErrors.length > 0 && (
        <div className="sysbar" role="alert">
          {systemErrors.map((line) => (
            <SystemLine key={line.id} line={line} />
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Live-activity pulse pinned to the bottom of a running run's transcript, so
 * "thinking" is visibly different from "hung". A `tool` trace line's result
 * arrives as a separate later `result` line, so a trailing `tool` line means
 * that tool is still in flight — name it; otherwise the model is between
 * events ("thinking…"). Hidden while an approval prompt is up (the agent is
 * waiting on the user, not working) and gone the moment the run leaves
 * "running".
 */
function ActivityIndicator({ lastLine }: { lastLine: TraceLine | undefined }) {
  const label = lastLine?.kind === "tool" ? `running ${lastLine.text}…` : "thinking…";
  return (
    <div className="activity" aria-live="polite">
      <span className="activity-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {label}
    </div>
  );
}

function renderTrace(trace: TraceLine[], studio: Studio) {
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
    // Threads persisted BEFORE the append-time dedupe (studio.onAgentEvent's
    // "done" case) carry the model's final text twice — a thought line followed
    // by a done line with the same string. Suppress that echo defensively here
    // so old threads render honestly too; a done line that says something new
    // ("Stopped by the user.") still renders.
    if (line.kind === "done" && trace[i - 1]?.text.trim() === line.text.trim()) continue;
    blocks.push(<TraceBlock key={line.id} line={line} studio={studio} />);
  }
  return blocks;
}

function TraceBlock({ line, studio }: { line: TraceLine; studio: Studio }) {
  switch (line.kind) {
    case "user":
      return (
        <div className="msg">
          <div className="who">you</div>
          <div className="you">{line.text}</div>
        </div>
      );
    case "thought":
      // The model's words ARE the conversation (Claude-Code style): a plain
      // agent text block interleaved between tool blocks — no "agent ·
      // thinking" label, no dimmed monologue framing. No who marker either:
      // the user's turns are already visually distinct bubbles (.who/.you), so
      // the you/agent alternation stays legible without one. The TraceKind
      // stays "thought" so persisted threads round-trip unchanged.
      return <div className="msg agent">{line.text}</div>;
    case "result":
      // Only reached for a result with no preceding tool call.
      return <ToolBlock result={line} />;
    case "done":
      return <div className="done">◆ {line.text}</div>;
    case "error":
      // The gateway's real failure (e.g. "openai-compatible chat failed: 401
      // {invalid_api_key}") lands in `detail` — surface it, not just the
      // generic "Agent stopped" text (audit B1).
      return (
        <div className="err">
          ✖ {line.text}
          {line.detail && line.detail !== line.text && <pre className="err-detail">{line.detail}</pre>}
        </div>
      );
    case "system":
      return <SystemLine line={line} />;
    case "artifact":
      return <ArtifactCard line={line} studio={studio} />;
    case "subagent":
      return <SubagentCard line={line} studio={studio} />;
  }
}

/** Header status label per sub-agent state (SubagentCard). */
const SUBAGENT_STATUS_LABEL: Record<SubagentDetail["status"], string> = {
  running: "running…",
  done: "done",
  max_steps: "hit step limit",
  aborted: "stopped",
  error: "failed",
  conflict: "conflict — changes rejected",
};

/**
 * A kind:"subagent" trace line — one delegate sub-agent as a collapsible card
 * (ToolBlock-style header: status dot, role, status + step count, chevron).
 * The body shows the child's task brief and its OWN nested trace, rendered
 * through the same `renderTrace` building blocks as the parent transcript
 * (the nested lines are plain TraceLines carried in the detail JSON, so they
 * persist and re-render after a reload). A conflict/error summary is surfaced
 * explicitly — a rejected merge must not be discoverable only by expanding.
 */
export function SubagentCard({ line, studio }: { line: TraceLine; studio: Studio }) {
  const [open, setOpen] = useState(false);
  const meta = parseSubagentDetail(line.detail);
  if (!meta) return <div className="err">✖ Broken sub-agent card — its stored payload is unreadable.</div>;
  const dot = meta.status === "running" ? "busy" : meta.status === "done" ? "ok" : "fail";
  const steps = meta.steps > 0 ? ` · ${meta.steps} ${meta.steps === 1 ? "step" : "steps"}` : "";
  return (
    <div className="subagent">
      <button type="button" className="tool subagent-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={`dot ${dot}`} />
        <span className="name">sub-agent · {meta.role}</span>
        <span className="subagent-status">
          {SUBAGENT_STATUS_LABEL[meta.status]}
          {steps}
        </span>
        <Chevron className={`chev ${open ? "open" : ""}`} />
      </button>
      {open && (
        <div className="subagent-body">
          <div className="subagent-task">{meta.task}</div>
          {renderTrace(meta.trace, studio)}
        </div>
      )}
      {(meta.status === "conflict" || meta.status === "error") && meta.summary && (
        <div className="err subagent-summary">✖ {meta.summary}</div>
      )}
    </div>
  );
}

/**
 * A kind:"artifact" trace line — a project-export download card. The blob only
 * lives in `studio.exports` (session memory); the trace line persists. So a
 * present exportId renders a live Download button on the object URL, and an
 * absent one (reloaded browser, or replaced by a newer export) renders the
 * same card disabled with an honest "expired" note. No re-generate button —
 * the thread's reply box already covers asking for a fresh zip.
 */
export function ArtifactCard({ line, studio }: { line: TraceLine; studio: Studio }) {
  const meta = parseArtifactDetail(line.detail);
  if (!meta) return <div className="err">✖ Broken export card — its stored payload is unreadable.</div>;
  const entry = studio.exports.get(meta.exportId);
  return (
    <div className={`artifact${entry ? "" : " expired"}`}>
      <ZipIcon className="artifact-ico" />
      <div className="artifact-meta">
        <div className="artifact-name">{meta.name}</div>
        <div className="artifact-sub">
          {formatByteSize(meta.byteSize)} · {meta.fileCount} {meta.fileCount === 1 ? "file" : "files"}
        </div>
        {!entry && (
          <div className="artifact-note">
            download expired — this zip did not survive the browser restart; ask the agent to package the project
            again
          </div>
        )}
      </div>
      {entry && (
        <a className="btn primary artifact-dl" href={entry.url} download={meta.name}>
          Download
        </a>
      )}
    </div>
  );
}

/** A zip archive: a document with the zipper teeth down the middle. Local to
 *  this card (ui/icons.tsx carries only the file-tree set). */
export function ZipIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      <path d="M4 1.5h5l3 3v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z" />
      <path d="M6.5 3h1M7.5 5h1M6.5 7h1M7.5 9h1" />
      <path d="M7 11h2v2H7z" />
    </svg>
  );
}

/**
 * A tool call (+ its paired result, if any) as a collapsible block: collapsed
 * shows one header line (status dot, tool name, truncated arg/result summary,
 * chevron); expanded reveals the full args and the full result output. Each
 * block owns its own open/closed state, seeded closed — the surrounding list
 * already keys each `ToolBlock` instance by the tool line's id (see
 * `renderTrace`/`TraceBlock`), so that state naturally resets per block.
 */
function ToolBlock({ call, result }: { call?: TraceLine; result?: TraceLine }) {
  const status = result ? (result.ok ? "ok" : "fail") : "busy";
  const [open, setOpen] = useState(false);
  const summary = call?.detail || result?.text || "";
  return (
    <div className="tool-block">
      <button type="button" className="tool" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={`dot ${status}`} />
        <span className="name">{call ? call.text : result?.text}</span>
        {summary && <span className="arg">{truncate(summary, 60)}</span>}
        <Chevron className={`chev ${open ? "open" : ""}`} />
      </button>
      {open && (
        <div className="tool-detail">
          {call?.detail && <div className="tool-args">{call.detail}</div>}
          {call && result && (
            <div className={`tool-result ${status === "fail" ? "fail" : ""}`}>{result.detail ?? result.text}</div>
          )}
        </div>
      )}
    </div>
  );
}

export function SystemLine({ line }: { line: TraceLine }) {
  return (
    <div className={`sysline ${line.kind === "error" ? "err" : ""}`}>
      <span className="dot" />
      {line.text}
      {line.detail && line.detail !== line.text && <span className="detail"> — {line.detail}</span>}
    </div>
  );
}
