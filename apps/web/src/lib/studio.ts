import { IndexedDbSnapshotStore } from "@erdou/runtime-browser";
import { ModelGateway, type ModelConfig, type ChatMessage } from "@erdou/model-gateway";
import { CodingAgent, type AgentEvent, type ApprovalRequest } from "@erdou/agent-core";
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
  type MountMtimes,
} from "./local-mount.js";
import { pullDiskToWorkspace, pushWorkspaceToDisk, reselectFolder as reselectFolderOp } from "./folder-sync-controls.js";

const SNAPSHOT_ID = "erdou:default";
/** Cap on `Studio.systemLog` entries so a noisy source (e.g. failing rescans) can't grow it unbounded. */
const SYSTEM_LOG_LIMIT = 200;

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
  fsVersion = 0;
  /** Ports currently served by the runtime (Preview panel's open-ports list),
   *  tracked from `port.opened`/`port.closed` — not persisted; a fresh session
   *  starts with nothing served until something runs. */
  openPorts: { port: number }[] = [];
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
    const count = await loadFolderIntoVfs(handle, this.fs, "/", this.mountMtimes);
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
    this.folderStateTimer = setTimeout(() => void this.saveStateToFolder(), 600);
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
        this.mountRescanFailed = false;
        if (pulled.length) {
          this.fsVersion++;
          this.notify(); // belt-and-suspenders: file.changed already fired per pulled file
        }
      } catch (err) {
        // Guard against logging (and notifying) every 5s while the rescan keeps
        // failing the same way — only surface it once until a rescan succeeds.
        if (!this.mountRescanFailed) {
          this.mountRescanFailed = true;
          this.logSystem("error", "Mount rescan failed", asMessage(err));
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
    if (this.folderSaveTimer) clearTimeout(this.folderSaveTimer);
    this.folderSaveTimer = setTimeout(() => void this.saveToFolder(), 600);
  }
  async saveToFolder(): Promise<void> {
    if (!this.mount) return;
    try {
      // The VM kernel's readdir("/") exposes its skeleton bind-mount stub dirs
      // (bin/lib/usr/proc/dev/tmp) AND its baked config dirs (/etc pip.conf +
      // resolv.conf, /root .npmrc) — never write those image-owned dirs into
      // the user's real folder (R12.5 IMP2 class). VM_PRESERVE_DIRS = skeleton
      // + etc + root; SKELETON_DIRS alone would dump /etc/pip.conf onto disk.
      await saveVfsToFolder(
        this.fs,
        this.mount,
        "/",
        this.mountMtimes,
        this.kernelKind === "vm" ? new Set(VM_PRESERVE_DIRS) : undefined,
      );
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

  /** Manual "Push to disk ↑": write the whole workspace back to the mounted
   *  folder now, honoring VM_PRESERVE_DIRS at root on the VM kernel exactly like
   *  the auto save path. No-op if nothing is mounted. */
  async pushFolderNow(): Promise<void> {
    if (!this.mount) return;
    await pushWorkspaceToDisk(
      this.mount,
      this.fs,
      this.mountMtimes,
      this.kernelKind === "vm" ? new Set(VM_PRESERVE_DIRS) : undefined,
    );
  }

  /** Manual "Re-select folder": re-run the directory picker to swap to a
   *  DIFFERENT local folder, replacing the current mount (`mountFolder` persists
   *  + loads the new handle). Needs a user gesture. Returns true if a new folder
   *  was mounted, false if the user cancelled the picker. */
  async reselectFolder(): Promise<boolean> {
    const picker = (window as unknown as { showDirectoryPicker?: (o?: unknown) => Promise<unknown> })
      .showDirectoryPicker;
    if (!picker) throw new Error("Folder mounting needs the File System Access API — use Chrome or Edge.");
    const handle = await reselectFolderOp(
      () => picker({ mode: "readwrite" }) as Promise<DirHandleLike>,
      (h) => this.mountFolder(h),
    );
    return handle !== null;
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), 400);
  }
  async save(): Promise<void> {
    await this.store.save(SNAPSHOT_ID, await this.runtime.createSnapshot());
  }

  private line(kind: TraceKind, text: string, detail?: string, ok?: boolean): TraceLine {
    return { id: this.nextId++, kind, text, detail, ok, ts: Date.now() };
  }

  /** Append a system/terminal/mount message (not tied to any run). */
  logSystem(kind: TraceKind, text: string, detail?: string): void {
    this.systemLog = [...this.systemLog, this.line(kind, text, detail)].slice(-SYSTEM_LOG_LIMIT);
    this.notify();
  }

  private appendLine(run: Run, kind: TraceKind, text: string, detail?: string, ok?: boolean): void {
    run.trace = [...run.trace, this.line(kind, text, detail, ok)];
    this.notify();
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
      id: crypto.randomUUID(),
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
    await this.runAgentTurn(run, task, model, approvalMode);
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
      ],
      onEvent: (e) => this.onAgentEvent(run, e),
      approve: this.makeApprove(approvalMode),
    });
    try {
      // Empty `run.messages` (a fresh run) makes the agent build its system
      // prompt from scratch; a non-empty transcript (a reply) makes it
      // continue the existing conversation instead — see CodingAgent.run.
      const result = await agent.run(task, run.messages);
      await eventsSettled(); // async-delivered file.changed events land before we read `changed`
      // Compute the diff BEFORE deciding status, so "review" actually triggers
      // when the run changed files (the guard was a no-op while changes was []).
      const turnChanges = await this.computeRunChanges(startSnap, changed);
      run.changes = this.mergeChanges(run.changes, turnChanges);
      run.status = run.changes.length > 0 ? "review" : "done";
      run.messages = result.transcript;
    } catch (err) {
      this.appendLine(run, "error", "Agent stopped", asMessage(err));
      run.status = "error";
    } finally {
      unsub();
      this.repointRunDiff = undefined;
      this.running = false;
      // Defensive: if the run threw while a prompt was open, drop it so the UI
      // doesn't show a stale approval for a run that is no longer executing.
      this.pendingApproval = null;
      await this.save();
      await saveRuns(this.runs);
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
