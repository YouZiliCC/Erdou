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
  type DirHandleLike,
  type FolderMirrorResult,
  type MountMtimes,
} from "./local-mount.js";
import { pullDiskToWorkspace, pushWorkspaceToDisk, reselectFolder as reselectFolderOp } from "./folder-sync-controls.js";

const SNAPSHOT_ID = "erdou:default";
/** Cap on `Studio.systemLog` entries so a noisy source (e.g. failing rescans) can't grow it unbounded. */
const SYSTEM_LOG_LIMIT = 200;
// Failure texts logged on a state TRANSITION and removed again on recovery
// (dropSystemErrors) — shared constants so the log and the removal can't drift.
const SAVE_FAILED_TEXT = "Couldn't save your project to this browser (storage may be full or restricted).";
const RESCAN_FAILED_TEXT = "Mount rescan failed";

export type TraceKind = "system" | "user" | "thought" | "tool" | "result" | "done" | "error";

export interface TraceLine {
  id: number;
  kind: TraceKind;
  text: string;
  detail?: string;
  ok?: boolean;
  ts: number;
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
  private _shell?: RpcShellSession;
  private _unsubRuntime?: Unsubscribe;
  /** Re-points the run-scoped diff subscription onto the active kernel after a
   *  mid-run environment switch (set only while a run is in flight). */
  private repointRunDiff?: () => void;

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
  /** True only while a folder SWAP (re-select) is repointing the mount to a
   *  different disk folder. Suspends the folder auto-save for the whole swap so
   *  the clear+load's file.changed churn can never mirror onto the wrong disk. */
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
        if (perm === "granted") await this.mountFolder(handle);
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

