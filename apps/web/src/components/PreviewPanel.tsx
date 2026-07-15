import { useEffect, useRef, useState } from "react";
import type { Studio } from "../lib/studio.js";
import { detectRunCommand } from "../lib/run-detect.js";

/** Preview: type/detect a run command, execute it in the persistent shell, then
 *  view whichever virtual port it opened via the `/__preview__/<port>/`
 *  reverse proxy (Task 5). This panel only ever shows one primary (selected)
 *  port at a time, but the app running in that iframe can still reach a
 *  SIBLING open port by requesting `/__port__/<n>/…` (Task 8's SW routing) —
 *  the ports bar hints at that when more than one port is open. */
export function PreviewPanel({ studio }: { studio: Studio }) {
  const [cmd, setCmd] = useState(() => detectRunCommand(studio.runtime.fs) ?? "");
  const [running, setRunning] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [output, setOutput] = useState<string | null>(null);
  const [selectedPort, setSelectedPort] = useState<number | null>(null);
  const [live, setLive] = useState(false);
  const ranOnce = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Derived, not stored: a stale selection (its port already stopped) just
  // falls back to nothing selected instead of needing an effect to reconcile.
  const openPorts = studio.openPorts;
  const viewedPort = selectedPort !== null && openPorts.some((p) => p.port === selectedPort) ? selectedPort : null;

  async function run(): Promise<void> {
    const commandLine = cmd.trim();
    if (!commandLine || running) return;
    setRunning(true);
    const before = new Set(openPorts.map((p) => p.port));
    try {
      const result = await studio.shell.exec(commandLine);
      if (result.code !== 0) {
        setErrors([result.stderr.trim() || result.stdout.trim() || `exited with code ${result.code}`]);
        setOutput(null);
      } else {
        setErrors([]);
        setOutput(result.stdout.trim() || null);
        const opened = studio.openPorts.find((p) => !before.has(p.port));
        if (opened) setSelectedPort(opened.port);
        else if (selectedPort === null) setSelectedPort(studio.openPorts[0]?.port ?? null);
      }
      ranOnce.current = true;
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)]);
      setOutput(null);
    } finally {
      setRunning(false);
    }
  }

  // Live mode: re-run the command shortly after the filesystem changes, once a
  // run has happened at least once.
  useEffect(() => {
    if (!live || !ranOnce.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void run(), 1200);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studio.fsVersion, live]);

  function stop(port: number): void {
    studio.closePort(port);
    if (selectedPort === port) setSelectedPort(null);
  }

  return (
    <div className="preview">
      <div className="preview-bar">
        <input
          className="run-input"
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          placeholder="run command, e.g. erdou serve . --spa"
          spellCheck={false}
        />
        <button className="btn primary" onClick={() => void run()} disabled={running || !cmd.trim()}>
          {running ? "Running…" : "Run"}
        </button>
        <label className="live-toggle">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> live
        </label>
      </div>

      <div className="ports-bar">
        {openPorts.length === 0 ? (
          <span className="empty">No open ports yet — Run a command that serves one.</span>
        ) : (
          openPorts.map((p) => (
            <span key={p.port} className={"port-chip" + (p.port === viewedPort ? " sel" : "")}>
              port {p.port}
              <button onClick={() => setSelectedPort(p.port)} title="View">
                view
              </button>
              <button onClick={() => window.open(`/__preview__/${p.port}/`, "_blank", "noopener")} title="Open in new tab">
                ↗
              </button>
              <button className="x" onClick={() => stop(p.port)} title="Stop">
                ×
              </button>
            </span>
          ))
        )}
        {openPorts.length > 1 && (
          <span className="sibling-hint" title="From the viewed app, fetch this path prefix to reach a sibling port">
            reach a sibling via <code>/__port__/&lt;n&gt;/…</code>
          </span>
        )}
      </div>

      <div className="preview-content">
        {errors.length > 0 ? (
          <div className="build-errors">
            <pre>{errors.join("\n\n")}</pre>
          </div>
        ) : output ? (
          <div className="preview-output">{output}</div>
        ) : null}

        {viewedPort !== null ? (
          // The service worker only controls same-origin clients, so the SW-served
          // preview needs allow-same-origin. In production, serve it from a separate
          // origin to fully isolate it from the app.
          <iframe
            className="preview-frame"
            title="preview"
            sandbox="allow-scripts allow-same-origin"
            src={`/__preview__/${viewedPort}/`}
          />
        ) : (
          errors.length === 0 && (
            <div className="hint">
              Type (or accept the detected) run command and hit Run — it executes in the persistent shell. A command
              that serves a virtual port (e.g. <code>erdou serve . --spa</code> or a Flask <code>python app.py</code>)
              shows up in the ports list above; pick it to view it here.
            </div>
          )
        )}
      </div>
    </div>
  );
}
