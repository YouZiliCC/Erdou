import { useEffect, useRef, useState } from "react";
import type { Studio } from "../lib/studio.js";
import { detectRunCommand, staticServeCommand } from "../lib/run-detect.js";
import { bundleProject, hasBundleEntry } from "../lib/bundle-project.js";
import { shouldRerun } from "../lib/live-rerun.js";
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
 *  re-run. On SUCCESS, `doRun` also bumps `nonce`, folded into the iframe's
 *  `key`, so the preview actually remounts (and reloads) instead of sitting
 *  on a stale `src` — a failed run leaves the still-good iframe alone instead
 *  of flickering it. `live` re-runs are additionally gated on `shouldRerun`
 *  so a run's own VFS writes (e.g. Bundle & Run's `/dist`) can't re-trigger
 *  themselves forever — only a real external edit after the run settled
 *  schedules another one. */
export function PreviewPanel({ studio }: { studio: Studio }) {
  const [cmd, setCmd] = useState(() => detectRunCommand(studio.fs, studio.kernelKind) ?? "");
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
   *  a fixed raw command string. Returns whether the run succeeded (a served
   *  port / no errors), so `doRun` can gate the reload nonce on it. */
  const lastAction = useRef<null | (() => Promise<{ ok: boolean; opened: number[] }>)>(null);
  /** True while a `doRun` is in flight, so the live effect's debounce can't
   *  stack a second run on top of one still running. */
  const busy = useRef(false);
  /** `studio.fsVersion` as of the moment the last `doRun` finished — by then
   *  every VFS write the action itself made (e.g. Bundle & Run's `/dist`) is
   *  already reflected. The `live` effect compares against this (via
   *  `shouldRerun`) so a run's OWN writes don't re-trigger itself forever;
   *  only a fsVersion bump strictly AFTER this point is a real external edit. */
  const lastRunFsVersion = useRef(0);

  /** Re-prefill the command when the kernel switches, but only if the input
   *  still holds an auto-set command (never clobber a user-typed one). Two
   *  auto-set shapes exist: the previous kernel's detection, and Bundle & Run's
   *  `/dist` serve — which detection does NOT reproduce when `/index.html`
   *  also exists (it prefers "/"), so it needs its own comparison or it would
   *  be misclassified as user-typed and survive as the wrong kernel's command. */
  const prevKind = useRef(studio.kernelKind);
  useEffect(() => {
    if (studio.kernelKind === prevKind.current) return;
    const prev = prevKind.current;
    prevKind.current = studio.kernelKind;
    const staleDetect = detectRunCommand(studio.fs, prev) ?? "";
    const staleBundle = staticServeCommand(prev, "/dist");
    setCmd((cur) =>
      cur === staleBundle
        ? staticServeCommand(studio.kernelKind, "/dist")
        : cur === staleDetect
          ? (detectRunCommand(studio.fs, studio.kernelKind) ?? "")
          : cur,
    );
  }, [studio.kernelKind, studio.fs]);

  // Locks Run/Bundle & Run during a switch (mirrors Composer's R11c lock):
  // a serve started in this window would target the OUTGOING kernel.
  // `studio.runServe` refuses too — this is the UI half of that guard.
  const switching = studio.switchingKernel !== null;
  // Derived, not stored: a stale selection (its port already stopped) just
  // falls back to nothing selected instead of needing an effect to reconcile.
  const openPorts = studio.openPorts;
  const viewedPort = selectedPort !== null && openPorts.some((p) => p.port === selectedPort) ? selectedPort : null;
  // Recomputed every render (cheap VFS walk) so it tracks live agent edits,
  // unlike `cmd`'s one-time initializer.
  const bundleEntry = hasBundleEntry(studio.fs);
  const showBundlePrompt = bundleEntry && !cmd.trim();

  /** Runs `commandLine` via `studio.runServe` (which owns the serve/switch
   *  race — pid bookkeeping and stale-settle cleanup live there). Returns
   *  success + the ports the run opened (captured from events — a serving
   *  command may still be running when this resolves; that is the contract's
   *  serve idiom). */
  async function runCommand(commandLine: string): Promise<{ ok: boolean; opened: number[] }> {
    if (!commandLine || running) return { ok: false, opened: [] };
    setRunning(true);
    try {
      const result = await studio.runServe(commandLine);
      // Settled after a kernel switch: Studio already killed it on the kernel
      // that owns it — record NOTHING here (no ports, no error, no preview),
      // the switch reset below has already put the panel in its blank state.
      if (result.stale) return { ok: false, opened: [] };
      if (!result.ok) {
        setErrors([result.stderr?.trim() || result.stdout?.trim() || `exited with code ${result.code}`]);
        setOutput(null);
      } else {
        setErrors([]);
        setOutput(result.stdout?.trim() || null);
        const first = result.openedPorts[0];
        if (first !== undefined) setSelectedPort(first);
        else if (selectedPort === null) setSelectedPort(studio.openPorts[0]?.port ?? null);
      }
      ranOnce.current = true;
      return { ok: result.ok, opened: [...result.openedPorts] };
    } finally {
      setRunning(false);
    }
  }

  /** Bundle the project (esbuild-wasm, in-browser) to /dist, then serve it —
   *  the TS/React path, since a raw .tsx source tree can't be served as-is.
   *  Returns whether the bundle+serve succeeded. */
  async function bundleAndRun(): Promise<{ ok: boolean; opened: number[] }> {
    if (building || running) return { ok: false, opened: [] };
    setBuilding(true);
    setErrors([]);
    setOutput(null);
    try {
      const result = await bundleProject(studio.fs);
      if (!result.ok) {
        setErrors(result.errors);
        return { ok: false, opened: [] };
      }
      // Kernel-aware: the VM guest has no `erdou` binary; serve /dist with the
      // guest's python3 http.server instead (see staticServeCommand). Either
      // way the run goes through runServeCommand, which already picks the
      // detached-exec + port.opened path on realOs kernels.
      const commandLine = staticServeCommand(studio.kernelKind, "/dist");
      setCmd(commandLine);
      return await runCommand(commandLine);
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)]);
      return { ok: false, opened: [] };
    } finally {
      setBuilding(false);
    }
  }

  /** Close-then-serve: free the port(s) this panel opened last time (so
   *  re-serving the same one can't EADDRINUSE), run `action`, record whatever
   *  NEW ports it opened, and bump `nonce` — but ONLY on success — so the
   *  iframe remounts + reloads instead of flickering the still-good preview
   *  on every failed live rebuild. Also baselines `lastRunFsVersion` to
   *  whatever `fsVersion` ends up at once the action's writes are done, so
   *  the `live` effect can tell the run's own writes apart from a later,
   *  real external edit (see `shouldRerun`). */
  async function doRun(action: () => Promise<{ ok: boolean; opened: number[] }>): Promise<void> {
    busy.current = true;
    try {
      // Kill the previous detached server (VM path) before the close-then-serve,
      // so a live re-run can rebind the port — a real guest socket stays bound
      // until the process dies. No-op on the browser kernel (servePid is null).
      if (studio.servePid !== null) {
        await studio.runtime.kill(studio.servePid).catch(() => {});
        studio.servePid = null;
      }
      for (const p of openedPorts.current) await studio.closePort(p);
      openedPorts.current = [];
      const result = await action();
      openedPorts.current = result.opened;
      // By now every VFS write the action itself made is reflected (runCommand
      // resolved), so this baseline still tells own-writes from later edits.
      lastRunFsVersion.current = studio.fsVersion;
      if (result.ok) setNonce((n) => n + 1);
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
  //
  // Bundle & Run's own action WRITES `/dist`, which bumps `studio.fsVersion`
  // (Studio's `file.changed` subscription) — so naively re-running on every
  // `fsVersion` change would re-trigger itself off its own writes, forever.
  // `shouldRerun` guards against that: `doRun` baselines `lastRunFsVersion` to
  // `fsVersion` right after the action's writes land, so this timer only
  // proceeds once `fsVersion` has moved PAST that baseline — i.e. a real edit
  // happened after the run settled, not merely because of it.
  useEffect(() => {
    if (!live || !ranOnce.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (busy.current || !lastAction.current) return;
      if (!shouldRerun(studio.fsVersion, lastRunFsVersion.current)) return;
      void doRun(lastAction.current);
    }, 1200);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studio.fsVersion, live]);

  // Kernel-switch hygiene (panel half): Studio killed the outgoing kernel's
  // server and cleared openPorts/servePid pre-swap. Reset what only this panel
  // tracks so the next doRun doesn't close the other kernel's port numbers on
  // the new runtime — and drop lastAction/ranOnce so live mode doesn't auto
  // re-run the OLD kernel's (kernel-specific, guaranteed-failing) command on
  // the new one; the next run must come from a fresh click.
  useEffect(() => {
    openedPorts.current = [];
    setSelectedPort(null);
    lastAction.current = null;
    ranOnce.current = false;
  }, [studio.kernelKind]);

  function stop(port: number): void {
    // On the VM path the tracked pid IS the real guest server — closePort alone
    // is pure bookkeeping and would leave it bound + running, so kill it too.
    // Browser-safe: servePid stays null on the browser kernel, so kill is never
    // called there.
    if (studio.servePid !== null) {
      void studio.runtime.kill(studio.servePid).catch(() => {});
      studio.servePid = null;
    }
    void studio.closePort(port);
    if (selectedPort === port) setSelectedPort(null);
  }

  return (
    <div className="preview">
      <div className="preview-bar">
        <input
          className="run-input"
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          placeholder={
            studio.kernelKind === "vm"
              ? "run command, e.g. python3 -m http.server 8080 --bind 0.0.0.0"
              : "run command, e.g. erdou serve . --spa"
          }
          spellCheck={false}
        />
        <button className="btn primary" onClick={handleRun} disabled={running || building || switching || !cmd.trim()}>
          {running ? "Running…" : "Run"}
        </button>
        <button
          className={"btn" + (showBundlePrompt ? " primary" : " ghost")}
          onClick={handleBundleAndRun}
          disabled={building || running || switching || !bundleEntry}
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
        <span className="sibling-hint" title="Absolute paths (e.g. /style.css) are now proxied to the guest via the initiating iframe client; relative URLs are still recommended. Use /__port__/<n>/ to reach a sibling port.">
          Previewed apps can use relative or absolute URLs (both proxied); use <code>/__port__/&lt;n&gt;/</code> to reach a sibling port.
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
