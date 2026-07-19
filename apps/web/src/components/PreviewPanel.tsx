import { useEffect, useRef, useState } from "react";
import type { Studio } from "../lib/studio.js";

/** Studio's preview-frame registration (wired by the studio-side preview-tools
 *  integration: `registerPreviewFrame` keeps the live iframe element so the
 *  agent's preview_read/preview_click/preview_logs tools can reach it). Typed
 *  as an optional structural method so this panel also typechecks/works
 *  against a Studio build without that wiring. */
import { detectRunCommand, staticServeCommand } from "../lib/run-detect.js";
import { killTrackedServe } from "../lib/run-serve.js";
import { bundleProject, hasBundleEntry } from "../lib/bundle-project.js";
import { isBundleRun, reducePreviewSelection } from "../lib/preview-select.js";

/** Preview: agent-primary. The panel follows the AGENT's serving decisions —
 *  its `open_preview` tool (Studio.previewRequest) focuses a port, and a port
 *  the agent opens fills an empty view by default; the selection rules live in
 *  `reducePreviewSelection` (lib/preview-select.ts, unit-tested). A human can
 *  still run something via the small command row below the frame — the
 *  secondary path. The panel shows ONE selected port at a time, but the app in
 *  the iframe can reach a SIBLING open port via `/__port__/<n>/…` (Task 8's SW
 *  routing) — the ports bar hints at that.
 *
 *  Every manual run goes through `doRun`, which first closes whatever port(s)
 *  the previous run opened — `PortRegistry.serve` throws EADDRINUSE on an
 *  already-bound port, so re-serving the same port without freeing it first
 *  would error on every re-run. (On the VM path that means killing the tracked
 *  server and closing ALL open ports — see `killTrackedServe`; on the browser
 *  path, just this panel's own registrations.) On SUCCESS, `doRun` also bumps
 *  `nonce`, folded into the iframe's `key`, so the preview actually remounts
 *  (and reloads) instead of sitting on a stale `src` — a failed run leaves the
 *  still-good iframe alone instead of flickering it.
 *
 *  The Run button carries BOTH manual capabilities: with a typed command it
 *  executes that in the persistent shell; with an empty/auto-detected field on
 *  a bundleable project it bundles in-browser (esbuild-wasm, the only TS/React
 *  preview path on the browser kernel) to /dist and serves that — see
 *  `isBundleRun`. */
