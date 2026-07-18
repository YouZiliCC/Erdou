import { zipSync } from "fflate";
import type { FileSystemApi } from "@erdou/runtime-contract";
import { VM_PRESERVE_DIRS } from "./kernel.js";

/** A built project archive: the raw zip bytes plus the facts the UI reports. */
export interface ProjectZip {
  bytes: Uint8Array;
  fileCount: number;
  byteSize: number;
}

/** Entry names excluded from the archive at EVERY depth:
 *  - `node_modules` — regenerable from the lockfile; bloat, not project truth.
 *  - `.erdou` — Erdou-internal session state. Its `config.json` carries the
 *    user's model API KEY in the clear (see folder-state.ts), so letting it
 *    into an export the user then shares would leak the credential. It must
 *    NEVER enter the archive; project-zip.test.ts pins this.
 *  `.git` is deliberately INCLUDED: version history is part of the project. */
const EXCLUDED_NAMES = new Set(["node_modules", ".erdou"]);

/**
 * Walk the workspace from "/" via the contract `FileSystemApi` and package
 * every project file into a zip (fflate). On the VM kernel the image-owned
 * root dirs (`VM_PRESERVE_DIRS` — skeleton bind mounts + baked /etc,/root)
 * are skipped at the root, the same set the folder-sync and kernel-switch
 * mirrors use, so an export never carries VM system files. Symlinks are
 * skipped, matching `copyWorkspace`'s cross-kernel mirror.
 *
 * Fail-fast: an empty workspace (0 files after the exclusions) throws a
 * precise error instead of producing an empty zip.
 */
export function buildProjectZip(fs: FileSystemApi, opts: { kernelKind: "browser" | "vm" }): ProjectZip {
  const files: Record<string, Uint8Array> = {};
  let fileCount = 0;
  const walk = (dir: string): void => {
    for (const entry of fs.readdir(dir)) {
      if (EXCLUDED_NAMES.has(entry.name)) continue;
      if (dir === "/" && opts.kernelKind === "vm" && VM_PRESERVE_DIRS.includes(entry.name)) continue;
      const path = dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`;
      if (entry.type === "directory") walk(path);
      else if (entry.type === "file") {
        files[path.slice(1)] = fs.readFile(path); // zip paths are relative (no leading "/")
        fileCount++;
      }
      // symlinks: skipped (rare in a user workspace; same policy as workspace-copy.ts)
    }
  };
  walk("/");
  if (fileCount === 0) {
    throw new Error(
      "Nothing to export: the workspace has no project files (node_modules and Erdou-internal state are excluded).",
    );
  }
  const bytes = zipSync(files);
  return { bytes, fileCount, byteSize: bytes.length };
}

/** Human-readable size for the export UI (B / KB / MB, one decimal). Pure. */
export function formatByteSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