  async mountFolder(handle: DirHandleLike): Promise<void> {
    // A2 (data safety): the folder is the source of truth on mount — the same
    // rule `swapMountedFolder` enforces. boot() restores the previous project
    // into the VFS before a persisted mount reconnects, and `loadFolderIntoVfs`
    // only ever ADDS files, so mounting into a non-empty workspace would make
    // it old ∪ folder — and the next auto-save/Push would then write last
    // session's files onto the freshly mounted disk (e.g. polluting a clean
    // git repo). So a non-empty workspace is cleared first (the VM's
    // image-owned root dirs kept), with the folder auto-save suspended across
    // the clear+load so the churn can't mirror a half-loaded state onto any
    // disk. Note the replaced in-browser project is NOT retained anywhere: the
    // snapshot save that follows the load overwrites it with the folder
    // contents.
    const hadProject = this.fs.readdir("/").some((e) => !VM_PRESERVE_DIRS.includes(e.name));
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
      const st = await readFolderState(handle);
      if (st) {
        this.runs = st.runs;
        // Folder-hydrated runs replace `this.runs`, so the boot-time interrupted-run
        // normalization must apply here too (skipped while a run is actually live now).
        if (!this.running && this.normalizeInterruptedRuns()) this.scheduleFolderStateSave();
        if (st.config) {
          applyTheme(st.config.theme);
          saveApprovalMode(st.config.approvalMode);
          saveModel(st.config.model);
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

  /** Re-grant permission to a persisted mount (needs a user gesture). */
  async reconnectMount(): Promise<boolean> {
    const handle = this.pendingMount;
    if (!handle) return false;
    const perm = (await handle.requestPermission?.({ mode: "readwrite" })) ?? "denied";
    if (perm !== "granted") return false;
    await this.mountFolder(handle);
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

  /** Manual "Pull from disk ↓": load the mounted folder from disk into the
   *  workspace now — disk wins (a full re-pull, distinct from the mtime-gated
   *  background rescan). No-op returning 0 if nothing is mounted; returns the
   *  file count pulled. */
  async pullFolderNow(): Promise<number> {
    if (!this.mount) return 0;
    const count = await pullDiskToWorkspace(this.mount, this.fs, this.mountMtimes);
    this.fsVersion++;
    this.notify();
    return count;
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
   *  picker. Routes through `swapMountedFolder` (NOT the additive `mountFolder`)
   *  so the newly-picked folder becomes the sole source of truth. */
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
   * Swap the mounted folder for a DIFFERENT one, which becomes the SOLE source
   * of truth. `mountFolder` clears a non-empty workspace itself (A2), but a
   * swap must ALSO hold the folder auto-save suspension across the ENTIRE
   * clear→load flow and drop the OLD folder's pending save + stale mtimes even
   * when the workspace happens to be empty — the ~600 ms folder auto-save must
   * never mirror a half-swapped workspace onto either disk (e.g. dirtying a
   * `.git` repo). So it pre-clears here with the suspension held for the whole
   * swap, THEN loads the new folder via `mountFolder`.
   */
  private async swapMountedFolder(handle: DirHandleLike): Promise<void> {
    this.swappingFolder = true;
    // Kill any save the OLD folder had pending — it must not fire against the new one.
    if (this.folderSaveTimer) {
      clearTimeout(this.folderSaveTimer);
      this.folderSaveTimer = undefined;
    }
    try {
      this.clearWorkspace();
      this.mountMtimes.clear();
      await this.mountFolder(handle);
    } finally {
      this.swappingFolder = false;
    }
  }

  /** Delete every project entry from the VFS root, leaving the VM kernel's
   *  image-owned root dirs (`VM_PRESERVE_DIRS` — skeleton bind mounts + baked
   *  /etc,/root) untouched. Mirrors `copyWorkspace`'s top-level clear; used by a
   *  folder swap so the newly-mounted folder is the workspace's only source. */
  private clearWorkspace(): void {
    for (const entry of this.fs.readdir("/")) {
      if (VM_PRESERVE_DIRS.includes(entry.name)) continue;
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

  /** Append a system/terminal/mount message (not tied to any run). */
  logSystem(kind: TraceKind, text: string, detail?: string): void {
    this.systemLog = [...this.systemLog, this.line(kind, text, detail)].slice(-SYSTEM_LOG_LIMIT);
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
   *  (the caller persists to wherever those runs came from). */
  private normalizeInterruptedRuns(): boolean {
    let changed = false;
    for (const run of this.runs) {
      if (run.status !== "running") continue;
      run.status = "error";
      run.trace = [...run.trace, this.line("error", "Interrupted — the page was closed while this run was in progress.")];
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
      if (e.type === "file.changed") changed.add(e.path);
    };
    let unsub = this.runtime.subscribe(collect);
    this.repointRunDiff = () => {
      unsub();
      unsub = this.runtime.subscribe(collect);
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
          "You can build & preview web apps: write a React/TS project (e.g. /src/main.tsx) and the user can Bundle & Run it (bundled in-browser, npm deps from a CDN), `erdou serve <dir>` a static site, or `erdou.serve(app, port)` a Python WSGI app — any of these serves it on a port to preview.",
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
  private async computeRunChanges(startSnap: Snapshot, changed: Set<string>): Promise<FileChange[]> {
    if (changed.size === 0) return [];
    const before = SnapshotReader.open(startSnap);
    const after = (path: string): string | null =>
      this.fs.exists(path) ? new TextDecoder().decode(this.fs.readFile(path)) : null;
    return buildFileChanges(changed, (p) => before.read(p), after);
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
   */
  private mergeChanges(existing: FileChange[], turnChanges: FileChange[]): FileChange[] {
    const byPath = new Map(existing.map((c) => [c.path, c]));
    for (const c of turnChanges) {
      const prior = byPath.get(c.path);
      const before = prior ? prior.before : c.before;
      if (before === c.after) {
        byPath.delete(c.path); // net no-op since the run started
        continue;
      }
      const kind: FileChange["kind"] =
        c.after === "" ? "delete" : prior?.kind === "create" ? "create" : prior ? "modify" : c.kind;
      byPath.set(c.path, { path: c.path, kind, before, after: c.after });
    }
    return [...byPath.values()].sort((x, y) => (x.path < y.path ? -1 : 1));
  }

  /** Undo a single file change from a run: creates are removed, others restored. */
  async revertChange(runId: string, path: string): Promise<void> {
    const run = this.runs.find((r) => r.id === runId);
    const change = run?.changes.find((c) => c.path === path);
    if (!change) return;
    if (change.kind === "create") await this.runtime.rm(path, { force: true });
    else await this.runtime.writeFile(path, change.before);
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
      case "done":
        this.appendLine(run, "done", e.summary || (e.reason === "max_steps" ? "Stopped at the step limit." : "Done."));
        break;
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

  /** The agent's open_preview tool lands here: record the request (a nonce so
   *  repeated calls to the same port still re-trigger the UI) and notify. The
   *  UI reacts — this starts/stops nothing. */
  requestPreview(port: number | null): void {
    this.previewRequest = { port, nonce: (this.previewRequest?.nonce ?? 0) + 1 };
    this.notify();
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
