import { useEffect, useRef, useState } from "react";
import type { Studio } from "../lib/studio.js";
import { detectRunCommand } from "../lib/run-detect.js";
import { bundleProject, hasBundleEntry } from "../lib/bundle-project.js";
import { Toggle } from "./ui/Toggle.js";

/** Preview: type/detect a run command, execute it in the persistent shell, then
 *  view whichever virtual port it opened via the `/__preview__/<port>/`
 *  reverse proxy (Task 5). This panel only ever shows one primary (selected)
 *  port at a time, but the app running in that iframe can still reach a
 *  SIBLING open port by requesting `/__port__/<n>/…` (Task 8's SW routing) —
 *  the ports bar always hints at that.
 *
 *  Every run (Run, Bundle & Run, or a `live` re-run) goes through `doRun`,
 *  which first closes whatever port(s) THIS panel opened last time —
 *  `PortRegistry.serve` throws EADDRINUSE on an already-bound port, so
 *  re-serving the same port without freeing it first would error on every
 *  re-run. `doRun` also bumps `nonce`, folded into the iframe's `key`, so the
 *  preview actually remounts (and reloads) after each (re-)run instead of
 *  sitting on a stale `src`. */
export function PreviewPanel({ studio }: { studio: Studio }) {
  const [cmd, setCmd] = useState(() => detectRunCommand(studio.runtime.fs) ?? "");
  const [running, setRunning] = useState(false);
  const [building, setBuilding] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [output, setOutput] = useState<string | null>(null);
  const [selectedPort, setSelectedPort] = useState<number | null>(null);
  const [live, setLive] = useState(false);
  const [nonce, setNonce] = useState(0);
  const ranOnce = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Ports THIS panel opened on its last run, so the next run can close them
   *  first (see the module doc above) instead of leaking them until reload. */
  const openedPorts = useRef<number[]>([]);
  /** The last action Run or Bundle & Run invoked, so `live` re-invokes the
   *  SAME action (re-serve a static dir, or re-bundle + re-serve) instead of
   *  a fixed raw command string. */
  const lastAction = useRef<null | (() => Promise<void>)>(null);
  /** True while a `doRun` is in flight, so the live effect's debounce can't
   *  stack a second run on top of one still running. */
  const busy = useRef(false);

  // Derived, not stored: a stale selection (its port already stopped) just
  // falls back to nothing selected instead of needing an effect to reconcile.
  const openPorts = studio.openPorts;
  const viewedPort = selectedPort !== null && openPorts.some((p) => p.port === selectedPort) ? selectedPort : null;
  // Recomputed every render (cheap VFS walk) so it tracks live agent edits,
  // unlike `cmd`'s one-time initializer.
  const bundleEntry = hasBundleEntry(studio.runtime.fs);
  const showBundlePrompt = bundleEntry && !cmd.trim();

  async function runCommand(commandLine: string): Promise<void> {
    if (!commandLine || running) return;
    setRunning(true);
    const before = new Set(studio.openPorts.map((p) => p.port));
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

  /** Bundle the project (esbuild-wasm, in-browser) to /dist, then serve it —
   *  the TS/React path, since a raw .tsx source tree can't be served as-is. */
  async function bundleAndRun(): Promise<void> {
    if (building || running) return;
    setBuilding(true);
    setErrors([]);
    setOutput(null);
    try {
      const result = await bundleProject(studio.runtime.fs);
      if (!result.ok) {
        setErrors(result.errors);
        return;
      }
      const commandLine = "erdou serve dist --spa";
      setCmd(commandLine);
      await runCommand(commandLine);
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)]);
    } finally {
      setBuilding(false);
    }
  }

  /** Close-then-serve: free the port(s) this panel opened last time (so
   *  re-serving the same one can't EADDRINUSE), run `action`, record whatever
   *  NEW ports it opened, and bump `nonce` so the iframe remounts + reloads. */
  async function doRun(action: () => Promise<void>): Promise<void> {
    busy.current = true;
    try {
      for (const p of openedPorts.current) studio.closePort(p);
      openedPorts.current = [];
      const before = new Set(studio.openPorts.map((p) => p.port));
      await action();
      // Read AFTER the action resolves: `port.opened` fires synchronously
      // during `shell.exec`, so by now any newly-served port is present.
      openedPorts.current = studio.openPorts.map((p) => p.port).filter((p) => !before.has(p));
      setNonce((n) => n + 1);
    } finally {
      busy.current = false;
    }
  }

  function handleRun(): void {
    const commandLine = cmd.trim();
    if (!commandLine || running || building) return;
    lastAction.current = () => runCommand(commandLine);
    void doRun(lastAction.current);
  }

  function handleBundleAndRun(): void {
    if (building || running) return;
    lastAction.current = () => bundleAndRun();
    void doRun(lastAction.current);
  }

  // Live mode: re-invoke the last action shortly after the filesystem
  // changes, once a run has happened at least once. Re-running the ACTION
  // (not a raw command string) means a static serve gets closed-then-re-served
  // (picking up VFS edits) and Bundle & Run gets re-bundled before re-serving.
  useEffect(() => {
    if (!live || !ranOnce.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (busy.current || !lastAction.current) return;
      void doRun(lastAction.current);
    }, 1200);
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
        <button className="btn primary" onClick={handleRun} disabled={running || building || !cmd.trim()}>
          {running ? "Running…" : "Run"}
        </button>
        <button
          className={"btn" + (showBundlePrompt ? " primary" : " ghost")}
          onClick={handleBundleAndRun}
          disabled={building || running || !bundleEntry}
          title="Bundle the project with esbuild (in-browser) to /dist, then serve it"
        >
          {building ? "Bundling…" : "Bundle & Run"}
        </button>
        <Toggle className="live-toggle" checked={live} onChange={setLive} label="live" />
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
        <span className="sibling-hint" title="An absolute path like /api isn't proxied — only requests under the preview scope are">
          Previewed apps must use relative URLs (or <code>/__port__/&lt;n&gt;/</code> to reach a sibling port).
        </span>
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
          // origin to fully isolate it from the app. Keyed on port+nonce so a
          // (re-)run remounts the iframe and the preview actually reloads.
          <iframe
            key={`${viewedPort}:${nonce}`}
            className="preview-frame"
            title="preview"
            sandbox="allow-scripts allow-same-origin"
            src={`/__preview__/${viewedPort}/`}
          />
        ) : (
          errors.length === 0 && (
            <div className="hint">
              {showBundlePrompt ? (
                <>
                  Looks like a React/TS project — click <strong>Bundle & Run</strong> to bundle it in-browser
                  (esbuild, npm deps from a CDN) to <code>/dist</code> and serve it.
                </>
              ) : (
                <>
                  Type (or accept the detected) run command and hit Run — it executes in the persistent shell. A
                  command that serves a virtual port (e.g. <code>erdou serve . --spa</code> or a Flask{" "}
                  <code>python app.py</code>) shows up in the ports list above; pick it to view it here. A React/TS
                  source project needs <strong>Bundle & Run</strong> instead — it isn't servable as-is.
                </>
              )}
            </div>
          )
        )}
      </div>
    </div>
  );
}
