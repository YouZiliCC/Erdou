import { IndexedDbSnapshotStore } from "@erdou/runtime-browser";
import { ModelGateway, type ModelConfig, type ChatMessage } from "@erdou/model-gateway";
import { CodingAgent, ERDOU_MD_TEMPLATE, type AgentEvent, type ApprovalRequest } from "@erdou/agent-core";
import { createSwitchEnvironmentTool } from "@erdou/agent-tools";
import { ENVIRONMENTS, environmentById } from "./environments.js";
import { loadApprovalMode, saveApprovalMode, loadModel, saveModel, type ApprovalMode } from "./model-config.js";
import { getTheme, applyTheme } from "./theme.js";
import type { RuntimeEvent, ProcessInfo, Snapshot, Runtime, FileSystemApi, Unsubscribe } from "@erdou/runtime-contract";
import { AGENT_LANGUAGES, AGENT_COMMANDS } from "./languages.js";
import {
  createBrowserKernel,
  VM_PRESERVE_DIRS,
  environmentId,
  parseEnvironmentId,
  type Environment,
  type VmProfile,
  type Kernel,
  type RpcShellSession,
} from "./kernel.js";
import { loadRuns, saveRuns, clearRuns } from "./runs-store.js";
import { SnapshotReader, buildFileChanges } from "./snapshot-read.js";
import { startPreviewProxy, setPreviewRuntime } from "./preview-bridge.js";
import { runServeCommand, type RunServeResult } from "./run-serve.js";
import { copyWorkspace } from "./workspace-copy.js";
import { writeFolderState, readFolderState, type FolderState } from "./folder-state.js";
import {
  loadFolderIntoVfs,
  saveVfsToFolder,
  rescanFolder,
  persistHandle,
  loadPersistedHandle,
  clearPersistedHandle,
  diskHasEntry,
  dropMtimesUnder,
  hasMtimeUnder,
  type DirHandleLike,
  type FolderMirrorResult,
  type FolderPullResult,
  type MountMtimes,
} from "./local-mount.js";
import { pullDiskToWorkspace, pushWorkspaceToDisk, reselectFolder as reselectFolderOp } from "./folder-sync-controls.js";
import { buildProjectZip } from "./project-zip.js";
import { createDelegateTool, type SubagentDetail } from "./delegate.js";
import { createPreviewTools } from "./preview-tools.js";

const SNAPSHOT_ID = "erdou:default";
/** Cap on `Studio.systemLog` entries so a noisy source (e.g. failing rescans) can't grow it unbounded. */
const SYSTEM_LOG_LIMIT = 200;
// Failure texts logged on a state TRANSITION and removed again on recovery
// (dropSystemErrors) — shared constants so the log and the removal can't drift.
const SAVE_FAILED_TEXT = "Couldn't save your project to this browser (storage may be full or restricted).";
const RESCAN_FAILED_TEXT = "Mount rescan failed";

export type TraceKind =
  | "system"
  | "user"
  | "thought"
  | "tool"
  | "result"
  | "done"
  | "error"
  | "artifact"
  /** One delegate sub-agent's lifecycle card; `detail` = SubagentDetail JSON
   *  (see delegate.ts parseSubagentDetail — the parseArtifactDetail pattern). */
  | "subagent";

export interface TraceLine {
  id: number;
  kind: TraceKind;
  text: string;
  detail?: string;
  ok?: boolean;
  ts: number;
}

/** The JSON payload of a kind:"artifact" trace line's `detail` (plain JSON —
 *  it persists through runs-store/.erdou like any other trace line). The blob
 *  itself does NOT persist: `exportId` keys into `Studio.exports`, which is
 *  session-only, so a reloaded browser renders the card in an expired state. */
export interface ExportArtifact {
  exportId: string;
  name: string;
  byteSize: number;
  fileCount: number;
}

/** Parse an artifact line's `detail` back into its payload; null when it is
 *  missing or the wrong shape (a truncated/hand-edited persisted trace). */
export function parseArtifactDetail(detail: string | undefined): ExportArtifact | null {
  if (!detail) return null;
  try {
    const p: unknown = JSON.parse(detail);
    if (
      typeof p === "object" &&
      p !== null &&
      typeof (p as ExportArtifact).exportId === "string" &&
      typeof (p as ExportArtifact).name === "string" &&
      typeof (p as ExportArtifact).byteSize === "number" &&
      typeof (p as ExportArtifact).fileCount === "number"
    ) {
      return p as ExportArtifact;
    }
  } catch {
    // fall through — malformed JSON reads as "not an artifact payload"
  }
  return null;
}

export type RunStatus = "running" | "review" | "done" | "error";

/** `Studio.runServe`'s result: the serve outcome, plus `stale: true` when it
 *  settled after a kernel switch — its pid was killed on the runtime that owns
 *  it, and the caller must record nothing (no ports, no preview URL). */
export interface StudioServeResult extends RunServeResult {
  stale?: boolean;
}

export interface FileChange {
  path: string;
  kind: "create" | "modify" | "delete";
  before: string;
  after: string;
}

/** One agent run — a "task thread" in the sidebar. Plain JSON (persisted). */
export interface Run {
  id: string;
  title: string;
  task: string;
  status: RunStatus;
  trace: TraceLine[];
  changes: FileChange[];
  /** The model transcript so far (system + user/assistant/tool turns), seeded
   *  from `AgentRunResult.transcript` after each turn. Replies pass this back
   *  in as `priorMessages` so the agent continues the same conversation. */
  messages: ChatMessage[];
  createdAt: number;
}

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink";
  children?: FileNode[];
}

/** Run-id generator that works on insecure contexts (http://<ip> self-hosting):
 *  crypto.randomUUID is [SecureContext]-only and undefined there, while
 *  crypto.getRandomValues is not gated. */
function newRunId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** First non-empty line of the task, trimmed to ~48 chars. Pure. */
export function runTitle(task: string): string {
  const firstLine = (task.split("\n")[0] ?? "").trim();
  const base = firstLine.length > 0 ? firstLine : task.trim();
  return base.length > 48 ? base.slice(0, 47).trimEnd() + "…" : base;
}

/** One macrotask — the contract guarantees events caused by a runtime call
 *  are delivered no later than one macrotask after the call resolves
 *  (runtime-contract/src/events.ts), so awaiting this after `agent.run`
 *  makes every file.changed from the turn visible. */
export const eventsSettled = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * Owns the browser runtime, model gateway, agent and project persistence.
 * React subscribes for re-render; all Erdou logic lives here, not in components.
 */
export class Studio {
  /** The active kernel — the seam a second runtime implementation plugs into.
   *  Mutable so `switchKernel` can re-point it; `runtime`/`fs`/`shell` below
   *  delegate to it so they follow the swap polymorphically. */
  kernel: Kernel = createBrowserKernel();
  /** The browser kernel, kept alive for an instant switch back to it. */
  private browserKernel = this.kernel;
  /** The booted VM kernel, cached across switches so a second "vm" switch
   *  reuses the same guest instead of booting a second one (~40 MB + ~2 s). */
  private vmKernel: Kernel | null = null;
  private _browserBooted = false;
  /** Bumped every time `this.kernel` is re-pointed by a successful swap. The
   *  terminal keys its `<PtyTerminal>` on it so a vm→vm profile switch (which
   *  keeps `kernelKind === "vm"`) still remounts the PTY onto the new guest. */
  kernelGeneration = 0;
  /** Progress state for the kernel-switch UI; `null` when no switch is in flight. */
  switchingKernel: { phase: string } | null = null;
  private readonly gateway = new ModelGateway();
  private readonly store = new IndexedDbSnapshotStore();
  private booted = false;
  private nextId = 1;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  /** Debounce timer for persisting `runs` on trace appends (D2) — trailing
   *  ~500ms so a burst of trace lines costs one IndexedDB write. */
  private runsSaveTimer: ReturnType<typeof setTimeout> | undefined;
  /** Cancels the in-flight agent run (D1); non-null only while one runs. */
  private runAbort: AbortController | null = null;
  /** Ids of runs an agent turn has DRIVEN this browser session (stamped at
   *  turn start; cleared only by a folder swap, which is a project change).
   *  `hydrateRuns` keeps these runs' memory objects through an `.erdou`
   *  hydration: this session's work is strictly ahead of whatever the folder
   *  holds. Without it, a reply to a folder-shared run (same id on both
   *  sides) that COMPLETED inside the mount window was neither "live" nor
   *  "memory-only", so the folder's stale copy silently wiped the reply. */
  private turnRunIds = new Set<string>();
  private _shell?: RpcShellSession;
  private _unsubRuntime?: Unsubscribe;
  /** Re-points the run-scoped diff subscription onto the active kernel after a
   *  mid-run environment switch (set only while a run is in flight). */
  private repointRunDiff?: () => void;
  /** Drops rescan-pulled paths (the user's external disk edits) from the
   *  in-flight run's changed set so the run diff doesn't blame the agent for
   *  them (set only while a run is in flight — see runAgentTurn). */
  private discountExternalPulls?: (paths: readonly string[]) => Promise<void>;

  /**
   * The STABLE `Runtime` handed to the agent at construction (S4 critical fix
   * M1). Every method forwards to `this.kernel.runtime` AT CALL TIME, so a
   * sanctioned mid-run `switchEnvironmentForRun` re-points which concrete
   * runtime the agent's tools execute against. Passing `this.runtime` (a getter
   * evaluated ONCE) would pin every post-switch tool to the OLD kernel.
   * agent-tools only uses readFile/writeFile/readdir/mkdir/rm/exec, but the
   * full 22-method contract is forwarded for type-completeness. (Studio's own
   * subscriptions stay on concrete runtimes; a facade-made subscription would
   * bind to the then-current runtime — agent-tools makes none.)
   */
  private readonly agentRuntime: Runtime = {
    boot: () => this.kernel.runtime.boot(),
    shutdown: () => this.kernel.runtime.shutdown(),
    spawn: (o) => this.kernel.runtime.spawn(o),
    exec: (c, o) => this.kernel.runtime.exec(c, o),
    kill: (p, s) => this.kernel.runtime.kill(p, s),
    wait: (p) => this.kernel.runtime.wait(p),
    getProcesses: () => this.kernel.runtime.getProcesses(),
    readFile: (p) => this.kernel.runtime.readFile(p),
    writeFile: (p, d, o) => this.kernel.runtime.writeFile(p, d, o),
    readdir: (p) => this.kernel.runtime.readdir(p),
    mkdir: (p, o) => this.kernel.runtime.mkdir(p, o),
    rm: (p, o) => this.kernel.runtime.rm(p, o),
    rename: (f, t) => this.kernel.runtime.rename(f, t),
    stat: (p) => this.kernel.runtime.stat(p),
    createSnapshot: () => this.kernel.runtime.createSnapshot(),
    restoreSnapshot: (s) => this.kernel.runtime.restoreSnapshot(s),
    listen: (p) => this.kernel.runtime.listen(p),
    exposePort: (p) => this.kernel.runtime.exposePort(p),
    dispatch: (p, r) => this.kernel.runtime.dispatch(p, r),
    closePort: (p) => this.kernel.runtime.closePort(p),
    getCapabilities: () => this.kernel.runtime.getCapabilities(),
    subscribe: (l) => this.kernel.runtime.subscribe(l),
  };

  /** `"browser"` or `"vm"` — which kernel is currently active. */
  get kernelKind(): Kernel["kind"] {
    return this.kernel.kind;
  }

  /** The active environment's string id (`browser` | `vm:<profile>`) — the
   *  selector's current value and the switch handle. */
  get currentEnvId(): string {
    return this.kernel.kind === "vm" ? `vm:${this.kernel.profile ?? "base"}` : "browser";
  }

  /** The contract-typed runtime of the active kernel. */
  get runtime(): Runtime {
    return this.kernel.runtime;
  }

  /** Host-side synchronous view of the workspace (see Kernel.fs). */
  get fs(): FileSystemApi {
    return this.kernel.fs;
  }

