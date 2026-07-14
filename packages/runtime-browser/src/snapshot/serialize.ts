import { ErrnoError } from "@erdou/runtime-contract";
import type { Snapshot, SnapshotFsNode } from "@erdou/runtime-contract";
import type { Inode } from "../vfs/inode.js";
import { newDir, newFile, newSymlink } from "../vfs/inode.js";
import type { Vfs } from "../vfs/vfs.js";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function serializeNode(node: Inode): SnapshotFsNode {
  if (node.type === "file") return { type: "file", mode: node.mode, data: toBase64(node.data) };
  if (node.type === "symlink") return { type: "symlink", mode: node.mode, target: node.target };
  const children: Record<string, SnapshotFsNode> = {};
  for (const [name, child] of node.children) children[name] = serializeNode(child);
  return { type: "directory", mode: node.mode, children };
}

function deserializeNode(node: SnapshotFsNode, now: number): Inode {
  if (node.type === "file") return newFile(fromBase64(node.data), now, node.mode);
  if (node.type === "symlink") return newSymlink(node.target, now, node.mode);
  const dir = newDir(now, node.mode);
  for (const [name, child] of Object.entries(node.children)) {
    dir.children.set(name, deserializeNode(child, now));
  }
  return dir;
}

/** Serialize the whole filesystem into a JSON/structured-clone-safe snapshot. */
export function snapshotVfs(vfs: Vfs, now: number): Snapshot {
  return { version: 1, createdAtMs: now, fs: serializeNode(vfs.getRoot()) };
}

/** Replace the filesystem contents with a snapshot's, exactly. */
export function restoreVfs(vfs: Vfs, snapshot: Snapshot, now: number): void {
  const root = deserializeNode(snapshot.fs, now);
  if (root.type !== "directory") {
    throw new ErrnoError("EINVAL", { syscall: "restore", path: "snapshot root is not a directory" });
  }
  vfs.replaceRoot(root);
}
