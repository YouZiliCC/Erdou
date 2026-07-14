import { ErrnoError } from "@erdou/runtime-contract";
import type {
  Stat,
  FileEntry,
  WriteFileOptions,
  MkdirOptions,
  RmOptions,
  RuntimeEvent,
} from "@erdou/runtime-contract";
import {
  newDir,
  newFile,
  newSymlink,
  type DirInode,
  type Inode,
} from "./inode.js";
import { resolvePath } from "./resolve.js";
import { normalize, split } from "./path.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === "string" ? encoder.encode(data) : new Uint8Array(data);
}

function deepClone(node: Inode): Inode {
  if (node.type === "file") return { ...node, data: new Uint8Array(node.data) };
  if (node.type === "symlink") return { ...node };
  const children = new Map<string, Inode>();
  for (const [k, v] of node.children) children.set(k, deepClone(v));
  return { ...node, children };
}

function statOf(node: Inode): Stat {
  const size = node.type === "file" ? node.data.length : node.type === "symlink" ? node.target.length : 0;
  return {
    type: node.type,
    size,
    mode: node.mode,
    mtimeMs: node.mtimeMs,
    ctimeMs: node.ctimeMs,
    birthtimeMs: node.birthtimeMs,
  };
}

export interface VfsOptions {
  clock?: () => number;
  onEvent?: (event: RuntimeEvent) => void;
}

/**
 * A synchronous, in-memory POSIX-ish filesystem. Every failure throws a typed
 * ErrnoError carrying the offending path — no operation silently creates
 * parents or swallows a missing file. The async Runtime surface wraps these.
 */
export class Vfs {
  private root: DirInode;
  private readonly clock: () => number;
  private readonly onEvent: ((event: RuntimeEvent) => void) | undefined;

  constructor(opts: VfsOptions = {}) {
    this.clock = opts.clock ?? (() => Date.now());
    this.onEvent = opts.onEvent;
    this.root = newDir(this.clock());
  }

  private emit(event: RuntimeEvent): void {
    this.onEvent?.(event);
  }

  readFile(path: string): Uint8Array {
    const { node } = resolvePath(this.root, path, { followSymlinks: true });
    if (node === undefined) throw new ErrnoError("ENOENT", { path, syscall: "open" });
    if (node.type === "directory") throw new ErrnoError("EISDIR", { path, syscall: "read" });
    if (node.type === "symlink") throw new ErrnoError("ENOENT", { path, syscall: "open" });
    return new Uint8Array(node.data);
  }

  readFileText(path: string): string {
    return decoder.decode(this.readFile(path));
  }

  writeFile(path: string, data: Uint8Array | string, opts: WriteFileOptions = {}): void {
    const now = this.clock();
    const { parent, name, node } = resolvePath(this.root, path, { followSymlinks: true });
    const bytes = toBytes(data);
    if (node === undefined) {
      parent.children.set(name, newFile(bytes, now, opts.mode ?? 0o644));
      parent.mtimeMs = now;
      this.emit({ type: "file.changed", path: normalize(path), kind: "create" });
      return;
    }
    if (node.type === "directory") throw new ErrnoError("EISDIR", { path, syscall: "write" });
    if (node.type === "symlink") throw new ErrnoError("EINVAL", { path, syscall: "write" });
    node.data = bytes;
    node.mtimeMs = now;
    if (opts.mode !== undefined) node.mode = opts.mode;
    this.emit({ type: "file.changed", path: normalize(path), kind: "modify" });
  }

  appendFile(path: string, data: Uint8Array | string): void {
    const now = this.clock();
    const { parent, name, node } = resolvePath(this.root, path, { followSymlinks: true });
    const extra = toBytes(data);
    if (node === undefined) {
      parent.children.set(name, newFile(extra, now));
      parent.mtimeMs = now;
      this.emit({ type: "file.changed", path: normalize(path), kind: "create" });
      return;
    }
    if (node.type !== "file") throw new ErrnoError("EISDIR", { path, syscall: "write" });
    const merged = new Uint8Array(node.data.length + extra.length);
    merged.set(node.data, 0);
    merged.set(extra, node.data.length);
    node.data = merged;
    node.mtimeMs = now;
    this.emit({ type: "file.changed", path: normalize(path), kind: "modify" });
  }

  mkdir(path: string, opts: MkdirOptions = {}): void {
    const recursive = opts.recursive ?? false;
    const mode = opts.mode ?? 0o755;
    const now = this.clock();
    const parts = split(path);
    if (parts.length === 0) {
      if (recursive) return;
      throw new ErrnoError("EEXIST", { path, syscall: "mkdir" });
    }
    if (recursive) {
      let cur = this.root;
      const walked: string[] = [];
      for (const name of parts) {
        walked.push(name);
        const existing = cur.children.get(name);
        if (existing === undefined) {
          const dir = newDir(now, mode);
          cur.children.set(name, dir);
          cur.mtimeMs = now;
          this.emit({ type: "file.changed", path: "/" + walked.join("/"), kind: "create" });
          cur = dir;
        } else if (existing.type === "directory") {
          cur = existing;
        } else {
          throw new ErrnoError("ENOTDIR", { path: "/" + walked.join("/"), syscall: "mkdir" });
        }
      }
      return;
    }
    const { parent, name, node } = resolvePath(this.root, path, { followSymlinks: false });
    if (node !== undefined) throw new ErrnoError("EEXIST", { path, syscall: "mkdir" });
    parent.children.set(name, newDir(now, mode));
    parent.mtimeMs = now;
    this.emit({ type: "file.changed", path: normalize(path), kind: "create" });
  }