  /** Agent run history, most-recent first (persisted in IndexedDB). */
  runs: Run[] = [];
  activeRunId: string | null = null;
  /** Terminal/mount/system messages not tied to any run. */
  systemLog: TraceLine[] = [];
  running = false;
  /** True from `stopRun()` until the aborted turn actually ends. The abort is
   *  checkpoint-based (the agent exits at its next checkpoint, which during an
   *  in-flight model call means after the HTTP response arrives), so the
   *  Composer shows a disabled "Stopping…" state instead of a Stop button that
   *  looks ignored. */
  stopping = false;
  fsVersion = 0;
  /** Ports currently served by the runtime (Preview panel's open-ports list),
   *  tracked from `port.opened`/`port.closed` — not persisted; a fresh session
   *  starts with nothing served until something runs. */
  openPorts: { port: number }[] = [];
  /** The agent's open_preview request: ReviewPane switches to the Preview tab
   *  and PreviewPanel focuses `port` (or the latest open port when null)
   *  whenever `nonce` changes. Null until the tool is first used. */
  previewRequest: { port: number | null; nonce: number } | null = null;
  /** The live preview iframe (registered by PreviewPanel's ref; null when no
   *  preview is mounted). NOT render state — mutated without notify(); read
   *  lazily by the preview_read/preview_click/preview_logs tools. */
  previewFrame: HTMLIFrameElement | null = null;
  /** Session-only registry of built project zips, keyed by exportId (the key an
   *  artifact trace line carries). Deliberately NOT persisted: the values hold
   *  object URLs onto in-memory blobs, which die with the page — after a reload
   *  the persisted trace line finds no entry here and renders as expired. */
  exports = new Map<string, { url: string; name: string; byteSize: number; fileCount: number }>();
  /** The Preview panel's detached serve process (`RunServeResult.pid`, VM path
   *  only — `null` on the browser kernel). Owned here, not in the panel, so
   *  `switchKernel` can kill it on the OUTGOING kernel pre-swap, and so it
   *  survives the panel's tab unmount/remount. */
  servePid: number | null = null;
  /** Bumped on every change so React's useSyncExternalStore re-renders. */
  version = 0;
  /** Bumped ONLY when `mountFolder` hydrates a persisted config from a mounted
   *  folder's `.erdou/config.json` (theme/approval-mode/model, incl. the api
   *  key) — never on every `notify()`. Consumers that seed local state from
   *  `localStorage` once (e.g. App.tsx's `model`/`mode`) watch this to re-read
   *  it after a folder mount, instead of requiring a full page reload. */
  configVersion = 0;

  /**
   * A gated command awaiting the user's decision (Confirm mode). While set, the
   * agent is blocked inside its `approve` callback; the UI resolves it on click.
   */
  pendingApproval: {
    req: ApprovalRequest;
    resolve: (d: "allow" | "deny") => void;
    allowAlways: () => void;
  } | null = null;
  /** Tools the user chose to "always allow" for the duration of the current run. */
  private autoAllow = new Set<string>();

  /** A mounted local folder (File System Access API), if any. */
  mount: DirHandleLike | null = null;
  mountName: string | null = null;
  /** A persisted handle awaiting a user gesture to re-grant permission. */
  pendingMount: DirHandleLike | null = null;
  private folderSaveTimer: ReturnType<typeof setTimeout> | undefined;
  /** Debounce timer for `.erdou/` session-state (runs + config) writes — a
   *  dedicated timer, separate from the project file-sync above and from
   *  `mountMtimes`. */
  private folderStateTimer: ReturnType<typeof setTimeout> | undefined;
  /** vfsPath -> disk lastModified, so load/save/rescan can tell our own write-backs from external edits. */
  private mountMtimes: MountMtimes = new Map();
  /** Polls the mounted folder for external disk edits and pulls them into the VFS. */
  private mountWatch?: { interval: ReturnType<typeof setInterval>; onFocus: () => void };
  /** Set once a rescan fails, so we log it only once instead of every 5s until a rescan succeeds again. */
  private mountRescanFailed = false;
  /** True while a folder SWAP is repointing the mount to a different disk
   *  folder (and briefly while a plain mount clears+loads over a non-empty
   *  workspace). Suspends the folder auto-save so the clear+load's
   *  file.changed churn can never mirror onto the wrong disk, and blocks
   *  startRun/replyToRun — a turn started mid-swap could not survive the
   *  "replace" hydration (see hydrateRuns). */
  private swappingFolder = false;

  get activeRun(): Run | undefined {
    return this.runs.find((r) => r.id === this.activeRunId);
  }

  /** A persistent shell session (cwd/env survive across commands), for the terminal. */
  get shell(): RpcShellSession {
    return (this._shell ??= this.kernel.openShell());
  }

