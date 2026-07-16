import type { Snapshot, SnapshotFsNode } from "@erdou/runtime-contract";
import type { FileChange } from "./studio.js";

/** Reads a path's text at some point in time. Absent file -> null. */
export type ReadText = (path: string) => string | null;

const b64ToBytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/**
 * Reads file contents straight out of a {@link Snapshot}'s JSON tree — no
 * runtime, no restore. Symlinks are not followed (diffs read workspace text
 * files by their own paths).
 */
export class SnapshotReader {
  private constructor(private readonly root: SnapshotFsNode) {}

  static open(snapshot: Snapshot): SnapshotReader {
    return new SnapshotReader(snapshot.fs);
  }

  read(path: string): string | null {
    let node: SnapshotFsNode | undefined = this.root;
    for (const part of path.split("/").filter(Boolean)) {
      if (!node || node.type !== "directory") return null;
      node = node.children[part];
    }
    if (!node || node.type !== "file") return null;
    return new TextDecoder().decode(b64ToBytes(node.data));
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
