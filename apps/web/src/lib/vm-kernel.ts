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

/** Turn raw state-download byte counts (per network chunk) into onProgress
 *  phase strings — "Downloading VM image… 12 / 48 MB" — throttled to ≤5
 *  updates/sec so a 48-84MB download narrates without flooding the UI. The
 *  final count (loaded === total) always lands. `now` is a test clock,
 *  mirroring VmRuntime's `clock` option. */
export function downloadPhaseReporter(
  onProgress: (phase: string) => void,
  now: () => number = Date.now,
): (loadedBytes: number, totalBytes: number | null) => void {
  const mb = (n: number): number => Math.round(n / (1024 * 1024));
  let lastEmit = -Infinity;
  return (loaded, total) => {
    const t = now();
    if (t - lastEmit < 200 && !(total !== null && loaded >= total)) return;
    lastEmit = t;
    onProgress(total !== null
      ? `Downloading VM image… ${mb(loaded)} / ${mb(total)} MB`
      : `Downloading VM image… ${mb(loaded)} MB`);
  };
}

/** Construct + BOOT a VM kernel (kind "vm") for one image `profile`. The profile
 *  selects the per-image asset set (state-<profile>.zst, version + capabilities
 *  via PROFILE_META, threaded through vmAssets); onProgress narrates the phases,
 *  including per-MB byte progress while the state blob downloads on a cache miss.
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
    : new VmRuntime(async () => {
        // Download (with byte progress) + decompress happen inside this loader,
        // so "Booting…" must not be announced until the inputs are actually in
        // hand — otherwise the last "Downloading…" line sticks through boot.
        const inputs = await loadBrowserInputs({ ...vmAssets(profile), onStateDownload: downloadPhaseReporter(onProgress) });
        onProgress("Booting Alpine Linux…");
        return inputs;
      }, { profile });
  if (opts.makeRuntime) onProgress("Booting Alpine Linux…"); // injected runtimes load nothing
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
