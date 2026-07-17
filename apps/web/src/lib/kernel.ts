import type { PipPyodideLoader } from "@erdou/lang-python";
import { BrowserRuntime } from "@erdou/runtime-browser";
import type { FileSystemApi, Runtime } from "@erdou/runtime-contract";
import type { PtySession } from "@erdou/runtime-vm";
// Subpath import ONLY (browser-clean — it imports just profiles.data.json). The
// barrel (".") would drag ~700KB of v86 into the main bundle (see the note on
// SKELETON_DIRS below). `VM_PROFILES` is a tiny data array; the type is erased.
import { VM_PROFILES, type VmProfile } from "@erdou/runtime-vm/profiles";
import { registerLanguages } from "./languages.js";

export type { VmProfile };

/** The VM kernel's six empty bind-mount stub dirs (image-owned, never real
 *  project content). Mirrors `@erdou/runtime-vm`'s `fs-bridge.ts`
 *  `SKELETON_DIRS` — duplicated here (rather than imported) because
 *  `@erdou/runtime-vm`'s package barrel (".") re-exports `v86-host.ts` -> the
 *  "v86" package, whose bundled `libv86.mjs` has top-level side-effecting
 *  statements (feature detection assigning module-scope vars). Rollup can't
 *  tree-shake a module with real side effects out of a chunk that statically
 *  imports anything from that barrel — confirmed by build measurement: a
 *  named import of `SKELETON_DIRS` from `@erdou/runtime-vm` here (or in
 *  `workspace-copy.ts`, which used to import it this way) pulled the ~700 KB
 *  v86 library into the main bundle instead of the lazily-loaded vm-kernel
 *  chunk. This local copy is the single browser-side source of truth; both
 *  `workspace-copy.ts` and `studio.ts` import it from here. */
export const SKELETON_DIRS: readonly string[] = ["bin", "lib", "usr", "proc", "dev", "tmp"];

/** The image-owned root dirs a cross-kernel workspace copy (and a VM folder
 *  save) must never mirror-DELETE, copy across kernels, or dump onto a user's
 *  disk: the six skeleton bind-mount stubs PLUS the VM-baked config dirs `/etc`
 *  (pip.conf, resolv.conf) and `/root` (.npmrc). Those two live IN the 9p
 *  workspace root but carry the package-egress config baked into each image —
 *  they are NOT user project content. Without them here, a browser→VM switch's
 *  mirror-delete wipes the baked configs off the live guest (pip + npm egress
 *  break — Round 13 CRITICAL), a VM→browser switch pollutes the browser Vfs
 *  with image system files, and a folder mount dumps /etc/pip.conf onto disk.
 *
 *  NOTE: this is deliberately WIDER than `SKELETON_DIRS`. `SKELETON_DIRS` stays
 *  the narrow set guardSkeleton (runtime-vm) uses to block writes to bind-mount
 *  points — guardSkeleton must still ALLOW writes under /etc,/root (e.g. pip's
 *  /root/.local user-site, npm cache). Only the mirror/copy/folder-sync layer
 *  widens to VM_PRESERVE_DIRS. */
export const VM_PRESERVE_DIRS: readonly string[] = [...SKELETON_DIRS, "etc", "root"];

/** The active execution environment: the fast browser kernel, or a VM kernel on
 *  a specific image profile. Its string id (`browser` | `vm:<profile>`) is the
 *  stable handle the selector, the switch tool, and the run-diff all key on. */
export type Environment = { kind: "browser" } | { kind: "vm"; profile: VmProfile };

/** `Environment` → its string id (`browser` | `vm:base` | `vm:node` | `vm:sci`). */
export function environmentId(env: Environment): string {
  return env.kind === "browser" ? "browser" : `vm:${env.profile}`;
}

/** Parse a string id back into an `Environment`. Fails loud (fail-fast) on an
 *  unknown id so a bad selector value or agent tool arg surfaces immediately. */
export function parseEnvironmentId(id: string): Environment {
  if (id === "browser") return { kind: "browser" };
  const profile = id.startsWith("vm:") ? id.slice(3) : "";
  if ((VM_PROFILES as readonly string[]).includes(profile)) return { kind: "vm", profile: profile as VmProfile };
  throw new Error(`Unknown environment id "${id}" (known: browser, ${VM_PROFILES.map((p) => `vm:${p}`).join(", ")})`);
}

/** Request/response shell session — the browser kernel's shape. Round 11's VM
 *  kernel adds a PTY-stream shape beside this one; consumers pick by kernel. */
