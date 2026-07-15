import { BrowserRuntime } from "@erdou/runtime-browser";
import type { Snapshot } from "@erdou/runtime-contract";
import type { FileChange } from "./studio.js";

/** Reads a path's text at some point in time. Absent file -> null. */
export type ReadText = (path: string) => string | null;

/**
 * Reads file contents out of a {@link Snapshot} by restoring it into a
 * throwaway runtime. Open ONCE per computation and reuse across paths —
 * restoring deserializes the whole tree, so per-file restores would be wasteful.
 */
export class SnapshotReader {
  private constructor(private readonly runtime: BrowserRuntime) {}

  static async open(snapshot: Snapshot): Promise<SnapshotReader> {
    const runtime = new BrowserRuntime();
    await runtime.boot();
    await runtime.restoreSnapshot(snapshot);
    return new SnapshotReader(runtime);
  }

  read(path: string): string | null {
    return this.runtime.fs.exists(path)
      ? new TextDecoder().decode(this.runtime.fs.readFile(path))
      : null;
  }
}

/**
 * Turn the set of changed paths into sorted `FileChange[]`, given readers for
 * the before (snapshot) and after (live) contents. Pure — the I/O lives in the
 * readers, which keeps the create/modify/delete classification unit-testable.
 */
export function buildFileChanges(paths: Iterable<string>, before: ReadText, after: ReadText): FileChange[] {
  const changes: FileChange[] = [];
  for (const path of paths) {
    const b = before(path);
    const a = after(path);
    if (b === a) continue; // touched but net-unchanged
    changes.push({
      path,
      kind: b === null ? "create" : a === null ? "delete" : "modify",
      before: b ?? "",
      after: a ?? "",
    });
  }
  return changes.sort((x, y) => (x.path < y.path ? -1 : 1));
}