  private readonly listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private notify(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  async boot(): Promise<void> {
    if (this.booted) return;
    this.booted = true;
    await this.runtime.boot();
    this._browserBooted = true;
    // Preview reverse-proxy: SW intercepts /__preview__/<port>/ iframe requests
    // and forwards them here to `runtime.dispatch`. Fire-and-forget: SW
    // registration must not block boot, and it self-guards for no-SW envs.
    // Installs the listener + seeds the preview-runtime holder; a later kernel
    // switch re-aims it via `setPreviewRuntime` instead of re-registering.
    void startPreviewProxy(this.runtime);
    this.runs = await loadRuns();
    // Seed the id counter past the loaded runs BEFORE any new line is stamped
    // (normalizeInterruptedRuns appends a marker), so nothing collides with a
    // prior session's persisted ids.
    this.reseedTraceIds();
    // D2: a stored run still marked "running" was interrupted by a reload/crash
    // mid-run (no run survives its session) — normalize it honestly and persist.
    if (this.normalizeInterruptedRuns()) await saveRuns(this.runs);
    try {
      const snap = await this.store.load(SNAPSHOT_ID);
      if (snap) {
        await this.runtime.restoreSnapshot(snap);
        this.logSystem("system", "Restored your project from this browser.");
      } else {
        this.logSystem("system", "Runtime booted. Describe what you want to build.");
      }
    } catch (err) {
      this.logSystem("error", "Could not restore project.", asMessage(err));
    }
    this.subscribeRuntime();
    this.installUnloadFlush();

    // Restore a previously-mounted local folder if permission is still granted.
    try {
      const handle = await loadPersistedHandle();
      if (handle) {
        const perm = (await handle.queryPermission?.({ mode: "readwrite" })) ?? "prompt";
        // Boot's auto-remount re-attaches the SAME project this browser
        // already holds — hydration must MERGE (see hydrateRuns).
        if (perm === "granted") await this.mountFolderWith(handle, "merge");
        else {
          this.pendingMount = handle;
          this.mountName = handle.name;
        }
      }
    } catch (err) {
      this.logSystem("error", "Could not restore mounted folder", asMessage(err));
    }
    this.notify();
  }

  /** A4: a quick reload/close inside a debounce window (snapshot 400 ms, folder
   *  600 ms, runs 500 ms) silently dropped the pending work — terminal/manual
   *  edits made just before Cmd-R were gone. `pagehide` covers close/reload/
   *  navigate; `visibilitychange`→hidden covers mobile tab discard (where
   *  pagehide may never fire). Guarded so the node-environment unit tests can
   *  boot a Studio without DOM globals. */
  private installUnloadFlush(): void {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    window.addEventListener("pagehide", () => this.flushPendingSaves());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.flushPendingSaves();
    });
  }

  /** Cancel every pending debounce timer and kick its save NOW. Inherently
   *  best-effort: IndexedDB/disk writes started during pagehide generally run
   *  to completion, but the platform makes no hard guarantee — acceptable, as
   *  the alternative was certainly losing the debounced work. */
  flushPendingSaves(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      void this.save(); // never rejects; failures land in the systemLog (B2)
    }
    if (this.folderSaveTimer) {
      clearTimeout(this.folderSaveTimer);
      this.folderSaveTimer = undefined;
      void this.saveToFolder(); // catches internally
    }
    if (this.folderStateTimer) {
      clearTimeout(this.folderStateTimer);
      this.folderStateTimer = undefined;
      void this.saveStateToFolder(); // catches internally
    }
    if (this.runsSavePending) {
      void this.flushRunsSave().catch((err) =>
        this.logSystem("error", "Could not persist run history", asMessage(err)),
      );
    }
  }

  /** Subscribe to the active kernel's runtime events (file.changed / port.opened /
   *  port.closed). Extracted from `boot()` so `switchKernel` can unsubscribe from
   *  the outgoing kernel and re-subscribe to the incoming one. */
  private subscribeRuntime(): void {
    this._unsubRuntime = this.runtime.subscribe((e: RuntimeEvent) => {
      if (e.type === "file.changed") {
        this.fsVersion++;
        this.scheduleSave();
        if (this.mount) this.scheduleFolderSave();
        this.notify();
      } else if (e.type === "port.opened") {
        this.logSystem("system", `Port ${e.port} exposed`, e.url);
        if (!this.openPorts.some((p) => p.port === e.port)) this.openPorts = [...this.openPorts, { port: e.port }];
        this.notify();
      } else if (e.type === "port.closed") {
        this.openPorts = this.openPorts.filter((p) => p.port !== e.port);
        this.notify();
      } else if (e.type === "resource.warning") {
        this.logSystem("system", e.detail);
        this.notify();
      }
    });
  }

  /** True when `target` is already the active environment (kind + profile). */
  private sameEnv(target: Environment): boolean {
    if (target.kind !== this.kernel.kind) return false;
    if (target.kind === "browser") return true;
    return (this.kernel.profile ?? "base") === target.profile;
  }

  /** Back-compat: the binary browser/vm toggle, mapped onto `switchEnvironment`.
   *  `switchKernel("vm")` targets the default `base` profile. Retained for the
   *  paths (and tests) that predate per-profile environments. */
  async switchKernel(
    kind: "browser" | "vm",
    opts: { makeKernel?: (o: { onProgress?: (p: string) => void }) => Promise<Kernel> } = {},
  ): Promise<void> {
    const envId = kind === "vm" ? "vm:base" : "browser";
    const userMake = opts.makeKernel;
    return userMake
      ? this.switchEnvironment(envId, { makeKernel: ({ onProgress }) => userMake({ onProgress }) })
      : this.switchEnvironment(envId);
  }

  /**
   * Switch the active environment: the fast browser kernel, or a per-profile
   * Alpine VM kernel (`browser` | `vm:<profile>`). Lazily constructs+boots the
   * target guest (with progress via `switchingKernel`), copies the current
   * workspace across, re-subscribes runtime events, resets the persistent
   * shell, remounts the terminal, and re-aims the preview bridge.
   *
   * One-VM-alive (S6 §3 / T7 amendment): at most one VM guest runs at a time.
   *  - Boot target B FIRST while the outgoing A stays functional (a failed boot
   *    leaves the user on a working kernel; a run can still start during the
   *    cold-boot await, in which case we abort).
   *  - The outgoing VM is torn down LAST, and ONLY when a VM is replaced by a
   *    DIFFERENT VM profile. `vm→browser` KEEPS the VM cached alive for an
   *    instant switch-back; the browser kernel is never shut down.
   */
  async switchEnvironment(
    envId: string,
    opts: { makeKernel?: (o: { profile: VmProfile; onProgress?: (p: string) => void }) => Promise<Kernel> } = {},
  ): Promise<void> {
    const target = parseEnvironmentId(envId);
    // Plan-review I2: the USER-driven switch never runs mid-run — a swap during
    // an agent turn would corrupt the run's diff capture and mis-target
    // autosave. (The agent's own `switchEnvironmentForRun` IS allowed mid-run;
    // it re-points the diff subscription instead.) Also a no-op when already on
    // the target env or a switch is already in flight.
    if (this.sameEnv(target) || this.switchingKernel || this.running) return;
    const makeKernel = opts.makeKernel ?? this.defaultMakeKernel;
    this.switchingKernel = { phase: "Starting…" };
    this.notify();
    try {
      await this.performSwitch(target, makeKernel, { fromRun: false });
    } catch (err) {
      this.logSystem("error", `Failed to switch to ${envId}`, asMessage(err));
    } finally {
      this.switchingKernel = null;
      this.notify();
    }
  }

  /**
   * The sanctioned mid-run environment switch — the ONLY switch permitted while
   * `running`, callable exclusively from the switch_environment tool callback.
   * The agent loop is parked awaiting this tool between calls, so the runtime is
   * idle. Sets `switchingKernel` FIRST (inheriting runServe's refuse + the
   * stale-settle poison path, and blocking a foreign startRun/replyToRun),
   * flushes the VM's coalesced guest `file.changed` batch into the run's diff
   * set before the old subscription is dropped, then runs the T7 swap sequence —
   * `performSwitch` re-points the run-scoped diff subscription so post-switch
   * edits are still captured. Returns the new environment's brief (the model's
   * only in-band update, since the system prompt was built once at run start).
   * On failure it clears state, leaves the current kernel intact, and throws so
   * the tool reports ok:false and the model continues on the old environment.
   */
  private async switchEnvironmentForRun(
    target: string,
    makeKernel: (o: { profile: VmProfile; onProgress?: (p: string) => void }) => Promise<Kernel> = this.defaultMakeKernel,
  ): Promise<string> {
    const env = parseEnvironmentId(target); // fail-fast on an unknown id
    if (this.switchingKernel) throw new Error("A kernel switch is already in progress; try again after it settles.");
    if (this.sameEnv(env)) return this.environmentBrief(target); // already there — report the facts, no switch
    this.switchingKernel = { phase: "Starting…" };
    this.notify();
    try {
      // S4 §2c: flush the coalesced guest file.changed batch into the run's
      // `changed` set BEFORE `performSwitch` drops the old subscription.
      await eventsSettled();
      // performSwitch stops the outgoing serve, mirrors the workspace, swaps the
      // kernel, and re-points the run-scoped diff subscription (fromRun: true
      // skips the mid-boot "run started" abort — the run IS us).
      await this.performSwitch(env, makeKernel, { fromRun: true });
      return this.environmentBrief(target);
    } catch (err) {
      this.logSystem("error", `Failed to switch to ${target}`, asMessage(err));
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      this.switchingKernel = null;
      this.notify();
    }
  }

  /** The default kernel factory: lazily imports vm-kernel (its v86 chunk stays
   *  out of the main bundle). Shared by the user switch and the run switch. */
  private readonly defaultMakeKernel = async (o: {
    profile: VmProfile;
    onProgress?: (p: string) => void;
  }): Promise<Kernel> => (await import("./vm-kernel.js")).createVmKernel(o);

  /**
   * The shared swap core (S6 §3 / T7 sequence), driven by both the user switch
   * and the run-initiated switch. Boots/resolves target B while the outgoing A
   * stays functional, then — unless a user switch aborts because a run started
   * during the cold boot — stops the outgoing serve, mirrors the workspace,
   * swaps the kernel (re-pointing runtime events, the persistent shell, the PTY
   * generation, the run-scoped diff subscription and the preview bridge), and
   * retires the outgoing VM LAST when a VM is replaced by a DIFFERENT VM profile.
   */
  private async performSwitch(
    target: Environment,
    makeKernel: (o: { profile: VmProfile; onProgress?: (p: string) => void }) => Promise<Kernel>,
    opts: { fromRun: boolean },
  ): Promise<void> {
    const outgoing = this.kernel;
    const outgoingIsVm = outgoing.kind === "vm";
    // ---- resolve/boot the target kernel B (A untouched) ----
    let next: Kernel;
    let bootedNew = false;
    if (target.kind === "browser") {
      next = this.browserKernel;
      if (!this._browserBooted) {
        await next.runtime.boot(); // (browser boots once)
        this._browserBooted = true;
      }
    } else if (this.vmKernel && (this.vmKernel.profile ?? "base") === target.profile) {
      next = this.vmKernel; // plan-review I4: reuse the already-booted guest for this profile
    } else {
      // Booting a NEW guest for `target.profile`.
      if (!outgoingIsVm && this.vmKernel) {
        // Browser is active and a DIFFERENT-profile VM is cached — it is a
        // stale mirror (the browser fs is the live truth), so retire it FIRST
        // to avoid ever holding two guests at once (S6 §3 bullet 1).
        await this.vmKernel.shutdown?.().catch((e) => this.logSystem("system", "VM shutdown error", asMessage(e)));
        this.vmKernel = null;
      }
      next = await makeKernel({
        profile: target.profile,
        onProgress: (p) => {
          this.switchingKernel = { phase: p };
          this.notify();
        },
      });
      bootedNew = true;
      // Browser-active boot: cache eagerly so an abort (below) still keeps the
      // booted guest for next time. A VM-active boot keeps the cache pointing
      // at the OUTGOING guest until the swap succeeds (one-VM-alive on abort).
      if (!outgoingIsVm) this.vmKernel = next;
    }
    // Final-review Fix 1: re-check AFTER the boot/reuse await window — a run can
    // START while we were awaiting the cold VM boot. This applies ONLY to a
    // user switch; a run-initiated switch IS the run (`this.running` is true by
    // construction), so it must not abort here. Abort: a freshly-booted VM that
    // would strand a second guest is torn down; otherwise it stays cached.
    if (!opts.fromRun && this.running) {
      this.logSystem("system", "Kernel switch cancelled — a run started during boot.");
      if (bootedNew && outgoingIsVm) await next.shutdown?.().catch(() => {});
      return;
    }
    // Kernel-switch port hygiene (deferred T6a + stale chips): the preview
    // surface does not follow the kernel. Runs BEFORE the swap, while
    // `this.runtime` still targets the OUTGOING kernel — killing the detached
    // server frees its real guest socket (an orphan would EADDRINUSE the next
    // serve after a switch-back; the VM's closePort is pure bookkeeping), and
    // closing tracked ports frees the browser kernel's virtual-port registry
    // the same way. The old server is unreachable post-swap anyway: the SW
    // proxy is re-aimed below, and the old fs is a frozen mirror. (Placed after
    // the boot so a failed boot leaves the outgoing serve untouched — the
    // run-initiated switch's failure path relies on this to keep A pristine.)
    await this.stopTrackedServe();
    // copy the current workspace into the target kernel so the project follows.
    // MUST precede A's shutdown: a VM's SyncFs reads die with its host.destroy().
    copyWorkspace(outgoing.fs, next.fs);
    // Leak convergence (the browser-kernel /etc,/root-on-disk bug): converge
    // any VM_PRESERVE_DIRS names sitting at the BROWSER Vfs root on a
    // vm→browser swap. copyWorkspace never carries those names across at root
    // in either direction, and its mirror-clear PRESERVES them (the shield
    // exists for the live guest's bind mounts + baked config on a copy INTO a
    // VM), so once leaked they'd survive forever — and the browser kernel's
    // folder auto-save passes no rootSkip, dumping /etc,/root onto the user's
    // mounted disk. BUT the name alone doesn't prove leakage (mounted repos
    // and agents legitimately create root bin/lib/tmp/…), so the cleanup
    // discriminates per entry — see cleanLeakedVmEntries. Runs AFTER
    // copyWorkspace so its quarantine renames aren't erased by the mirror-clear.
    if (outgoingIsVm && target.kind === "browser") await this.cleanLeakedVmEntries(next.fs);
    // swap: unsubscribe old runtime events, point at the new kernel, re-subscribe
    this._unsubRuntime?.();
    this.kernel = next;
    this._shell = undefined; // the `shell` getter re-opens on the new kernel
    this.kernelGeneration++; // C2: remount the PTY terminal onto the new guest
    this.subscribeRuntime();
    // Re-point the run-scoped diff subscription onto the new runtime (no-op
    // outside a run — a user switch can't happen mid-run). AFTER copyWorkspace
    // so the copy's synchronous file.changed events stay out of the run's diff.
    this.repointRunDiff?.();
    setPreviewRuntime(this.runtime); // plan-review I5: re-aim the (already-installed) preview bridge
    this.fsVersion++;
    // One-VM-alive: retire the outgoing VM LAST (after the swap, so a shutdown
    // failure can't strand the UI), and ONLY when it is being replaced by a
    // DIFFERENT VM profile. `vm→browser` KEEPS the VM cached (instant back).
    if (outgoingIsVm && next.kind === "vm") {
      await outgoing.shutdown?.().catch((e) => this.logSystem("system", "VM shutdown error", asMessage(e)));
      this.vmKernel = next;
    }
    // Note (plan-review M1): persistence uses one shared SNAPSHOT_ID across both
    // kernels — intentionally last-writer-wins, since there is one logical
    // project that follows the toggle. A snapshot saved by either kernel is a
    // contract-level `Snapshot`, restorable by the other on next boot.
    this.logSystem(
      "system",
      target.kind === "vm" ? `Switched to the Linux VM (${target.profile}).` : "Switched to the browser kernel.",
    );
  }

  /**
   * Leak convergence for a vm→browser swap: resolve every VM_PRESERVE_DIRS
   * name at the browser Vfs root. Such a name is USUALLY VM infrastructure
   * leaked by a pre-R13 switch, but not always — mounted repos carry root
   * bin/, lib/, tmp/ (Rails/Ruby layouts) into the Vfs via loadFolderIntoVfs
   * (which applies no rootSkip), and agents/users create such dirs directly on
   * the browser kernel. Deleting those on name alone destroys project data,
   * and the next Push would then prune them off the user's REAL disk. So each
   * entry is discriminated instead of blanket-removed:
   *  - disk-backed (the mounted folder has a same-named root entry, or
   *    recorded mount mtimes exist beneath it): project data — left untouched;
   *  - empty (no non-directory entry anywhere beneath): removing it can lose
   *    nothing — removed. Covers the leaked skeleton stubs (bin/lib/usr/…);
   *  - otherwise (non-empty, not disk-backed — a pre-R13 leaked /etc,/root OR
   *    a project dir made right here): ambiguous, so it is set ASIDE by
   *    renaming to `<name>.vm-leaked` rather than destructively rm'd — a real
   *    leak stops colliding with the VM's image-owned names either way, while
   *    a misjudged project dir stays fully recoverable.
   * Recorded mount mtimes under every removed/renamed path are dropped so the
   * rescan can re-pull a same-named dir that legitimately appears on disk.
   * Logs ONE line naming everything it did; silent when there is nothing to do.
   */
  private async cleanLeakedVmEntries(fs: FileSystemApi): Promise<void> {
    const suspects = fs
      .readdir("/")
      .filter((e) => VM_PRESERVE_DIRS.includes(e.name))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    const removed: string[] = [];
    const setAside: string[] = [];
    for (const entry of suspects) {
      const path = `/${entry.name}`;
      const diskBacked =
        this.mount !== null &&
        (hasMtimeUnder(this.mountMtimes, path) || (await diskHasEntry(this.mount, entry.name)));
      if (diskBacked) continue; // the mounted repo's own root bin/lib/tmp/… — never leakage
      if (entry.type === "directory" && !dirHasContent(fs, path)) {
        fs.rm(path, { recursive: true, force: true });
        removed.push(path);
      } else {
        let target = `${path}.vm-leaked`;
        for (let i = 2; fs.exists(target); i++) target = `${path}.vm-leaked-${i}`;
        fs.rename(path, target);
        setAside.push(`${path} → ${target}`);
      }
      dropMtimesUnder(this.mountMtimes, path);
    }
    if (removed.length === 0 && setAside.length === 0) return;
    const actions = [
      removed.length > 0 ? `removed ${removed.join(", ")}` : "",
      setAside.length > 0 ? `set aside ${setAside.join(", ")} (delete these if they are not project files)` : "",
    ].filter((s) => s !== "");
    this.logSystem(
      "system",
      `Cleaned VM system entries that had leaked into the browser workspace: ${actions.join("; ")}.`,
    );
  }

  /** A full-facts brief of an environment for the switch tool's result — the
   *  model's only in-band update after a mid-run switch (the system prompt was
   *  built once at run start; reply turns do not rebuild it). Covers the
   *  interpreters, package managers, network egress and install recipes. */
  private environmentBrief(envId: string): string {
    const env = environmentById(envId);
    const egress =
      env.kernel === "vm"
        ? "Network egress: real — pip/npm reach live registries through the package gateway (CORS-bound)."
        : "Network egress: none for shell commands; micropip fetches pure-Python wheels from PyPI only.";
    return [
      `Switched to ${env.label} (${env.id}). Your workspace was copied over.`,
      `Interpreters: ${env.interpreters.join(", ")}.`,
      `Package managers: ${env.packageManagers.join(", ")}.`,
      egress,
      `Speed: ${env.speed}.`,
      ...env.installRecipes.map((r) => `Install: ${r}`),
    ].join("\n");
  }

  /** Mount a local folder. With NOTHING mounted this is the boot/reconnect/
   *  first-mount path: the folder's files replace the workspace (A2) and its
   *  `.erdou` session state hydrates in "merge" mode (the async-mount race
   *  protection — see hydrateRuns). With a folder ALREADY mounted, picking a
   *  DIFFERENT one is an EXPLICIT project change: it routes through
   *  `swapMountedFolder` (the exact contract of the re-select control), so the
   *  old project's chat history can never merge into the new project's
   *  `.erdou/` — before this routing, the sidebar's Open-folder path ran the
   *  merge and rescued the old project's memory-newer runs straight into the
   *  new folder's runs.json (cross-project contamination). Re-picking the
   *  folder that is ALREADY mounted (`isCurrentMount`) is NOT a project
   *  change — it re-attaches the SAME project, so it takes the merge path
   *  like any reconnect: the swap's stop+replace would kill a live turn for
   *  no reason and then read back its just-flushed "running" copy as a
   *  detached ghost — stuck "running" in the sidebar for the session,
   *  persisted that way, and later mis-normalized as "the page was closed". */
  async mountFolder(handle: DirHandleLike): Promise<void> {
    if (this.mount && !(await this.isCurrentMount(handle))) return this.swapMountedFolder(handle);
    return this.mountFolderWith(handle, "merge");
  }

  /** True when `handle` designates the directory that is already mounted. A
   *  real re-pick hands back a FRESH FileSystemDirectoryHandle object for the
   *  same directory, so identity alone can't detect it — the platform's
   *  `isSameEntry` does (typed structurally here: `DirHandleLike` is the sync
   *  seam's minimal surface and predates the method; every real handle has
   *  it). Without identity and without the method the handle counts as a
   *  DIFFERENT folder — the data-safe default is the swap's stop+flush+replace. */
  private async isCurrentMount(handle: DirHandleLike): Promise<boolean> {
    if (this.mount === null) return false;
    if (handle === this.mount) return true;
    const h = handle as DirHandleLike & { isSameEntry?: (other: DirHandleLike) => Promise<boolean> };
    return (await h.isSameEntry?.(this.mount)) === true;
  }

  private async mountFolderWith(handle: DirHandleLike, hydration: "merge" | "replace"): Promise<void> {
    // A2 (data safety): the folder is the source of truth on mount — the same
    // rule `swapMountedFolder` enforces. boot() restores the previous project
    // into the VFS before a persisted mount reconnects, and `loadFolderIntoVfs`
    // only ever ADDS files, so mounting into a non-empty workspace would make
    // it old ∪ folder — and the next auto-save/Push would then write last
    // session's files onto the freshly mounted disk (e.g. polluting a clean
    // git repo). So a non-empty workspace is cleared first (on the VM kernel
    // its image-owned root dirs are kept; on the browser kernel EVERY root
    // entry counts and goes — a preserve-named /lib or /etc there is the old
    // project's, or stale VM leakage, never the guest's), with the folder
    // auto-save suspended across the clear+load so the churn can't mirror a
    // half-loaded state onto any disk. Note the replaced in-browser project is
    // NOT retained anywhere: the snapshot save that follows the load
    // overwrites it with the folder contents.
    const hadProject = this.fs
      .readdir("/")
      .some((e) => this.kernelKind !== "vm" || !VM_PRESERVE_DIRS.includes(e.name));
    const suspend = hadProject && !this.swappingFolder; // a swap already suspended + pre-cleared
    if (suspend) {
      this.swappingFolder = true;
      // Kill any save a previously mounted folder had pending — it must not
      // fire mid-load against either folder.
      if (this.folderSaveTimer) {
        clearTimeout(this.folderSaveTimer);
        this.folderSaveTimer = undefined;
      }
    }
    let count: number;
    try {
      if (hadProject) {
        this.clearWorkspace();
        this.mountMtimes.clear();
        this.logSystem(
          "system",
          `Replaced the in-browser workspace with the contents of "${handle.name}" — a mounted folder is the source of truth.`,
        );
      }
      count = await loadFolderIntoVfs(handle, this.fs, "/", this.mountMtimes);
    } finally {
      if (suspend) this.swappingFolder = false;
    }
    // Read `.erdou/` BEFORE `this.mount` is set: scheduleFolderStateSave no-ops
    // while unmounted, so a debounced state save — e.g. one scheduled by a run
    // started while this async mount is still in flight (boot() is
    // fire-and-forget in use-studio.ts; the UI is fully interactive) — can
    // never fire mid-read and clobber the folder's runs.json with memory-only
    // state that hydration would then read back as "the folder's history".
    // The result is applied below, after the mount is announced, so the log
    // order the user sees is unchanged.
    let state: FolderState | null = null;
    let stateFailed = false;
    let stateError: unknown;
    try {
      state = await readFolderState(handle);
    } catch (err) {
      stateFailed = true;
      stateError = err;
    }
    this.mount = handle;
    this.mountName = handle.name;
    this.pendingMount = null;
    await persistHandle(handle);
    this.fsVersion++;
    this.logSystem("system", `Mounted local folder "${handle.name}" (${count} files). Changes now sync back to disk.`);

    // The folder is the source of truth for session state: if it already has
    // an `.erdou/`, hydrate from it (chat history + theme/approval/model incl.
    // the api key); otherwise seed it from what we have now.
    try {
      if (stateFailed) throw stateError;
      if (state) {
        const rescued = this.hydrateRuns(state.runs, hydration);
        // Folder-hydrated runs join `this.runs`, so the boot-time interrupted-run
        // normalization must apply here too (skipped while a run is actually live now).
        if (!this.running && this.normalizeInterruptedRuns()) this.scheduleFolderStateSave();
        // A rescued run's CURRENT state exists only in memory — the folder's
        // runs.json lacks it entirely (memory-only run) or holds a superseded
        // same-id copy — so persist the merged list (this is exactly the state
        // the old wholesale replace kept out of `.erdou/runs.json` forever).
        // A "replace" hydration rescues nothing: runs.json already IS the list.
        if (rescued > 0) this.scheduleFolderStateSave();
        if (state.config) {
          applyTheme(state.config.theme);
          saveApprovalMode(state.config.approvalMode);
          saveModel(state.config.model);
          this.configVersion++;
        }
        this.logSystem("system", "Loaded session state from .erdou/ — the folder is now the source of truth.");
      } else {
        await writeFolderState(handle, this.currentState());
      }
    } catch (err) {
      this.logSystem("error", "Could not load/seed .erdou/ session state", asMessage(err));
    }

    this.startMountWatcher();
    this.notify();
  }

  /**
   * Hydrate `this.runs` from a mounted folder's `.erdou/runs.json`. Two modes,
   * chosen EXPLICITLY by the caller — which one applies is a product decision
   * about what the mount MEANS, never a race outcome:
   *
   * `"merge"` — boot()'s auto-remount, `reconnectMount`, and a first mount
   * with nothing mounted yet. These re-attach the project whose history this
   * browser already holds, asynchronously, while the UI stays fully
   * interactive — so a run can be created (or finish) while `readFolderState`
   * is still in flight, and a wholesale replace wiped it mid-turn: it
   * vanished from the sidebar and never reached `.erdou/runs.json` (nor
   * IndexedDB after the turn's final save). Merge semantics:
   *  - a run an agent turn drove THIS SESSION (`turnRunIds` — includes the
   *    turn in flight right now) always keeps its memory object, same-id or
   *    not, even against future-dated folder timestamps (another machine's
   *    clock): this session's copy is strictly ahead of the folder's. This is
   *    what saves a reply to a folder-shared run that COMPLETED inside the
   *    mount window;
   *  - otherwise, same id on both sides → LAST-ACTIVITY recency decides: the
   *    copy whose final trace line has the later `ts` wins (`createdAt` when
   *    a copy has no trace). This rescues a PREVIOUS session's reply that
   *    reached IndexedDB but missed the folder's debounced flush — under the
   *    old flat "folder wins" rule the folder's pre-reply copy silently
   *    reverted it. A tie keeps the FOLDER's copy: for shared history the
   *    folder stays the source of truth (the cross-machine staleness bias).
   *    Recency counts REAL activity only: the boot-time "Interrupted" marker
   *    is stamped with its run's prior last-activity ts, never Date.now()
   *    (see normalizeInterruptedRuns), so a crashed session's stale copy
   *    cannot out-recency a folder copy genuinely advanced on another
   *    machine;
   *  - a memory-only run STRICTLY NEWER (`createdAt`) than every folder run
   *    is kept, ahead of the folder's runs (most-recent-first order): e.g.
   *    last session's tail that reached IndexedDB but missed the folder flush;
   *  - any other memory-only run is dropped: browser-local history the folder
   *    state supersedes (the pre-existing "folder is the source of truth"
   *    rule, now scoped to runs the folder can actually supersede);
   *  - belt-and-suspenders: a run that is status "running" while
   *    `this.running` keeps its memory object too — that object is the only
   *    truth of the running turn (dropping/replacing it detaches the turn, so
   *    its final status/trace/changes would evaporate at turn end). Normally
   *    redundant with `turnRunIds`; still checked so a stale "running" copy
   *    that slipped past the skipped-while-live normalization errs toward
   *    keeping (sidebar noise, chosen over risking a live turn).
   *
   * `"replace"` — an EXPLICIT folder swap (`swapMountedFolder`: the re-select
   * control, and `mountFolder` over an already-mounted folder). The user
   * chose a different project, so its `.erdou` is the sole source of truth
   * and NO memory run may survive into it: rescuing the old project's chat
   * here wrote its task text and traces into the new project's runs.json —
   * cross-project contamination (`.erdou/.gitignore` only covers config.json,
   * so that chat became committable into the new repo). Wholesale replace is
   * lossless only because of `swapMountedFolder`'s ordered steps: it stops a
   * live turn, flushes the old project's FULL in-memory state to its own
   * `.erdou` first (aborting the swap if that write fails), and blocks new
   * turns until the swap settles — see its doc for where the old history
   * actually lives afterwards.
   *
   * Either way a dangling `activeRunId` (its run was dropped) resets to null.
   * Returns how many memory runs were kept so the caller can persist the
   * merged list back to `.erdou/` — a kept run is one whose current state the
   * folder doesn't have yet (memory-only, or a superseded same-id copy).
   * Always 0 in "replace" mode.
   */
  private hydrateRuns(folderRuns: Run[], mode: "merge" | "replace"): number {
    if (mode === "replace") {
      this.runs = [...folderRuns];
      this.reseedTraceIds(); // folder runs came from other sessions — bump past their ids
      if (this.activeRunId !== null && !this.runs.some((r) => r.id === this.activeRunId)) this.activeRunId = null;
      return 0;
    }
    const isLive = (r: Run): boolean => this.running && r.status === "running";
    const lastActivity = (r: Run): number => r.trace.at(-1)?.ts ?? r.createdAt;
    const folderById = new Map(folderRuns.map((r) => [r.id, r]));
    const newestFolder = folderRuns.reduce((max, r) => Math.max(max, r.createdAt), 0);
    const kept = this.runs.filter((r) => {
      if (isLive(r) || this.turnRunIds.has(r.id)) return true;
      const folderCopy = folderById.get(r.id);
      if (folderCopy !== undefined) return lastActivity(r) > lastActivity(folderCopy);
      return r.createdAt > newestFolder;
    });
    const keptIds = new Set(kept.map((r) => r.id));
    this.runs = [...kept, ...folderRuns.filter((r) => !keptIds.has(r.id))];
    this.reseedTraceIds(); // merged-in folder runs came from other sessions — bump past their ids
    if (this.activeRunId !== null && !this.runs.some((r) => r.id === this.activeRunId)) this.activeRunId = null;
    return kept.length;
  }

  /** Snapshot of what would be written to `.erdou/` right now. */
  private currentState(): FolderState {
    return {
      runs: this.runs,
      config: { theme: getTheme(), approvalMode: loadApprovalMode(), model: loadModel() },
    };
  }

  /** Debounce-write session state (runs + config) to `.erdou/`. No-op if
   *  nothing is mounted. Call after a run change (start/finish) or a
   *  theme/approval-mode/model-config change. */
  private scheduleFolderStateSave(): void {
    if (!this.mount) return;
    if (this.folderStateTimer) clearTimeout(this.folderStateTimer);
    this.folderStateTimer = setTimeout(() => {
      this.folderStateTimer = undefined; // fired — a later flushPendingSaves must not re-kick it
      void this.saveStateToFolder();
    }, 600);
  }
  private async saveStateToFolder(): Promise<void> {
    if (!this.mount) return;
    try {
      await writeFolderState(this.mount, this.currentState());
    } catch (err) {
      this.logSystem("error", "Failed to sync session state to local folder", asMessage(err));
    }
  }

  /** Call after a theme/approval-mode/model-config change so a mounted
   *  folder's `.erdou/` stays current. No-op if nothing is mounted. */
  saveConfigToFolder(): void {
    this.scheduleFolderStateSave();
  }

  /** Re-grant permission to a persisted mount (needs a user gesture). The
   *  SAME project reconnecting — hydration merges (see hydrateRuns). */
  async reconnectMount(): Promise<boolean> {
    const handle = this.pendingMount;
    if (!handle) return false;
    const perm = (await handle.requestPermission?.({ mode: "readwrite" })) ?? "denied";
    if (perm !== "granted") return false;
    await this.mountFolderWith(handle, "merge");
    return true;
  }

  async unmount(): Promise<void> {
    this.stopMountWatcher();
    if (this.folderStateTimer) {
      clearTimeout(this.folderStateTimer);
      this.folderStateTimer = undefined;
    }
    this.mount = null;
    this.mountName = null;
    this.pendingMount = null;
    await clearPersistedHandle();
    // this.runs is left as-is; future changes go back to IndexedDB via saveRuns.
    this.notify();
  }

  /** Poll the mounted folder for external disk edits (focus + every 5s) and pull them into the VFS. */
  private startMountWatcher(): void {
    this.stopMountWatcher();
    const tick = async () => {
      if (!this.mount || document.hidden) return;
      try {
        const pulled = await rescanFolder(this.mount, this.fs, this.mountMtimes, "/");
        if (this.mountRescanFailed) {
          this.mountRescanFailed = false;
          // Rescans work again — retire the pinned failure line (B3/B2).
          this.dropSystemErrors(RESCAN_FAILED_TEXT);
          this.logSystem("system", "Mount rescan recovered — external disk edits are syncing again.");
        }
        if (pulled.length) {
          // Pulled paths are the USER's external edits — keep them out of an
          // in-flight run's diff (see the attribution rule in runAgentTurn).
          await this.discountExternalPulls?.(pulled);
          // Two-sided edits resolve disk-wins here: a file the auto-save just
          // skipped as an external-edit conflict is now being pulled over the
          // workspace copy — say so instead of letting the local edit vanish.
          const conflicted = new Set(this.lastFolderConflictsKey.split("\n"));
          const overwritten = pulled.filter((p) => conflicted.has(p));
          if (overwritten.length > 0) {
            this.logSystem(
              "system",
              `Disk edits replaced the workspace copy of: ${overwritten.join(", ")} (both sides had changed; disk wins on rescan).`,
            );
            this.lastFolderConflictsKey = "";
          }
          this.fsVersion++;
          this.notify(); // belt-and-suspenders: file.changed already fired per pulled file
        }
      } catch (err) {
        // Guard against logging (and notifying) every 5s while the rescan keeps
        // failing the same way — only surface it once until a rescan succeeds.
        if (!this.mountRescanFailed) {
          this.mountRescanFailed = true;
          this.logSystem("error", RESCAN_FAILED_TEXT, asMessage(err));
        }
      }
    };
    const onFocus = () => void tick();
    window.addEventListener("focus", onFocus);
    const interval = setInterval(() => void tick(), 5000);
    this.mountWatch = { interval, onFocus };
  }
  private stopMountWatcher(): void {
    if (!this.mountWatch) return;
    clearInterval(this.mountWatch.interval);
    window.removeEventListener("focus", this.mountWatch.onFocus);
    this.mountWatch = undefined;
  }

  private scheduleFolderSave(): void {
    // A folder swap (re-select) is mid-flight repointing the mount to a DIFFERENT
    // folder: the clear-then-load emits file.changed for every entry, and letting
    // any of that schedule a save would mirror a half-swapped workspace onto disk
    // (the old project onto the new folder, or a partially-loaded new folder onto
    // the old one). swapMountedFolder re-enables saving once the new folder is the
    // sole source of truth.
    if (this.swappingFolder) return;
    if (this.folderSaveTimer) clearTimeout(this.folderSaveTimer);
    this.folderSaveTimer = setTimeout(() => {
      this.folderSaveTimer = undefined; // fired — a later flushPendingSaves must not re-kick it
      void this.saveToFolder();
    }, 600);
  }
  /** Conflict set of the previous auto-save, as a joined key — the conflict log
   *  fires on content transitions only, so the 600ms debounce can't spam the
   *  system log with the same unresolved files. */
  private lastFolderConflictsKey = "";
  async saveToFolder(): Promise<void> {
    if (!this.mount) return;
    try {
      // The VM kernel's readdir("/") exposes its skeleton bind-mount stub dirs
      // (bin/lib/usr/proc/dev/tmp) AND its baked config dirs (/etc pip.conf +
      // resolv.conf, /root .npmrc) — never write those image-owned dirs into
      // the user's real folder (R12.5 IMP2 class). VM_PRESERVE_DIRS = skeleton
      // + etc + root; SKELETON_DIRS alone would dump /etc/pip.conf onto disk.
      const result = await saveVfsToFolder(
        this.fs,
        this.mount,
        "/",
        this.mountMtimes,
        this.kernelKind === "vm" ? new Set(VM_PRESERVE_DIRS) : undefined,
      );
      const key = [...result.conflicts].sort().join("\n");
      if (key !== this.lastFolderConflictsKey && key !== "") {
        const shown = result.conflicts.slice(0, 3).join(", ");
        const more = result.conflicts.length > 3 ? ` (+${result.conflicts.length - 3} more)` : "";
        this.logSystem(
          "error",
          `${result.conflicts.length} file(s) changed on disk outside Erdou and were not overwritten: ${shown}${more}`,
          "Pull from disk ↓ to bring the external edits into the workspace, or Push to disk ↑ deliberately.",
        );
      }
      this.lastFolderConflictsKey = key;
    } catch (err) {
      this.logSystem("error", "Failed to sync to local folder", asMessage(err));
    }
  }

  // --- explicit MANUAL folder-sync (alongside the auto-sync above, not a
  //     replacement): one-shot pull/push and a folder swap, driven from
  //     FolderSyncControls. They reuse the same primitives + mtimes map + VM
  //     rootSkip as the auto path, so the two can't drift. Errors propagate to
  //     the caller (the UI shows them) rather than being swallowed here.

  /** Manual "Pull from disk ↓": mirror the mounted folder into the workspace
   *  now — disk wins on content AND workspace entries absent on disk are
   *  deleted (distinct from the additive mtime-gated background rescan),
   *  honoring VM_PRESERVE_DIRS at root on the VM kernel exactly like the auto
   *  save path so image-owned dirs survive the delete pass. Returns the pull
   *  result for the UI to report, or null if nothing is mounted. */
  async pullFolderNow(): Promise<FolderPullResult | null> {
    if (!this.mount) return null;
    const result = await pullDiskToWorkspace(
      this.mount,
      this.fs,
      this.mountMtimes,
      this.kernelKind === "vm" ? new Set(VM_PRESERVE_DIRS) : undefined,
    );
    this.fsVersion++;
    this.notify();
    return result;
  }

  /** Manual "Push to disk ↑": mirror the workspace onto the mounted folder now
   *  (writes + deletes disk-only entries + skips externally-edited conflicts),
   *  honoring VM_PRESERVE_DIRS at root on the VM kernel exactly like the auto
   *  save path. Returns the mirror result for the UI to report, or null if
   *  nothing is mounted. */
  async pushFolderNow(): Promise<FolderMirrorResult | null> {
    if (!this.mount) return null;
    return pushWorkspaceToDisk(
      this.mount,
      this.fs,
      this.mountMtimes,
      this.kernelKind === "vm" ? new Set(VM_PRESERVE_DIRS) : undefined,
    );
  }

  /** Manual "Re-select folder": re-run the directory picker to swap to a
   *  DIFFERENT local folder, replacing the current mount. Needs a user gesture.
   *  Returns true if a new folder was mounted, false if the user cancelled the
   *  picker. Routes through `swapMountedFolder` so the newly-picked folder
   *  becomes the sole source of truth — files AND session state. */
  async reselectFolder(): Promise<boolean> {
    const picker = (window as unknown as { showDirectoryPicker?: (o?: unknown) => Promise<unknown> })
      .showDirectoryPicker;
    if (!picker) throw new Error("Folder mounting needs the File System Access API — use Chrome or Edge.");
    const handle = await reselectFolderOp(
      () => picker({ mode: "readwrite" }) as Promise<DirHandleLike>,
      (h) => this.swapMountedFolder(h),
    );
    return handle !== null;
  }

  /**
   * Swap the mounted folder for a DIFFERENT one (reached from the re-select
   * control AND from `mountFolder` over an already-mounted folder — both are
   * the user explicitly choosing another project), which becomes the SOLE
   * source of truth: files AND session state. `mountFolderWith` clears a
   * non-empty workspace itself (A2), but a swap must ALSO hold the folder
   * auto-save suspension across the ENTIRE clear→load flow and drop the OLD
   * folder's pending save + stale mtimes even when the workspace happens to
   * be empty — the ~600 ms folder auto-save must never mirror a half-swapped
   * workspace onto either disk (e.g. dirtying a `.git` repo).
   *
   * Session state hydrates in "replace" mode: NO memory run survives into
   * the new folder (see hydrateRuns — the merge's rescue rules carried the
   * old project's chat straight into the new project's runs.json). That is
   * lossless ONLY because of the ordered steps below; after them, the old
   * project's history survives in EXACTLY ONE place — its own
   * `.erdou/runs.json`. It is NOT in IndexedDB anymore (the final step
   * overwrites that with the new folder's history, or a reload would
   * resurrect it) and not in memory.
   */
  private async swapMountedFolder(handle: DirHandleLike): Promise<void> {
    const prev = this.mount;
    if (!prev) throw new Error("swapMountedFolder requires a mounted folder to swap away from");
    this.swappingFolder = true; // suspends the folder auto-save AND blocks startRun/replyToRun until the swap settles
    try {
      // 1) Kill any file auto-save the OLD folder had pending — it must not
      //    fire against either disk mid-swap.
      if (this.folderSaveTimer) {
        clearTimeout(this.folderSaveTimer);
        this.folderSaveTimer = undefined;
      }
      // 2) A turn in flight is the OLD project's work, driving its tools
      //    against the workspace we are about to replace — stop it now
      //    (abort at its next agent checkpoint + deny a parked approval).
      //    Its object is pruned in step 4; everything it did up to here is
      //    flushed to the old folder in step 3, whose "running" copy the next
      //    mount normalizes to an honest interrupted-error. Known residue: a
      //    tool already executing when the abort lands can still finish, and
      //    that post-flush tail dies with the pruned object.
      if (this.running) {
        this.stopRun();
        this.logSystem("system", "Stopped the running task — swapping to a different project folder.");
      }
      // 3) Flush the old project's session state to its `.erdou`
      //    UNCONDITIONALLY — not just a pending debounce: mid-turn trace
      //    lines only schedule the IndexedDB runs-save, never a folder-state
      //    save, so runs.json can lag the in-memory truth with NO timer
      //    pending. THROWS on failure, aborting the swap before anything is
      //    destroyed (the old folder stays mounted, runs stay in memory) —
      //    a failed swap beats silently losing unsaved chat.
      if (this.folderStateTimer) {
        clearTimeout(this.folderStateTimer);
        this.folderStateTimer = undefined;
      }
      await writeFolderState(prev, this.currentState());
      // 4) Drop the old project's session state from memory wholesale: runs,
      //    the session `turnRunIds` marks (they must not rescue anything
      //    through the new folder's hydration), and the selection.
      this.runs = [];
      this.turnRunIds = new Set();
      this.activeRunId = null;
      // 5) Stand "unmounted" until mountFolderWith announces the new folder:
      //    a state save scheduled mid-swap (e.g. the stopped turn settling
      //    during a slow load) would otherwise write onto the old disk
      //    (scheduleFolderStateSave/saveStateToFolder no-op while unmounted;
      //    the old watcher tick guards on `this.mount` too).
      this.mount = null;
      this.clearWorkspace();
      this.mountMtimes.clear();
      await this.mountFolderWith(handle, "replace");
      // 6) Mirror the project change into IndexedDB: boot() seeds `this.runs`
      //    from there, so leaving the old history behind would resurrect it
      //    into the new folder through the NEXT session's auto-remount
      //    hydration (the same contamination, one reload later). Logged, not
      //    thrown — the swap itself succeeded.
      await this.flushRunsSave().catch((err) =>
        this.logSystem("error", "Could not persist the swapped run history to this browser", asMessage(err)),
      );
    } finally {
      this.swappingFolder = false;
    }
  }

  /** Delete every project entry from the VFS root so a newly-mounted folder is
   *  the workspace's only source. On the VM kernel the image-owned root dirs
   *  (`VM_PRESERVE_DIRS` — skeleton bind mounts + baked /etc,/root) are the
   *  GUEST's, not the project's, and stay (mirrors `copyWorkspace`'s top-level
   *  clear). On the BROWSER kernel nothing at root is image-owned — a
   *  preserve-named /lib or /etc there is the old project's own dir or stale
   *  VM leakage, and keeping it would union it onto the freshly mounted
   *  folder's disk via the auto-save: exactly the A2 pollution this clear
   *  exists to prevent. */
  private clearWorkspace(): void {
    const preserved: readonly string[] = this.kernelKind === "vm" ? VM_PRESERVE_DIRS : [];
    for (const entry of this.fs.readdir("/")) {
      if (preserved.includes(entry.name)) continue;
      this.fs.rm(`/${entry.name}`, { recursive: true, force: true });
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined; // fired — a later flushPendingSaves must not re-kick it
      void this.save();
    }, 400);
  }

  /** True while snapshot saving is failing (quota / restricted storage): set by
   *  the first failed save, cleared by the next successful one. The systemLog
   *  carries the transition lines; the UI can watch this flag for a persistent
   *  "your work is not being saved" state. */
  lastSaveFailed = false;

  /** Persist the workspace snapshot to IndexedDB. Never rejects (B2): the
   *  debounced caller discards the promise, so a quota/restricted-storage
   *  failure used to vanish — the user found out only on the next reload, with
   *  the project gone. Logs on failure-state TRANSITIONS only (first failure +
   *  recovery), not on every failing 400 ms debounce, so a persistently full
   *  disk can't spam the log. */
  async save(): Promise<void> {
    try {
      await this.store.save(SNAPSHOT_ID, await this.runtime.createSnapshot());
      if (this.lastSaveFailed) {
        this.lastSaveFailed = false;
        // Saving works again — the pinned "Couldn't save…" strip line would
        // otherwise assert a data-loss condition that is no longer true (B3/B2).
        this.dropSystemErrors(SAVE_FAILED_TEXT);
        this.logSystem("system", "Project saving recovered — your work is being stored in this browser again.");
      }
    } catch (err) {
      const firstFailure = !this.lastSaveFailed;
      this.lastSaveFailed = true;
      if (firstFailure) {
        this.logSystem("error", SAVE_FAILED_TEXT, asMessage(err));
      }
    }
  }

  private line(kind: TraceKind, text: string, detail?: string, ok?: boolean): TraceLine {
    return { id: this.nextId++, kind, text, detail, ok, ts: Date.now() };
  }

  /** Advance the trace-line id counter past every id currently in memory (loaded
   *  runs, hydrated folder runs, the system log). `TraceLine.id` doubles as the
   *  React reconciliation key AND the update key for id-based rewrites
   *  (`makeSubagentReporter`), so ids MUST stay unique across every run held at
   *  once. `nextId` resets to 1 each page load and prior sessions/other machines
   *  also started at 1 — so without this, runs from different sessions carry
   *  colliding ids and switching/replying mixes their chat lines. Call it
   *  whenever runs enter memory (boot load, folder hydration). Idempotent — only
   *  ever advances. */
  private reseedTraceIds(): void {
    let max = 0;
    for (const r of this.runs) for (const l of r.trace) if (l.id > max) max = l.id;
    for (const l of this.systemLog) if (l.id > max) max = l.id;
    if (this.nextId <= max) this.nextId = max + 1;
  }

  /** Append a system/terminal/mount message (not tied to any run). */
  logSystem(kind: TraceKind, text: string, detail?: string): void {
    this.systemLog = [...this.systemLog, this.line(kind, text, detail)].slice(-SYSTEM_LOG_LIMIT);
    this.notify();
  }

  /** Empty the system channel (the Log tab's Clear button). Purely a display
   *  reset — nothing here is load-bearing state. */
  clearSystemLog(): void {
    if (this.systemLog.length === 0) return;
    this.systemLog = [];
    this.notify();
  }

  /** Remove earlier error lines with exactly this text — called on the matching
   *  recovery transition. The Conversation `.sysbar` strip pins systemLog errors
   *  with no dismissal, so a recovered failure must retire its own stale line or
   *  the user keeps seeing an alert for a condition that no longer holds (B3/B2). */
  private dropSystemErrors(text: string): void {
    const next = this.systemLog.filter((l) => !(l.kind === "error" && l.text === text));
    if (next.length === this.systemLog.length) return;
    this.systemLog = next;
    this.notify();
  }

  private appendLine(run: Run, kind: TraceKind, text: string, detail?: string, ok?: boolean): void {
    run.trace = [...run.trace, this.line(kind, text, detail, ok)];
    this.scheduleRunsSave(); // D2: an in-flight run's trace survives a reload/crash
    this.notify();
  }

  /** Debounce-persist the run history (~500ms trailing) — trace appends arrive
   *  in bursts, so a burst costs one IndexedDB write. */
  private scheduleRunsSave(): void {
    if (this.runsSaveTimer) clearTimeout(this.runsSaveTimer);
    this.runsSaveTimer = setTimeout(() => void this.flushRunsSave(), 500);
  }

  /** True while a debounced runs save is pending (a pagehide flush checks this). */
  get runsSavePending(): boolean {
    return this.runsSaveTimer !== undefined;
  }

  /** Cancel any pending debounced runs save and persist `runs` now. Called at
   *  turn end (so the trailing timer can't double-save) and by a pagehide flush. */
  async flushRunsSave(): Promise<void> {
    if (this.runsSaveTimer) {
      clearTimeout(this.runsSaveTimer);
      this.runsSaveTimer = undefined;
    }
    await saveRuns(this.runs);
  }

  /** Mark every stored run still claiming "running" as interrupted — an
   *  error-status run with an explanatory trace line — because a loaded run
   *  can never actually be in flight. Returns true when anything changed
   *  (the caller persists to wherever those runs came from).
   *
   *  The marker line is BOOKKEEPING, not activity, so it carries the run's
   *  OWN last-activity ts (its final real trace line, or createdAt) instead
   *  of `this.line`'s Date.now(). hydrateRuns' same-id merge resolves by
   *  last-activity recency, and boot runs this normalization BEFORE the
   *  mount hydration — a "now" stamp let a crashed session's STALE copy
   *  out-recency a folder copy genuinely advanced elsewhere (a second
   *  browser/machine sharing the folder), and the rescued-persist path then
   *  overwrote the newer reply in `.erdou/runs.json` too. */
  private normalizeInterruptedRuns(): boolean {
    let changed = false;
    for (const run of this.runs) {
      if (run.status !== "running") continue;
      run.status = "error";
      const lastActivityTs = run.trace.at(-1)?.ts ?? run.createdAt;
      run.trace = [
        ...run.trace,
        { ...this.line("error", "Interrupted — the page was closed while this run was in progress."), ts: lastActivityTs },
      ];
      changed = true;
    }
    return changed;
  }

  /**
   * The agent's `approve` callback for the current run, or `undefined` in Auto
   * mode (Auto passes no callback, so gated tools run freely as before).
   *
   * In Confirm mode the returned callback parks a `pendingApproval` for the UI
   * and returns a Promise the agent awaits. Every settling path — immediate
   * auto-allow, Allow, Always allow, Deny — resolves that Promise exactly once
   * AND clears `pendingApproval` + notifies, so the agent can never hang.
   */
  private makeApprove(mode: ApprovalMode): ((req: ApprovalRequest) => Promise<"allow" | "deny">) | undefined {
    if (mode !== "confirm") return undefined;
    return (req) =>
      new Promise<"allow" | "deny">((resolve) => {
        if (this.autoAllow.has(req.tool)) {
          resolve("allow"); // already always-allowed this run
          return;
        }
        // open_preview is gated only for its server-starting form: a bare
        // "show the user the preview panel" runs nothing and needs no approval.
        if (req.tool === "open_preview" && typeof req.args.command !== "string") {
          resolve("allow");
          return;
        }
        this.pendingApproval = {
          req,
          resolve: (d) => {
            this.pendingApproval = null;
            this.notify();
            resolve(d);
          },
          allowAlways: () => {
            this.autoAllow.add(req.tool);
            this.pendingApproval = null;
            this.notify();
            resolve("allow");
          },
        };
        this.notify();
      });
  }

  /** Start a new agent run: create the thread, drive the agent, persist. */
  async startRun(task: string, model: ModelConfig, approvalMode: ApprovalMode): Promise<void> {
    if (this.running || this.switchingKernel) {
      this.logSystem("system", "Please wait for the kernel switch to finish before starting a task.");
      return;
    }
    if (this.swappingFolder) {
      // A run created inside the swap window would be wiped by the "replace"
      // hydration while live — refuse loudly instead (see hydrateRuns).
      this.logSystem("system", "Please wait for the folder to finish loading before starting a task.");
      return;
    }
    const run: Run = {
      id: newRunId(),
      title: runTitle(task),
      task,
      status: "running",
      trace: [],
      changes: [],
      messages: [],
      createdAt: Date.now(),
    };
    this.runs = [run, ...this.runs];
    this.activeRunId = run.id;
    this.notify();
    // D2: persist the run at creation — before this, the first save happened in
    // runAgentTurn's finally, so a reload mid-run silently lost the whole thread.
    // A failed save is surfaced but doesn't block the run itself.
    await saveRuns(this.runs).catch((err) => this.logSystem("error", "Could not persist the new run", asMessage(err)));
    this.scheduleFolderStateSave();
    this.seedEnvNotes();
    await this.runAgentTurn(run, task, model, approvalMode);
  }

  /**
   * Stop the in-flight agent run (the Composer's Stop button). Aborts the run's
   * controller — the agent exits at its next checkpoint (top of step / before a
   * tool) with `stoppedReason: "aborted"`, flowing through the same completion
   * path as any turn — and settles a parked Confirm-mode approval as "deny",
   * since an agent blocked awaiting approval can't observe the abort otherwise.
   * Sets `stopping` (the Composer's "Stopping…" state) until the turn actually
   * ends — the abort only takes effect at the agent's next checkpoint. No-op
   * when nothing is running.
   */
  stopRun(): void {
    if (!this.running) return;
    this.stopping = true;
    this.runAbort?.abort();
    this.pendingApproval?.resolve("deny");
    this.notify();
  }

  /** Drop the standard ERDOU.md into a project that doesn't have one yet, so
   *  every agent-built project carries the "how this environment differs" intro
   *  before the agent starts (the agent then appends its Erdou-specific
   *  adaptations to it — see the system prompt). Never overwrites an existing
   *  one; the write flows to a mounted folder via the normal sync. */
  private seedEnvNotes(): void {
    if (this.fs.exists("/ERDOU.md")) return;
    this.fs.writeFile("/ERDOU.md", ERDOU_MD_TEMPLATE);
    this.fsVersion++;
  }

  /**
   * Continue an existing thread: append the reply as a "you" bubble, then
   * drive another agent turn seeded with the thread's transcript so far
   * (`run.messages`), so the model sees the whole conversation. No-op if
   * something is already running or the run doesn't exist.
   */
  async replyToRun(runId: string, task: string, model: ModelConfig, approvalMode: ApprovalMode): Promise<void> {
    if (this.running || this.switchingKernel) {
      this.logSystem("system", "Please wait for the kernel switch to finish before starting a task.");
      return;
    }
    if (this.swappingFolder) {
      // Same guard as startRun: a reply driven inside the swap window could
      // not survive the "replace" hydration (see hydrateRuns).
      this.logSystem("system", "Please wait for the folder to finish loading before starting a task.");
      return;
    }
    const run = this.runs.find((r) => r.id === runId);
    if (!run || run.status === "running") return;
    run.status = "running";
    this.appendLine(run, "user", task);
    await this.runAgentTurn(run, task, model, approvalMode);
  }

  /**
   * Drive one agent turn — a fresh run's first turn, or a reply — against
   * `run`: builds the agent (seeded with `run.messages`, empty on a fresh
   * run), streams events into `run`'s trace, captures the file diff for just
   * this turn, and updates `run.status`/`run.messages`/`run.changes`.
   * Shared by `startRun` and `replyToRun` so the two can't diverge.
   */
  private async runAgentTurn(
    run: Run,
    task: string,
    model: ModelConfig,
    approvalMode: ApprovalMode,
  ): Promise<void> {
    this.running = true;
    // From here on this session's copy of the run is the truth of the thread —
    // an `.erdou` hydration landing later (async mount) must not replace it
    // with the folder's pre-turn copy, even after the turn ends (hydrateRuns).
    this.turnRunIds.add(run.id);
    this.autoAllow = new Set();
    const abort = new AbortController();
    this.runAbort = abort; // D1: stopRun() aborts this turn

    // Capture the VFS at turn start, then collect every path the agent
    // touches via a run-scoped subscription (separate from the boot-time
    // save handler). `unsub` is re-pointed by `repointRunDiff` if the agent
    // switches environments mid-run, so post-switch edits are still captured.
    const startSnap = await this.runtime.createSnapshot();
    const changed = new Set<string>();
    const collect = (e: RuntimeEvent): void => {
      // Skip package-manager / tool / VM-system output (node_modules, /root/.local,
      // …) so `pip install`/`npm install` never reads as the agent's edits.
      if (e.type === "file.changed" && !this.isNonProjectPath(e.path)) changed.add(e.path);
    };
    let unsub = this.runtime.subscribe(collect);
    this.repointRunDiff = () => {
      unsub();
      unsub = this.runtime.subscribe(collect);
    };
    // Attribution rule for external disk edits (mounted-folder rescan): a pull
    // writes the USER's edit into the VFS, whose file.changed lands in
    // `changed` like any other — blaming the agent for it in the run diff. The
    // watcher reports each pull's paths here and they are DISCOUNTED after the
    // pull's own events settle. If the agent later writes the same path, that
    // write re-adds it (its own event), so agent edits to user-edited files
    // stay attributed — spanning run-start content to the agent's content. A
    // pull that clobbers an EARLIER agent write drops the path: honest, since
    // the agent's content no longer exists in the workspace. (Known narrow
    // race: an agent write to the same path landing between the pull and its
    // settle is discounted with it — bounded by one rescan tick.)
    this.discountExternalPulls = async (paths) => {
      await eventsSettled(); // VM-kernel events may deliver a macrotask late
      for (const p of paths) changed.delete(p);
    };

    const agent = new CodingAgent({
      // The delegating facade (M1), NOT `this.runtime` — a mid-run switch
      // re-points which concrete runtime the agent's tools hit at call time.
      runtime: this.agentRuntime,
      gateway: this.gateway,
      model,
      maxSteps: 25,
      environment: {
        languages: AGENT_LANGUAGES,
        commands: AGENT_COMMANDS,
        notes:
          "You can build & preview web apps: write a React/TS project (e.g. /src/main.tsx) and the user can Bundle & Run it (bundled in-browser, npm deps from a CDN), `erdou serve <dir>` a static site, or `erdou.serve(app, port)` a Python WSGI app — any of these serves it on a port to preview." +
          " After open_preview, verify the app yourself: preview_read (rendered DOM), preview_click (click an element), preview_logs (console output + uncaught errors).",
        // The environments catalog: which env the agent is in now + every env
        // it can switch into (interpreters, package managers, install recipes,
        // switch guidance). Without this, agent-core's environmentsCatalogSection
        // returns "" and the R13 "ENVIRONMENTS & PACKAGES" brief is dead in
        // production (final-switch.md FINDING 1). Duck-typed projection: each
        // EnvironmentDescriptor structurally satisfies agent-core's
        // EnvironmentBrief — no cross-import, keeps layering (apps/web → agent-core).
        catalog: {
          current: this.currentEnvId,
          available: ENVIRONMENTS.map((e) => ({
            id: e.id,
            label: e.label,
            interpreters: e.interpreters,
            packageManagers: e.packageManagers,
            installRecipes: e.installRecipes,
            switchGuidance: e.switchGuidance,
            speed: e.speed,
          })),
        },
      },
      // The agent can move itself to an environment with the interpreter /
      // package manager the task needs; the callback performs the sanctioned
      // mid-run switch and returns the new-env brief for the model.
      extraTools: [
        createSwitchEnvironmentTool((t) => this.switchEnvironmentForRun(t), {
          environments: ENVIRONMENTS.map((e) => e.id),
        }),
        // App-UI tool (defined here, not in agent-tools — opening a panel is
        // app business, not a runtime capability): lets the agent surface its
        // running app to the user instead of hoping they find the Preview tab.
        {
          name: "open_preview",
          description:
            "Show the user your running app in Erdou's Preview panel. Two forms: " +
            "(1) with `command`, starts that server as a managed preview process (the sanctioned way to run a blocking " +
            "server — run_shell would hang on it) and then opens the panel on the port it binds; " +
            "(2) without `command`, just opens the panel — call it right after a server you already started is listening. " +
            "Servers must bind 0.0.0.0. `port` picks which port to focus (useful for multi-port servers); omit for the latest.",
          parameters: {
            type: "object",
            properties: {
              command: {
                type: "string",
                description:
                  "Optional shell command that starts a server (e.g. `python3 -m http.server 8000` or `erdou serve dist`). " +
                  "Run detached and tracked by the preview — omit if your server is already running.",
              },
              port: {
                type: "number",
                description: "The port to focus. Omit to focus the most recently opened port.",
              },
            },
          },
          execute: async (_ctx, args) => {
            const port = typeof args.port === "number" ? args.port : null;
            const command = typeof args.command === "string" && args.command.trim() !== "" ? args.command.trim() : null;
            if (command) {
              const r = await this.runServe(command);
              if (!r.ok) {
                return { ok: false, output: r.stderr?.trim() || r.stdout?.trim() || "serve failed" };
              }
              if (r.openedPorts.length === 0) {
                return {
                  ok: false,
                  output:
                    r.loopbackPorts.length > 0
                      ? `The server bound 127.0.0.1 only (port ${r.loopbackPorts.join(", ")}) — bind 0.0.0.0 so the preview proxy can reach it.`
                      : "The command exited without opening a port — a preview needs a server that binds 0.0.0.0 and keeps running.",
                };
              }
              const focus = port !== null && r.openedPorts.includes(port) ? port : r.openedPorts[r.openedPorts.length - 1]!;
              this.requestPreview(focus);
              const portsNote = r.openedPorts.length > 1 ? ` (ports open: ${r.openedPorts.join(", ")})` : "";
              return { ok: true, output: `Server running; preview opened for the user on port ${focus}${portsNote}.` };
            }
            this.requestPreview(port);
            return {
              ok: true,
              output:
                port === null
                  ? "Preview panel opened for the user (latest port)."
                  : `Preview panel opened for the user on port ${port}.`,
            };
          },
        },
        // Preview observation (spike 3): read the served app's DOM, click an
        // element, drain its console/error hook — the agent's verify loop
        // after open_preview. Ungated by design: they act only inside the
        // sandboxed preview iframe on code the agent itself served (serving
        // was the gated step); gating would break click→read→logs in Confirm
        // mode. Reversal is one string in agent-core's GATED_TOOLS.
        ...createPreviewTools(() => this.previewFrame),
        // Multi-agent fan-out (spike 4): ONE batch delegate call runs 1..3
        // sub-agents concurrently in throwaway browser-kernel sandboxes seeded
        // from a snapshot of the CURRENT workspace, then merges their diffs
        // back through `agentRuntime` — contract writes, so the run-scoped
        // diff subscription above picks the merged changes up and Review/
        // Diff/revert work with zero new plumbing. Approval-gated centrally
        // (agent-core GATED_TOOLS) on the delegate call itself; children run
        // ungated inside their sandboxes — nothing touches the real workspace
        // until this already-approved call applies diffs. NOTE: the ungated-
        // children decision leans on `pendingApproval` being a SINGLE slot
        // (concurrent per-child prompts would overwrite each other) — a future
        // "gate children too" change must first redesign that surface.
        createDelegateTool({
          runtime: this.agentRuntime,
          gateway: this.gateway,
          model,
          signal: abort.signal,
          onChildUpdate: this.makeSubagentReporter(run),
        }),
        // App-UI tool (same inline style as open_preview): packages the
        // workspace as a .zip and puts a Download button in front of the user.
        // Read-only + UI-only, so it is deliberately NOT approval-gated (not
        // in agent-core's GATED_TOOLS).
        {
          name: "package_project",
          description:
            "Package the user's whole project as a downloadable .zip and hand them a Download button in the " +
            "conversation. Zips the entire workspace including .git (version history is part of the project), " +
            "excluding node_modules (regenerable) and Erdou-internal state. Use it when the user asks to export, " +
            "download, save a copy of, or hand off the project. Optional `name` sets the zip's file name.",
          parameters: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Optional base name for the zip file (defaults to the project folder's name).",
              },
            },
          },
          execute: async (_ctx, args) => {
            const name = typeof args.name === "string" && args.name.trim() !== "" ? args.name.trim() : undefined;
            try {
              // Pass THIS turn's `run`, not activeRun: if the user selects
              // another thread (or New Draft) mid-run, the card must still
              // land on the conversation that invoked the tool — otherwise
              // the "Download button in the conversation" claim below lies.
              const e = this.exportProject(name, run);
              return {
                ok: true,
                output: `Packaged ${e.fileCount} files (${e.byteSize} bytes) into ${e.name}; the user now has a Download button in the conversation.`,
              };
            } catch (err) {
              return { ok: false, output: asMessage(err) };
            }
          },
        },
      ],
      onEvent: (e) => this.onAgentEvent(run, e),
      approve: this.makeApprove(approvalMode),
      signal: abort.signal,
    });
    try {
      // Empty `run.messages` (a fresh run) makes the agent build its system
      // prompt from scratch; a non-empty transcript (a reply) makes it
      // continue the existing conversation instead — see CodingAgent.run.
      const result = await agent.run(task, run.messages);
      run.messages = result.transcript;
    } catch (err) {
      this.appendLine(run, "error", "Agent stopped", asMessage(err));
      run.status = "error";
    } finally {
      // B5: capture the diff HERE so error/aborted turns keep it too — a turn
      // that threw at step 7/7 really changed 6 files, and Review/Diff/revert
      // need them. Settle the async-delivered file.changed events BEFORE
      // dropping the run-scoped subscription, then read `changed`.
      await eventsSettled();
      unsub();
      this.repointRunDiff = undefined;
      this.discountExternalPulls = undefined;
      try {
        const turnChanges = await this.computeRunChanges(startSnap, changed);
        run.changes = this.mergeChanges(run.changes, turnChanges);
        // Still "running" here ⇔ the turn succeeded (the catch above sets
        // "error"): decide review/done AFTER the diff, so "review" actually
        // triggers when the turn changed files.
        if (run.status === "running") run.status = run.changes.length > 0 ? "review" : "done";
      } catch (err) {
        // A diff failure inside the finally must not wedge the studio
        // (`running` would stay true forever) — surface it on the run instead
        // and continue through the cleanup below.
        this.appendLine(run, "error", "Could not compute this turn's file diff", asMessage(err));
        if (run.status === "running") run.status = "error";
      }
      this.running = false;
      this.stopping = false;
      this.runAbort = null;
      // Defensive: if the run threw while a prompt was open, drop it so the UI
      // doesn't show a stale approval for a run that is no longer executing.
      this.pendingApproval = null;
      await this.save();
      await this.flushRunsSave(); // also cancels the trace-append debounce timer
      this.scheduleFolderStateSave();
      this.notify();
    }
  }

  /** Diff the paths touched during a turn against the snapshot taken at its start. */
  /** True for a changed path that is NOT project "truth" and must stay out of
   *  the run diff: regenerable / tool-owned dirs (`node_modules`, `.git`,
   *  `.erdou`) on any kernel — the same names export (project-zip) and
   *  folder-sync exclude — plus, on the VM kernel, its baked / bind-mounted
   *  system dirs (`VM_PRESERVE_DIRS`: bin/lib/usr/proc/dev/tmp/etc/root, where
   *  pip's `/root/.local` and npm's caches live). Without this, a `pip install`
   *  or `npm install` shows up as the agent's edits in Review/Diff. */
  private isNonProjectPath(path: string): boolean {
    const segs = path.split("/").filter(Boolean);
    if (segs.some((s) => s === "node_modules" || s === ".git" || s === ".erdou")) return true;
    if (this.kernelKind === "vm" && segs.length > 0 && VM_PRESERVE_DIRS.includes(segs[0]!)) return true;
    return false;
  }

  private async computeRunChanges(startSnap: Snapshot, changed: Set<string>): Promise<FileChange[]> {
    if (changed.size === 0) return [];
    const before = SnapshotReader.open(startSnap);
    // Non-file paths read as null: `mkdir` emits file.changed for the DIRECTORY
    // itself, and reading it threw EISDIR — which voided the entire turn's diff
    // (status error, empty Review) for any run that created a directory. The
    // files created inside a directory carry the actual diff; the dir entry
    // nets out null→null and drops. (SnapshotReader.read already returns null
    // for non-files on the `before` side.) Surfaced by the delegate merge,
    // whose apply-back mkdirs hit this on every nested create.
    const after = (path: string): string | null =>
      this.fs.exists(path) && this.fs.stat(path).type === "file"
        ? new TextDecoder().decode(this.fs.readFile(path))
        : null;
    // Directory expansion: `rm -r`/`mv` on a directory emits ONE file.changed
    // for the directory path, and a directory nets null→null above — so a run
    // that deleted or renamed a whole tree used to show an EMPTY diff. A
    // changed path that is a directory in the start snapshot expands to the
    // files that lived beneath it (their deletions); one that is a directory
    // live expands to the files beneath it now (their creations, e.g. `cp -r`).
    // Files also touched individually are already in `changed` — a Set dedupes.
    // An EMPTY new directory still shows nothing: a content diff has no line to
    // render for it (documented, tested). The gate must be lstat, NOT stat:
    // stat FOLLOWS symlinks, so a run-created symlink-to-directory (tool-git
    // checkouts, `ln -s` in the VM) expanded through the link and fabricated
    // phantom `create` entries for the REAL target's files — reverting one
    // deleted a file the agent never touched. lstat sees the link itself, so
    // symlinks stay invisible here, mirroring the symlink skip in both
    // liveFilesUnder and SnapshotReader.filesUnder.
    const paths = new Set(changed);
    for (const path of changed) {
      for (const f of before.filesUnder(path)) paths.add(f);
      if (this.fs.exists(path) && this.fs.lstat(path).type === "directory") {
        for (const f of this.liveFilesUnder(path)) paths.add(f);
      }
    }
    // Directory expansion can pull excluded files back in (a changed dir that
    // contains node_modules / a VM system dir) — drop them here too, so the
    // collect-time filter is airtight.
    const projectPaths = new Set([...paths].filter((p) => !this.isNonProjectPath(p)));
    return buildFileChanges(projectPaths, (p) => before.read(p), after);
  }

  /** Every FILE path under the live directory at `dirPath` (symlinks skipped —
   *  mirrors SnapshotReader.filesUnder). Caller guarantees `dirPath` is a
   *  directory. */
  private liveFilesUnder(dirPath: string): string[] {
    const out: string[] = [];
    for (const entry of this.fs.readdir(dirPath)) {
      const childPath = dirPath === "/" ? `/${entry.name}` : `${dirPath}/${entry.name}`;
      if (entry.type === "file") out.push(childPath);
      else if (entry.type === "directory") out.push(...this.liveFilesUnder(childPath));
    }
    return out;
  }

  /**
   * Fold a turn's file changes into the run's cumulative list, keyed by path.
   * A reply often touches a file a prior turn already changed; appending a
   * second entry for the same path would collide with `DiffPanel`'s
   * `key={path}` and confuse `revertChange`'s by-path lookup, so instead each
   * path keeps ONE entry spanning every turn: `before` stays the earliest
   * known content (first time this run touched the path) and `after` becomes
   * the latest. `kind` is re-derived from that span (net create/delete/modify),
   * and a path that nets out unchanged since the run started is dropped.
   *
   * `FileChange.before`/`after` store "" for an ABSENT file too, so existence
   * must come from `kind`, not content: a span whose FIRST change was a
   * "create" started absent; a turn change of kind "delete" ends absent.
   * Deciding from content alone made an empty-file create/delete vanish from
   * the diff entirely and misread truncate-to-empty as a delete.
   */
  private mergeChanges(existing: FileChange[], turnChanges: FileChange[]): FileChange[] {
    const byPath = new Map(existing.map((c) => [c.path, c]));
    for (const c of turnChanges) {
      const prior = byPath.get(c.path);
      const before = prior ? prior.before : c.before;
      const existedAtStart = prior ? prior.kind !== "create" : c.kind !== "create";
      const existsNow = c.kind !== "delete";
      if (existedAtStart === existsNow && before === c.after) {
        byPath.delete(c.path); // net no-op since the run started
        continue;
      }
      const kind: FileChange["kind"] = !existedAtStart ? "create" : !existsNow ? "delete" : "modify";
      byPath.set(c.path, { path: c.path, kind, before, after: c.after });
    }
    return [...byPath.values()].sort((x, y) => (x.path < y.path ? -1 : 1));
  }

  /** Undo a single file change from a run: creates are removed, others restored.
   *  A restore recreates missing parent directories first — a file deleted via
   *  `rm -r <dir>` lost its parents too, and writeFile does not mkdir them. */
  async revertChange(runId: string, path: string): Promise<void> {
    const run = this.runs.find((r) => r.id === runId);
    const change = run?.changes.find((c) => c.path === path);
    if (!change) return;
    if (change.kind === "create") await this.runtime.rm(path, { force: true });
    else {
      const parent = path.slice(0, path.lastIndexOf("/"));
      if (parent !== "") await this.runtime.mkdir(parent, { recursive: true });
      await this.runtime.writeFile(path, change.before);
    }
    this.notify();
  }

  selectRun(id: string): void {
    this.activeRunId = id;
    this.notify();
  }

  /**
   * Delete a run (task thread) from the sidebar. If it was the active run, the
   * most recent remaining run becomes active (runs are stored most-recent
   * first), or none. Persists through both stores like startRun: an awaited
   * IndexedDB write + the mounted folder's debounced `.erdou/` state save.
   *
   * A run whose turn is IN FLIGHT is refused instead of being ripped out
   * mid-turn: stopRun() is checkpoint-based (the abort settles asynchronously
   * at the agent's next checkpoint), so "stop then delete once the turn
   * settles" would mean hidden deferred-deletion state for a case the user can
   * resolve with two clicks — Stop, then delete. The sidebar renders a running
   * row's delete button DISABLED (with that explanation as its title), so this
   * guard is a backstop for programmatic callers; its log line is best-effort
   * (with a run active, only error-kind system lines are pinned on screen).
   */
  async deleteRun(id: string): Promise<void> {
    const run = this.runs.find((r) => r.id === id);
    if (!run) throw new Error(`deleteRun: no run with id "${id}"`);
    if (run.status === "running") {
      this.logSystem("system", "This task is still running — stop it first, then delete it.");
      return;
    }
    this.runs = this.runs.filter((r) => r.id !== id);
    if (this.activeRunId === id) this.activeRunId = this.runs[0]?.id ?? null;
    this.notify();
    await saveRuns(this.runs).catch((err) =>
      this.logSystem("error", "Could not persist the deleted run history", asMessage(err)),
    );
    this.scheduleFolderStateSave();
  }

  /**
   * Rename a run (task thread). `Run.title` is a stored plain field (`runTitle`
   * only derives the initial value), so the rename survives reload by
   * construction. Fail-fast: an empty (post-trim) title or an unknown id
   * throws — no silent half-rename. Persists through both stores.
   */
  async renameRun(id: string, title: string): Promise<void> {
    const run = this.runs.find((r) => r.id === id);
    if (!run) throw new Error(`renameRun: no run with id "${id}"`);
    const trimmed = title.trim();
    if (trimmed === "") throw new Error("renameRun: the title must not be empty");
    run.title = trimmed;
    this.notify();
    await saveRuns(this.runs).catch((err) =>
      this.logSystem("error", "Could not persist the renamed run", asMessage(err)),
    );
    this.scheduleFolderStateSave();
  }

  /** Accept a run's changes: "review" -> "done". */
  markReviewed(id: string): void {
    const run = this.runs.find((r) => r.id === id);
    if (!run || run.status !== "review") return;
    run.status = "done";
    void saveRuns(this.runs);
    this.scheduleFolderStateSave();
    this.notify();
  }

  /** Deselect the active run so the composer starts a fresh task. */
  newDraft(): void {
    this.activeRunId = null;
    this.notify();
  }

  /**
   * Per-turn reporter for delegate sub-agent lifecycle: the FIRST update for a
   * child key appends its kind:"subagent" trace line; every later update
   * replaces that line immutably (fresh detail JSON) + debounce-persists +
   * notifies — so the card renders live during the run and round-trips
   * runs-store/`.erdou` like any other trace line. Keys are unique per child
   * across delegate calls (delegate.ts's call counter), so one map covers a
   * turn that delegates more than once.
   */
  private makeSubagentReporter(run: Run): (key: string, detail: SubagentDetail) => void {
    const lineIds = new Map<string, number>();
    return (key, detail) => {
      const json = JSON.stringify(detail);
      const text = `sub-agent · ${detail.role}`;
      const existing = lineIds.get(key);
      if (existing === undefined) {
        const l = this.line("subagent", text, json);
        lineIds.set(key, l.id);
        run.trace = [...run.trace, l];
      } else {
        run.trace = run.trace.map((l) => (l.id === existing ? { ...l, text, detail: json } : l));
      }
      this.scheduleRunsSave();
      this.notify();
    };
  }

  private onAgentEvent(run: Run, e: AgentEvent): void {
    switch (e.type) {
      case "assistant":
        if (e.content.trim().length > 0) this.appendLine(run, "thought", e.content);
        break;
      case "tool_call":
        this.appendLine(run, "tool", e.name, formatArgs(e.args));
        break;
      case "tool_result":
        this.appendLine(run, "result", firstLine(e.output), e.output, e.ok);
        break;
      case "done": {
        // On a clean finish the agent emits its final text TWICE — an
        // `assistant` event (already appended as the last "thought" line) and
        // then `done` with the same string as the summary (agent-core run()).
        // Appending both renders the reply twice, reframed as a completion
        // marker. When the summary adds nothing beyond the last trace line
        // (identical after trim), append nothing — the run's status change is
        // the completion signal. Summaries that DO add information ("Stopped
        // by the user.", the step-limit notice, "Done." after a tool-only
        // turn) still land as a done line.
        const summary = e.summary || (e.reason === "max_steps" ? "Stopped at the step limit." : "Done.");
        const last = run.trace[run.trace.length - 1];
        if (last?.text.trim() !== summary.trim()) this.appendLine(run, "done", summary);
        break;
      }
    }
  }

  async readTree(path = "/"): Promise<FileNode[]> {
    const entries = await this.runtime.readdir(path);
    const out: FileNode[] = [];
    for (const e of entries) {
      const childPath = path === "/" ? `/${e.name}` : `${path}/${e.name}`;
      if (e.type === "directory") {
        out.push({ name: e.name, path: childPath, type: e.type, children: await this.readTree(childPath) });
      } else {
        out.push({ name: e.name, path: childPath, type: e.type });
      }
    }
    return out;
  }

  async readFileText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.runtime.readFile(path));
  }

  listProcesses(): Promise<ProcessInfo[]> {
    return this.runtime.getProcesses();
  }

  /** Stop serving a port (the Preview panel's × button). `openPorts` updates
   *  when the runtime's `port.closed` event arrives — which the contract
   *  allows to be asynchronous — via the boot-time subscription. */
  closePort(port: number): Promise<void> {
    return this.runtime.closePort(port);
  }

  /**
   * Package the workspace as a downloadable .zip and register it for the UI.
   * Builds the archive (excluding node_modules/.erdou, and the VM image dirs
   * on the vm kernel — see project-zip.ts), wraps it in an object URL, and
   * registers it under a fresh exportId. The PREVIOUS export (if any) is
   * revoked and dropped — object URLs pin their blobs for the tab's lifetime,
   * so keeping stale ones would leak the whole zip per export; the dropped
   * entry's card then honestly renders as expired. A kind:"artifact" trace
   * line (detail = the `ExportArtifact` JSON) lands on `targetRun` when given
   * (package_project passes ITS run, so the card follows the conversation that
   * invoked the tool even if the user has selected another thread mid-run);
   * otherwise on the active run (FilePanel's manual Download), or the
   * systemLog when no run is selected.
   *
   * `name` defaults to the mounted folder name or "erdou-project"; ".zip" is
   * appended (a supplied trailing ".zip" is not doubled). Throws the precise
   * empty-workspace error from buildProjectZip — callers surface it.
   */
  exportProject(
    name?: string,
    targetRun?: Run,
  ): { exportId: string; url: string; name: string; byteSize: number; fileCount: number } {
    const base = (name?.trim() || this.mountName || "erdou-project").replace(/\.zip$/i, "");
    const zip = buildProjectZip(this.fs, { kernelKind: this.kernelKind });
    for (const [id, prev] of this.exports) {
      URL.revokeObjectURL(prev.url);
      this.exports.delete(id);
    }
    const exportId = newRunId();
    const fileName = `${base}.zip`;
    const url = URL.createObjectURL(new Blob([zip.bytes as BlobPart], { type: "application/zip" }));
    const entry = { url, name: fileName, byteSize: zip.byteSize, fileCount: zip.fileCount };
    this.exports.set(exportId, entry);
    const detail: ExportArtifact = { exportId, name: fileName, byteSize: zip.byteSize, fileCount: zip.fileCount };
    const text = `Project packaged: ${fileName} (${zip.fileCount} files)`;
    const run = targetRun ?? this.activeRun;
    if (run) this.appendLine(run, "artifact", text, JSON.stringify(detail));
    else this.logSystem("artifact", text, JSON.stringify(detail));
    return { exportId, ...entry };
  }

  /** The agent's open_preview tool lands here: record the request (a nonce so
   *  repeated calls to the same port still re-trigger the UI) and notify. The
   *  UI reacts — this starts/stops nothing. */
  requestPreview(port: number | null): void {
    this.previewRequest = { port, nonce: (this.previewRequest?.nonce ?? 0) + 1 };
    this.notify();
  }

  /** PreviewPanel's iframe ref lands here so the agent's preview observation
   *  tools can reach the live document. No notify(): not render state. */
  registerPreviewFrame(el: HTMLIFrameElement | null): void {
    this.previewFrame = el;
  }

  /**
   * Run the Preview panel's serve command, owning its race with `switchKernel`:
   * `runServeCommand` can await `port.opened` for seconds (VM python cold
   * start), long enough for a switch to complete mid-flight — and
   * `stopTrackedServe` only sees ALREADY-recorded state (`servePid` is
   * assigned on settle), so it would kill nothing and the settle would then
   * record the OUTGOING kernel's pid against the new one (every later kill
   * path targeting the wrong runtime; the real server orphaned). So:
   *  - refuse while a switch is in flight (the reverse window: a serve started
   *    against the outgoing kernel during a cold VM boot);
   *  - capture the kernel at start and run against IT;
   *  - a settle after a switch is STALE: kill its pid on the CAPTURED runtime
   *    (the one that owns it; ESRCH-safe) and record nothing.
   * Never rejects — failures come back as `ok: false` (run-serve's idiom).
   */
  async runServe(commandLine: string): Promise<StudioServeResult> {
    if (this.switchingKernel) {
      return {
        ok: false,
        openedPorts: [],
        loopbackPorts: [],
        stderr: "A kernel switch is in progress — wait for it to finish, then run again.",
      };
    }
    const captured = this.kernel;
    const shell = this.shell; // opens on `captured` (no switch is in flight here)
    const result = await runServeCommand(captured.runtime, shell, commandLine);
    // `|| this.switchingKernel`: a settle can also land while switchKernel is
    // parked pre-swap inside stopTrackedServe (kernel not yet reassigned) —
    // its pid check already passed, so recording here would re-poison it.
    if (this.kernel !== captured || this.switchingKernel) {
      if (result.pid !== undefined) void captured.runtime.kill(result.pid).catch(() => {});
      // Browser-path stale (no pid): the serve is a port REGISTRATION — free it
      // on the captured runtime or a switch-back re-serve hits EADDRINUSE.
      for (const port of result.openedPorts) void captured.runtime.closePort(port);
      return { ...result, ok: false, stale: true };
    }
    this.servePid = result.pid ?? null;
    return result;
  }

  /** Kill the tracked detached server and close every tracked port on the
   *  ACTIVE runtime, then clear the tracking. `switchKernel` calls this
   *  pre-swap; the kill's catch is for an already-exited pid (ESRCH). */
  private async stopTrackedServe(): Promise<void> {
    if (this.servePid !== null) {
      await this.runtime.kill(this.servePid).catch(() => {});
      this.servePid = null;
    }
    for (const { port } of this.openPorts) await this.runtime.closePort(port);
    this.openPorts = [];
  }

  async resetProject(): Promise<void> {
    // Kill a pending debounced runs save first — firing between clearRuns and
    // the reload would resurrect the just-cleared history on next boot.
    if (this.runsSaveTimer) {
      clearTimeout(this.runsSaveTimer);
      this.runsSaveTimer = undefined;
    }
    await this.store.delete(SNAPSHOT_ID);
    await clearRuns();
    location.reload();
  }
}

/** True when the directory subtree at `dirPath` contains ANY non-directory
 *  entry — i.e. removing it could lose data. The VM's leaked bind-mount stubs
 *  are empty directory trees and read false: deleting one loses nothing. */
function dirHasContent(fs: FileSystemApi, dirPath: string): boolean {
  return fs.readdir(dirPath).some((e) => e.type !== "directory" || dirHasContent(fs, `${dirPath}/${e.name}`));
}

const asMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const firstLine = (s: string): string => s.split("\n")[0] ?? "";

/** Collapse whitespace/newlines to a single line and cut to `max` chars, for a
 *  one-line summary of a (possibly multi-line) args/result string. */
export function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

function formatArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("   ");
}
