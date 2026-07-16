import { BrowserRuntime } from "@erdou/runtime-browser";
import type { FileSystemApi, Runtime } from "@erdou/runtime-contract";
import type { PtySession } from "@erdou/runtime-vm";
import { registerLanguages } from "./languages.js";

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
  readonly runtime: Runtime;
  readonly fs: FileSystemApi;
  openShell(): RpcShellSession;
  /** Streaming interactive terminal — the VM kernel provides it; the browser kernel does not. */
  openPty?(opts?: { cols?: number; rows?: number }): Promise<PtySession>;
}

export function createBrowserKernel(): Kernel {
  const runtime = new BrowserRuntime();
  registerLanguages(runtime);
  return {
    kind: "browser",
    runtime,
    fs: runtime.fs,
    openShell: () => runtime.openShell(),
  };
}