  readdir(path: string): FileEntry[] {
    const { node } = resolvePath(this.root, path, { followSymlinks: true });
    if (node === undefined) throw new ErrnoError("ENOENT", { path, syscall: "scandir" });
    if (node.type !== "directory") throw new ErrnoError("ENOTDIR", { path, syscall: "scandir" });
    return [...node.children.entries()]
      .map(([name, child]): FileEntry => ({ name, type: child.type }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  rm(path: string, opts: RmOptions = {}): void {
    const recursive = opts.recursive ?? false;
    const force = opts.force ?? false;
    const now = this.clock();
    const { parent, name, node } = resolvePath(this.root, path, { followSymlinks: false });
    if (node === undefined) {
      if (force) return;
      throw new ErrnoError("ENOENT", { path, syscall: "unlink" });
    }
    if (node.type === "directory" && !recursive && node.children.size > 0) {
      throw new ErrnoError("ENOTEMPTY", { path, syscall: "rmdir" });
    }
    parent.children.delete(name);
    parent.mtimeMs = now;
    this.emit({ type: "file.changed", path: normalize(path), kind: "delete" });
  }

  rename(from: string, to: string): void {
    const now = this.clock();
    const src = resolvePath(this.root, from, { followSymlinks: false });
    if (src.node === undefined) throw new ErrnoError("ENOENT", { path: from, syscall: "rename" });
    const dst = resolvePath(this.root, to, { followSymlinks: false });
    src.parent.children.delete(src.name);
    src.parent.mtimeMs = now;
    dst.parent.children.set(dst.name, src.node);
    dst.parent.mtimeMs = now;
    this.emit({ type: "file.changed", path: normalize(from), kind: "delete" });
    this.emit({ type: "file.changed", path: normalize(to), kind: "create" });
  }

  copy(from: string, to: string): void {
    const now = this.clock();
    const src = resolvePath(this.root, from, { followSymlinks: false });
    if (src.node === undefined) throw new ErrnoError("ENOENT", { path: from, syscall: "copy" });
    const dst = resolvePath(this.root, to, { followSymlinks: false });
    if (dst.node !== undefined && dst.node.type === "directory" && src.node.type !== "directory") {
      // copy file INTO an existing directory, keeping its name
      dst.node.children.set(src.name, deepClone(src.node));
      dst.node.mtimeMs = now;
      this.emit({ type: "file.changed", path: normalize(to) + "/" + src.name, kind: "create" });
      return;
    }
    dst.parent.children.set(dst.name, deepClone(src.node));
    dst.parent.mtimeMs = now;
    this.emit({ type: "file.changed", path: normalize(to), kind: "create" });
  }

  stat(path: string): Stat {
    const { node } = resolvePath(this.root, path, { followSymlinks: true });
    if (node === undefined) throw new ErrnoError("ENOENT", { path, syscall: "stat" });
    return statOf(node);
  }

  lstat(path: string): Stat {
    const { node } = resolvePath(this.root, path, { followSymlinks: false });
    if (node === undefined) throw new ErrnoError("ENOENT", { path, syscall: "lstat" });
    return statOf(node);
  }

  chmod(path: string, mode: number): void {
    const { node } = resolvePath(this.root, path, { followSymlinks: true });
    if (node === undefined) throw new ErrnoError("ENOENT", { path, syscall: "chmod" });
    node.mode = mode & 0o7777;
    node.ctimeMs = this.clock();
  }

  symlink(target: string, linkPath: string): void {
    const now = this.clock();
    const { parent, name, node } = resolvePath(this.root, linkPath, { followSymlinks: false });
    if (node !== undefined) throw new ErrnoError("EEXIST", { path: linkPath, syscall: "symlink" });
    parent.children.set(name, newSymlink(target, now));
    parent.mtimeMs = now;
    this.emit({ type: "file.changed", path: normalize(linkPath), kind: "create" });
  }

  readlink(path: string): string {
    const { node } = resolvePath(this.root, path, { followSymlinks: false });
    if (node === undefined) throw new ErrnoError("ENOENT", { path, syscall: "readlink" });
    if (node.type !== "symlink") throw new ErrnoError("EINVAL", { path, syscall: "readlink" });
    return node.target;
  }

  exists(path: string): boolean {
    try {
      return resolvePath(this.root, path, { followSymlinks: true }).node !== undefined;
    } catch (err) {
      if (err instanceof ErrnoError && (err.code === "ENOENT" || err.code === "ENOTDIR" || err.code === "ELOOP")) {
        return false;
      }
      throw err;
    }
  }

  /** Internal accessors for the snapshot layer. */
  getRoot(): DirInode {
    return this.root;
  }

  replaceRoot(root: DirInode): void {
    this.root = root;
  }
}
