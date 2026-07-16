import type { FileSystemApi } from "@erdou/runtime-contract";
// Final-review (Round 11c) Fix 2: `SKELETON_DIRS` used to be imported from
// `@erdou/runtime-vm` directly, but that package's barrel re-exports the "v86"
// package, which has real top-level side effects Rollup can't tree-shake —
// build measurement showed this import alone pulled the ~700 KB v86 library
// into the main bundle instead of the lazily-loaded vm-kernel chunk. `./kernel.js`
// now holds the single browser-side copy of this constant; see its doc comment.
import { SKELETON_DIRS } from "./kernel.js";

/** Mirror the workspace from one sync FS to another so the destination becomes a
 *  copy of the source, NOT a union with its old contents. Skips the VM skeleton
 *  mount points (bin/lib/usr/proc/dev/tmp) at the root so a copy into a VM kernel
 *  never clobbers its bind mounts. Idempotent create of dirs.
 *
 *  Plan-review I1: this MUST be a mirror, not additive-only. Switch browser→vm→
 *  browser: a file the user deleted in the VM would otherwise resurrect from the
 *  stale browser tree. So on the top-level call we first delete every non-skeleton
 *  entry in `to` before copying `from` over it. */
export function copyWorkspace(from: FileSystemApi, to: FileSystemApi, root = "/"): void {
  if (root === "/") {
    for (const entry of to.readdir("/")) {
      if (SKELETON_DIRS.includes(entry.name)) continue; // never touch VM mount points
      to.rm(`/${entry.name}`, { recursive: true, force: true });
    }
  }
  for (const entry of from.readdir(root)) {
    if (root === "/" && SKELETON_DIRS.includes(entry.name)) continue;
    const path = root === "/" ? `/${entry.name}` : `${root}/${entry.name}`;
    if (entry.type === "directory") {
      to.mkdir(path, { recursive: true });
      copyWorkspace(from, to, path);
    } else if (entry.type === "file") {
      to.writeFile(path, from.readFile(path));
    }
    // symlinks: skip for the MVP (rare in a user workspace; the VM has its own system symlinks)
  }
}
