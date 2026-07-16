import type { Snapshot, SnapshotFsNode } from "@erdou/runtime-contract";
import { Fs9pBridge, WORKSPACE, SKELETON_DIRS, type Fs9p } from "./fs-bridge.js";

const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFLNK = 0o120000;

// Portable base64 (browser + Node) — avoids a Node-only symbol that would
// ReferenceError in the browser, where this module is reachable from the
// default entry.
const toB64 = (b: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Serialize the /workspace subtree (minus skeleton mount points) to a contract Snapshot. */
export async function snapshotWorkspace(fs9p: Fs9p, clock: () => number): Promise<Snapshot> {
  const ws = fs9p.SearchPath(WORKSPACE);
  if (ws.id === -1) throw new Error("snapshotWorkspace: no /workspace");
  const build = async (id: number, atRoot: boolean): Promise<SnapshotFsNode> => {
    const inode = fs9p.GetInode(id);
    const m = inode.mode & S_IFMT;
    if (m === S_IFDIR) {
      const children: Record<string, SnapshotFsNode> = {};
      for (const [name, childId] of inode.direntries ?? []) {
        if (name === "." || name === "..") continue;
        if (atRoot && SKELETON_DIRS.includes(name)) continue; // image-owned mount points
        children[name] = await build(childId, false);
      }
      return { type: "directory", mode: inode.mode & 0o7777, children };
    }
    if (m === S_IFLNK) return { type: "symlink", mode: inode.mode & 0o7777, target: inode.symlink ?? "" };
    const path = pathOf(fs9p, id);
    const data = (await fs9p.read_file(path)) ?? new Uint8Array(0);
    return { type: "file", mode: inode.mode & 0o7777, data: toB64(data) };
  };
  return { version: 1, createdAtMs: clock(), fs: await build(ws.id, true) };
}

/** Recompute a fs9p path for an inode by walking from the workspace root. */
function pathOf(fs9p: Fs9p, target: number): string {
  const ws = fs9p.SearchPath(WORKSPACE).id;
  let found = "";
  const walk = (id: number, rel: string): boolean => {
    if (id === target) { found = rel; return true; }
    for (const [name, childId] of fs9p.GetInode(id).direntries ?? []) {
      if (name === "." || name === "..") continue;
      if (walk(childId, rel + "/" + name)) return true;
    }
    return false;
  };
  walk(ws, WORKSPACE);
  return found;
}

/** Clear the workspace (except skeleton) and rewrite the snapshot via the bridge. */
export async function restoreWorkspace(fs9p: Fs9p, bridge: Fs9pBridge, snap: Snapshot): Promise<void> {
  const wsId = fs9p.SearchPath(WORKSPACE).id;
  const top = fs9p.GetInode(wsId).direntries;
  if (top) {
    for (const name of [...top.keys()]) {
      if (name === "." || name === ".." || SKELETON_DIRS.includes(name)) continue;
      await bridge.rm("/" + name, { recursive: true, force: true });
    }
  }
  if (snap.fs.type !== "directory") return;
  const write = async (node: SnapshotFsNode, prefix: string): Promise<void> => {
    if (node.type === "directory") {
      if (prefix !== "") { await bridge.mkdir(prefix, { recursive: true }); bridge.chmod(prefix, node.mode); }
      for (const [name, child] of Object.entries(node.children)) await write(child, prefix + "/" + name);
    } else if (node.type === "file") {
      await bridge.writeFile(prefix, fromB64(node.data));
      bridge.chmod(prefix, node.mode);
    } else if (node.type === "symlink") {
      bridge.symlink(node.target, prefix);
    }
  };
  await write(snap.fs, "");
}