export interface RpcShellSession {
  /** Live working directory — reads back after every command (for the prompt). */
  readonly cwd: string;
  exec(commandLine: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

/**
 * Everything the app needs from a runtime beyond the pure contract — the ONE
 * seam where a second kernel (Round 11's VM) slots in without touching Studio:
 * construction+provisioning, the persistent shell, and the host-side
 * synchronous workspace view (both kernels keep workspace truth host-side).
 */
export interface Kernel {
  readonly kind: "browser" | "vm";
  /** VM image profile (base/node/sci); undefined on the browser kernel. */
  readonly profile?: VmProfile;
  readonly runtime: Runtime;
  readonly fs: FileSystemApi;
  openShell(): RpcShellSession;
  /** Streaming interactive terminal — the VM kernel provides it; the browser kernel does not. */
  openPty?(opts?: { cols?: number; rows?: number }): Promise<PtySession>;
  /** Tear down the underlying guest — the VM kernel provides it (one-VM-alive
   *  switching calls it); the browser kernel omits it (it stays cached). */
  shutdown?(): Promise<void>;
}

// Pyodide CDN location — MUST stay in lock-step with the same constants in
// languages.ts. Duplicated deliberately: `registerLanguages` builds its default
// CDN loader internally and exposes no way to attach the pip-manifest hooks to
// it, so the app supplies its own hook-carrying copy through the `loadPyodide`
// seam (see `appPyodideLoader`). If `RegisterLanguagesOptions` ever grows a
// direct `pipInstalls` pass-through, delete these and pass the hooks plainly.
const PYODIDE_VERSION = "0.26.4";
const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

/**
 * The app's Pyodide loader: the same CDN load `registerLanguages` would default
 * to, with the pip-manifest hooks attached to the function itself
 * (`load.pipInstalls` — the one channel `registerLanguages` forwards into
 * `createPythonRunners`; see `PipPyodideLoader` in @erdou/lang-python). The
 * `typeof localStorage` guard covers storage-less contexts (node-side tests
 * construct browser kernels): there installs simply carry no persistence while
 * the session-only stderr notice still prints.
 */
function appPyodideLoader(): PipPyodideLoader {
  const load: PipPyodideLoader = async () => {
    const mod = await import(/* @vite-ignore */ `${PYODIDE_URL}pyodide.mjs`);
    return mod.loadPyodide({ indexURL: PYODIDE_URL });
  };
  if (typeof localStorage !== "undefined") load.pipInstalls = pipInstallPersistence(localStorage);
  return load;
}

export function createBrowserKernel(): Kernel {
  const runtime = new BrowserRuntime();
  registerLanguages(runtime, { loadPyodide: appPyodideLoader() });
  return {
    kind: "browser",
    runtime,
    fs: runtime.fs,
    openShell: () => runtime.openShell(),
  };
}

/** localStorage key for the browser-kernel pip manifest: the requirement
 *  strings `pip install` successfully ensured last session. Browser-kernel
 *  installs live in the in-memory Pyodide only (deliberately not snapshotted)
 *  and die with the page — the manifest lets the next session print a one-line
 *  `pip install <names>` restore hint (no automatic re-download). */
const PIP_MANIFEST_KEY = "erdou:pip-installs";

/** The two `Storage` methods the pip manifest uses — injected so node-side
 *  unit tests run without a DOM (`localStorage` satisfies it in the browser). */
export interface PipManifestStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Storage side of browser-kernel pip install transparency, shaped exactly for
 * lang-python's `PythonRuntimeOptions` (`previousInstalls` + `onInstall` —
 * that package stays storage-agnostic per the layering invariant).
 *
 * `previousInstalls` is read once, at creation (= session start): it must
 * reflect the PREVIOUS session, not installs made during this one. The first
 * `onInstall` of a session REPLACES the manifest (names the user chose not to
 * reinstall age out instead of accumulating forever); later ones append,
 * deduplicated.
 *
 * A corrupt/legacy manifest entry reads as empty — it is a convenience hint,
 * not state worth failing the kernel over (same localStorage tolerance as
 * layout-state); the next successful install overwrites it with valid JSON.
 *
 * Wired in `createBrowserKernel` through `appPyodideLoader`: the hooks ride on
 * the `loadPyodide` function (`load.pipInstalls`) because `registerLanguages`
 * forwards only the loader into `createPythonRunners`.
 */
export function pipInstallPersistence(store: PipManifestStore): {
  previousInstalls: string[];
  onInstall: (packages: string[]) => void;
} {
  const read = (): string[] => {
    const raw = store.getItem(PIP_MANIFEST_KEY);
    if (raw === null) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((p) => typeof p === "string")) return parsed as string[];
    } catch {
      // Unparsable manifest — treated exactly like a wrong-shaped one below.
    }
    return [];
  };
  let replacedThisSession = false;
  return {
    previousInstalls: read(),
    onInstall: (packages) => {
      const base = replacedThisSession ? read() : [];
      replacedThisSession = true;
      store.setItem(PIP_MANIFEST_KEY, JSON.stringify([...new Set([...base, ...packages])]));
    },
  };
}
