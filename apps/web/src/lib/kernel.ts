import { BrowserRuntime } from "@erdou/runtime-browser";
import type { FileSystemApi, Runtime } from "@erdou/runtime-contract";
import { registerLanguages } from "./languages.js";

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
  readonly kind: "browser";
  readonly runtime: Runtime;
  readonly fs: FileSystemApi;
  openShell(): RpcShellSession;
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