export function PreviewPanel({ studio }: { studio: Studio }) {
  const [cmd, setCmd] = useState(() => detectRunCommand(studio.fs, studio.kernelKind) ?? "");
  /** Manual port focus for the human Run path — empty = auto (follow whatever
   *  port the command opens). Only affects which port the panel VIEWS; the
   *  command itself decides what it binds. */
  const [portField, setPortField] = useState("");
  const [running, setRunning] = useState(false);
  const [building, setBuilding] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [output, setOutput] = useState<string | null>(null);
  const [selectedPort, setSelectedPort] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);
  /** Ports THIS panel opened on its last run, so the next run can close them
   *  first (see the module doc above) instead of leaking them until reload. */
  const openedPorts = useRef<number[]>([]);
  /** Reducer state that isn't render state: the not-yet-open agent-requested
   *  port and the last applied request nonce (see reducePreviewSelection). */
  const selState = useRef<{ pendingPort: number | null; handledNonce: number }>({ pendingPort: null, handledNonce: 0 });
  /** Open ports as of the previous reduction, so the reducer can tell NEWLY
   *  opened ports (agent-primary auto-select) from merely-still-open ones. */
  const prevPorts = useRef<readonly number[]>([]);

  /** Re-prefill the command when the kernel switches, but only if the input
   *  still holds the previous kernel's auto-detected command (never clobber a
   *  user-typed one). */
  const prevKind = useRef(studio.kernelKind);
  useEffect(() => {
    if (studio.kernelKind === prevKind.current) return;
    const staleDetect = detectRunCommand(studio.fs, prevKind.current) ?? "";
    prevKind.current = studio.kernelKind;
    setCmd((cur) => (cur === staleDetect ? (detectRunCommand(studio.fs, studio.kernelKind) ?? "") : cur));
  }, [studio.kernelKind, studio.fs]);

  // Locks Run during a switch (mirrors Composer's R11c lock): a serve started
  // in this window would target the OUTGOING kernel. `studio.runServe` refuses
  // too — this is the UI half of that guard.
  const switching = studio.switchingKernel !== null;
  // Derived, not stored: a stale selection (its port already stopped) just
  // falls back to nothing selected instead of needing an effect to reconcile.
  const openPorts = studio.openPorts;
  const viewedPort = selectedPort !== null && openPorts.some((p) => p.port === selectedPort) ? selectedPort : null;
  // Recomputed every render (cheap VFS walks) so they track live agent edits,
  // unlike `cmd`'s one-time initializer.
  const bundleEntry = hasBundleEntry(studio.fs);
  const detected = detectRunCommand(studio.fs, studio.kernelKind);
  const bundleIntent = isBundleRun(cmd, detected, bundleEntry);

  // Follow the agent: apply open_preview requests (Studio.previewRequest) and
  // the agent-primary auto-select via the pure reducer. Reacts ONLY to a new
  // request nonce or an open-ports change — the reducer reads the selection
  // current as of that moment, and a selection change alone must not re-run it
  // (an old request could re-yank).
  useEffect(() => {
    const ports = openPorts.map((p) => p.port);
    const next = reducePreviewSelection(
      { selected: selectedPort, ...selState.current },
      studio.previewRequest,
      ports,
      prevPorts.current,
    );
    prevPorts.current = ports;
    selState.current = { pendingPort: next.pendingPort, handledNonce: next.handledNonce };
    if (next.selected !== selectedPort) setSelectedPort(next.selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studio.previewRequest?.nonce, openPorts]);

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
        const want = portField.trim() === "" ? null : Number(portField.trim());
        if (want !== null && !result.openedPorts.includes(want) && !studio.openPorts.some((p) => p.port === want)) {
          // The serve succeeded but not on the port the user asked to view —
          // say so truthfully instead of silently showing a different port.
          setErrors([
            `The command ran, but port ${want} never opened` +
              (result.openedPorts.length > 0 ? ` (it opened: ${result.openedPorts.join(", ")}).` : "."),
          ]);
        }
        const first = want !== null && (result.openedPorts.includes(want) || studio.openPorts.some((p) => p.port === want))
          ? want
          : result.openedPorts[0];
        if (first !== undefined) setSelectedPort(first);
        else if (selectedPort === null) setSelectedPort(studio.openPorts[0]?.port ?? null);
      }
      return { ok: result.ok, opened: [...result.openedPorts] };
    } finally {
      setRunning(false);
    }
  }

  /** Bundle the project (esbuild-wasm, in-browser) to /dist, then serve it —
   *  the TS/React path, since a raw .tsx source tree can't be served as-is.
   *  Returns whether the bundle+serve succeeded. Leaves `cmd` alone: the field
   *  keeps its passive prefill, so the next Run re-bundles (fresh /dist)
   *  instead of re-serving a stale one. */
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
      return await runCommand(staticServeCommand(studio.kernelKind, "/dist"));
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
   *  on a failed run. */
  async function doRun(action: () => Promise<{ ok: boolean; opened: number[] }>): Promise<void> {
    // Kill the previous detached server (VM path) before the close-then-serve,
    // so a re-run can rebind the port — a real guest socket stays bound until
    // the process dies. On a kill, close EVERY open port (they all belong to
    // that one server), not just this panel's record — the record only ever
    // holds the FIRST port (see killTrackedServe), so a dev server's HMR
    // sibling would otherwise survive the re-run as a chip over a dead process
    // (D5). Browser kernel: servePid is null, the helper returns null, and
    // only the panel's own registrations are closed.
    const dead = await killTrackedServe(studio);
    const closing = dead ?? openedPorts.current;
    openedPorts.current = [];
    for (const p of closing) await studio.closePort(p);
    const result = await action();
    openedPorts.current = result.opened;
    if (result.ok) setNonce((n) => n + 1);
  }

  function handleRun(): void {
    if (running || building || switching) return;
    const pf = portField.trim();
    if (pf !== "" && !/^\d+$/.test(pf)) {
      setErrors([`Port must be a number (got "${pf}") — leave it empty for auto.`]);
      return;
    }
    // Empty/auto-detected field on a bundleable project -> the bundle+serve
    // flow; anything the user actually typed runs as-is.
    if (bundleIntent) void doRun(() => bundleAndRun());
    else if (cmd.trim()) void doRun(() => runCommand(cmd.trim()));
  }

  // Kernel-switch hygiene (panel half): Studio killed the outgoing kernel's
  // server and cleared openPorts/servePid pre-swap. Reset what only this panel
  // tracks so the next doRun doesn't close the other kernel's port numbers on
  // the new runtime, and drop a pending preview request aimed at the old
  // kernel's port numbers. `handledNonce` survives on purpose: an already-seen
  // request must not re-fire on the new kernel.
  useEffect(() => {
    openedPorts.current = [];
    setSelectedPort(null);
    selState.current.pendingPort = null;
    prevPorts.current = [];
  }, [studio.kernelKind]);

  async function stop(port: number): Promise<void> {
    // On the VM path the tracked pid IS the real guest server — closePort alone
    // is pure bookkeeping and would leave it bound + running, so killTrackedServe
    // kills it first. Killing it takes down EVERY port it opened (a dev server +
    // its HMR port render as separate chips), and on the VM path all open ports
    // belong to that one tracked serve — so the helper returns them ALL to close
    // as one; the panel's own record can't supply the siblings (it only ever
    // holds the FIRST port, see killTrackedServe). A sibling chip left behind
    // would 502 on click, its process being gone. Browser kernel: servePid stays
    // null, the helper returns null, and only the clicked registration is closed
    // — other actors' ports (an agent's serve) must survive.
    selState.current.pendingPort = null; // the user acted — a stale agent request must not fire later
    const dead = await killTrackedServe(studio);
    const closing = dead ?? [port];
    if (dead !== null) openedPorts.current = [];
    for (const p of closing) void studio.closePort(p);
    if (selectedPort !== null && closing.includes(selectedPort)) setSelectedPort(null);
  }

  function view(port: number): void {
    selState.current.pendingPort = null; // the user's pick supersedes an unfulfilled agent request
    setSelectedPort(port);
  }

  return (
    <div className="preview">
      <div className="ports-bar">
        {openPorts.length === 0 ? (
          <span className="empty">No open ports yet — the agent's servers show up here, or run a command below.</span>
        ) : (
          openPorts.map((p) => (
            <span key={p.port} className={"port-chip" + (p.port === viewedPort ? " sel" : "")}>
              port {p.port}
              <button onClick={() => view(p.port)} title="View">
                view
              </button>
              <button onClick={() => window.open(`/__preview__/${p.port}/`, "_blank", "noopener")} title="Open in new tab">
                ↗
              </button>
              <button className="x" onClick={() => void stop(p.port)} title="Stop">
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
          // origin to fully isolate it from the app — BUT note the coupling: the
          // agent's preview tools (lib/preview-tools.ts) read/click this frame via
          // contentDocument/contentWindow, which same-origin serving alone makes
          // possible; a separate-origin hardening severs those tools with it — the
          // two decisions travel together. Keyed on port+nonce so a (re-)run
          // remounts the iframe and the preview actually reloads. The ref hands the
          // live element to Studio for the preview tools (null on unmount, so a
          // closed preview fails their "no preview is open" check instead of
          // pointing at a dead frame).
          <iframe
            key={`${viewedPort}:${nonce}`}
            ref={(el) => studio.registerPreviewFrame(el)}
            className="preview-frame"
            title="preview"
            sandbox="allow-scripts allow-same-origin"
            src={`/__preview__/${viewedPort}/`}
          />
        ) : (
          errors.length === 0 && (
            <div className="hint">
              {bundleIntent ? (
                <>
                  Looks like a React/TS project — <strong>Run</strong> bundles it in-browser (esbuild, npm deps from
                  a CDN) to <code>/dist</code> and serves it. Or type your own command below.
                </>
              ) : (
                <>
                  When the agent serves something it shows up here. To run something yourself, use the command row
                  below — a command that serves a virtual port (e.g. <code>erdou serve . --spa</code> or a Flask{" "}
                  <code>python app.py</code>) appears in the ports list above.
                </>
              )}
            </div>
          )
        )}
      </div>

      <div className="preview-run-row">
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
        <input
          className="run-input port-input"
          value={portField}
          onChange={(e) => setPortField(e.target.value)}
          placeholder="port: auto"
          title="Which port to view after Run — leave empty to follow whatever port the command opens"
          spellCheck={false}
        />
        <button
          className="btn"
          onClick={handleRun}
          disabled={running || building || switching || (!cmd.trim() && !bundleEntry)}
          title={
            bundleIntent
              ? "Bundle the project with esbuild (in-browser) to /dist, then serve it"
              : "Run this command in the persistent shell"
          }
        >
          {building ? "Bundling…" : running ? "Running…" : "Run"}
        </button>
      </div>
    </div>
  );
}
