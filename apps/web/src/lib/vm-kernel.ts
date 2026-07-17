import { VmRuntime, loadBrowserInputs, type PtySession } from "@erdou/runtime-vm";
import type { FileSystemApi, Runtime } from "@erdou/runtime-contract";
import type { Kernel, RpcShellSession, VmProfile } from "./kernel.js";
import { createExecShell } from "./exec-shell.js";
import { vmAssets } from "./vm-assets.js";

interface VmLike extends Runtime {
  boot(): Promise<void>;
  syncFs(): FileSystemApi;
  openPty(opts?: { cols?: number; rows?: number }): Promise<PtySession>;
  shutdown(): Promise<void>;
}

/** Construct + BOOT a VM kernel (kind "vm") for one image `profile`. The profile
 *  selects the per-image asset set (state-<profile>.zst, version + capabilities
 *  via PROFILE_META, threaded through vmAssets); onProgress narrates the phases.
 *  Returns a ready kernel carrying its `profile` (so the selector/one-VM-alive
 *  switch can tell profiles apart) and a `shutdown` that disposes the guest. */
export async function createVmKernel(
  opts: { profile?: VmProfile; onProgress?: (phase: string) => void; makeRuntime?: () => VmLike } = {},
): Promise<Kernel> {
  const profile: VmProfile = opts.profile ?? "base";
  const onProgress = opts.onProgress ?? (() => {});
  onProgress("Loading VM image…");
  const runtime: VmLike = opts.makeRuntime
    ? opts.makeRuntime()
    : new VmRuntime(() => loadBrowserInputs(vmAssets(profile)), { profile });
  onProgress("Booting Alpine Linux…");
  await runtime.boot();
  onProgress("Ready");
  const fs = runtime.syncFs();
  return {
    kind: "vm",
    profile,
    runtime,
    fs,
    openShell: (): RpcShellSession => createExecShell(runtime),
    openPty: (o) => runtime.openPty(o),
    shutdown: () => runtime.shutdown(),
  };
}
