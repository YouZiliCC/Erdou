import { VmRuntime, loadBrowserInputs, type PtySession } from "@erdou/runtime-vm";
import type { FileSystemApi, Runtime } from "@erdou/runtime-contract";
import type { Kernel, RpcShellSession } from "./kernel.js";
import { createExecShell } from "./exec-shell.js";
import { vmAssets } from "./vm-assets.js";

interface VmLike extends Runtime {
  boot(): Promise<void>;
  syncFs(): FileSystemApi;
  openPty(opts?: { cols?: number; rows?: number }): Promise<PtySession>;
}

/** Construct + BOOT a VM kernel (kind "vm"). Boots the real Alpine guest from the
 *  Vite-served assets; returns a ready kernel. onProgress narrates the phases. */
export async function createVmKernel(opts: { onProgress?: (phase: string) => void; makeRuntime?: () => VmLike } = {}): Promise<Kernel> {
  const onProgress = opts.onProgress ?? (() => {});
  onProgress("Loading VM image…");
  const runtime = opts.makeRuntime
    ? opts.makeRuntime()
    : (new VmRuntime(() => loadBrowserInputs(vmAssets())) as unknown as VmLike);
  onProgress("Booting Alpine Linux…");
  await runtime.boot();
  onProgress("Ready");
  const fs = runtime.syncFs();
  return {
    kind: "vm",
    runtime,
    fs,
    openShell: (): RpcShellSession => createExecShell(runtime),
    openPty: (o) => runtime.openPty(o),
  };
}
