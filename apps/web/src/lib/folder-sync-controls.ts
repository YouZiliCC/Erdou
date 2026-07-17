import type { FileSystemApi } from "@erdou/runtime-contract";
import { loadFolderIntoVfs, saveVfsToFolder, type DirHandleLike, type MountMtimes } from "./local-mount.js";

// Explicit, one-shot MANUAL folder-sync operations, kept separate from the
// debounced auto-sync in studio.ts. Each is the "force it now" counterpart of
// an auto path and reuses the same primitives, so the two directions can never
// drift apart in how they treat the VM skeleton/preserve dirs or the mtimes map.

/** Manual "Pull from disk ↓": load every file from the mounted folder into the
 *  workspace now — disk wins. This is a full re-load (`loadFolderIntoVfs`), not
 *  the mtime-gated background rescan: the user is explicitly asking to overwrite
 *  the workspace with what is on disk. Updates `mtimes` so the auto write-back
 *  doesn't then treat the pulled files as local edits. Returns the file count. */
export async function pullDiskToWorkspace(
  handle: DirHandleLike,
  fs: FileSystemApi,
  mtimes?: MountMtimes,
): Promise<number> {
  return loadFolderIntoVfs(handle, fs, "/", mtimes);
}

/** Manual "Push to disk ↑": write the whole workspace back to the mounted
 *  folder now. `rootSkip` (VM_PRESERVE_DIRS on the VM kernel, `undefined` on the
 *  browser kernel) is honored exactly as the auto-save path does — image-owned
 *  skeleton/etc/root dirs at the workspace root never reach the user's disk. */
export async function pushWorkspaceToDisk(
  handle: DirHandleLike,
  fs: FileSystemApi,
  mtimes?: MountMtimes,
  rootSkip?: ReadonlySet<string>,
): Promise<void> {
  await saveVfsToFolder(fs, handle, "/", mtimes, rootSkip);
}

/** Re-run the directory picker to choose a DIFFERENT folder, then hand it to
 *  `mount` (which persists + loads the new handle, replacing the current one).
 *  `pick` and `mount` are injected so this stays hermetic — the real picker is a
 *  browser-only user-gesture API. A user-cancelled picker (`AbortError`) is not
 *  an error: return `null` and leave the current mount untouched. Returns the
 *  newly-mounted handle on success. */
export async function reselectFolder(
  pick: () => Promise<DirHandleLike>,
  mount: (handle: DirHandleLike) => Promise<void>,
): Promise<DirHandleLike | null> {
  let handle: DirHandleLike;
  try {
    handle = await pick();
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return null;
    throw err;
  }
  await mount(handle);
  return handle;
}
