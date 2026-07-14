import { ErrnoError } from "@erdou/runtime-contract";
import type { DirInode, Inode, SymlinkInode } from "./inode.js";
import { split } from "./path.js";

export interface ResolveResult {
  /** The directory that contains (or would contain) the final component. */
  parent: DirInode;
  /** The final path component ("/" when the path is the root itself). */
  name: string;
  /** The resolved node, or undefined if the final component does not exist. */
  node: Inode | undefined;
}

const MAX_SYMLINK_HOPS = 32;

interface Hops {
  count: number;
}

/**
 * Resolve an absolute path against a filesystem root.
 *
 * Intermediate symlinks are always followed; the final component is followed
 * only when `followSymlinks` is set (so lstat can see the link itself). Throws
 * ENOTDIR when a non-final component is not a directory and ELOOP after 32
 * symlink hops. A missing final component is not an error — it comes back as
 * `node: undefined` so callers like writeFile can create it.
 */
export function resolvePath(
  root: DirInode,
  path: string,
  opts: { followSymlinks: boolean },
): ResolveResult {
  const parts = split(path);
  if (parts.length === 0) {
    return { parent: root, name: "/", node: root };
  }

  const parentParts = parts.slice(0, -1);
  const name = parts[parts.length - 1]!;
  const hops: Hops = { count: 0 };

  const parentNode = resolveExisting(root, parentParts, hops);
  if (parentNode === undefined) {
    throw new ErrnoError("ENOENT", { path, syscall: "resolve" });
  }
  if (parentNode.type !== "directory") {
    throw new ErrnoError("ENOTDIR", { path, syscall: "resolve" });
  }

  let child = parentNode.children.get(name);
  if (child !== undefined && child.type === "symlink" && opts.followSymlinks) {
    child = followSymlink(root, parentParts, child, hops);
  }
  return { parent: parentNode, name, node: child };
}

/** Walk `parts` from root, following symlinks on every component. Returns the
 *  node, or undefined if a component is missing. */
function resolveExisting(root: DirInode, parts: string[], hops: Hops): Inode | undefined {
  let cur: Inode = root;
  const walked: string[] = [];
  for (const name of parts) {
    if (cur.type !== "directory") {
      throw new ErrnoError("ENOTDIR", { path: "/" + walked.join("/"), syscall: "resolve" });
    }
    const child = cur.children.get(name);
    if (child === undefined) return undefined;
    walked.push(name);
    if (child.type === "symlink") {
      const followed = followSymlink(root, walked.slice(0, -1), child, hops);
      if (followed === undefined) return undefined;
      cur = followed;
    } else {
      cur = child;
    }
  }
  return cur;
}

/** Resolve a symlink (and any chain of symlinks) to its terminal node. */
function followSymlink(
  root: DirInode,
  containingParts: string[],
  link: SymlinkInode,
  hops: Hops,
): Inode | undefined {
  let node: Inode = link;
  let baseParts = containingParts;
  while (node.type === "symlink") {
    if (++hops.count > MAX_SYMLINK_HOPS) {
      throw new ErrnoError("ELOOP", {
        path: "/" + [...baseParts, node.target].join("/"),
        syscall: "resolve",
      });
    }
    const targetParts = node.target.startsWith("/")
      ? split(node.target)
      : split("/" + [...baseParts, node.target].join("/"));
    const resolved = resolveExisting(root, targetParts, hops);
    if (resolved === undefined) return undefined;
    node = resolved;
    baseParts = targetParts.slice(0, -1);
  }
  return node;
}
