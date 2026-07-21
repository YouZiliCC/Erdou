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
    const node = this.lookup(path);
    if (!node || node.type !== "file") return null;
    return new TextDecoder().decode(b64ToBytes(node.data));
  }

  /**
   * Every FILE path at or under `path`, when `path` is a directory in the
   * snapshot; `[]` otherwise (missing, file, symlink). The run diff's expansion
   * source: deleting/renaming a directory emits ONE file.changed for the
   * directory itself, and the files that lived beneath it are what the diff
   * must show as deleted. Symlinks are skipped, matching `read`.
   */
  filesUnder(path: string): string[] {
    const node = this.lookup(path);
    if (!node || node.type !== "directory") return [];
    const base = "/" + path.split("/").filter(Boolean).join("/");
    const out: string[] = [];
    const walk = (dir: Extract<SnapshotFsNode, { type: "directory" }>, prefix: string): void => {
      for (const [name, child] of Object.entries(dir.children)) {
        const childPath = prefix === "/" ? `/${name}` : `${prefix}/${name}`;
        if (child.type === "file") out.push(childPath);
        else if (child.type === "directory") walk(child, childPath);
      }
    };
    walk(node, base);
    return out;
  }

  private lookup(path: string): SnapshotFsNode | undefined {
    let node: SnapshotFsNode | undefined = this.root;
    for (const part of path.split("/").filter(Boolean)) {
      if (!node || node.type !== "directory") return undefined;
      node = node.children[part];
    }
    return node;
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
