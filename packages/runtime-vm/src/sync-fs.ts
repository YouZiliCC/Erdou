import { ErrnoError } from "@erdou/runtime-contract";
import type { FileEntry, RuntimeEvent, Stat, WriteFileOptions, MkdirOptions, RmOptions, FileSystemApi } from "@erdou/runtime-contract";
import { WORKSPACE, SKELETON_DIRS, type Fs9p } from "./fs-bridge.js";

const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFLNK = 0o120000, S_IFREG = 0o100000;
type ChangeKind = "create" | "modify" | "delete";

/** A synchronous FileSystemApi over v86's in-memory fs9p (Spike E). fs9p is the
 *  single shared store (guest sees writes via 9p; host reads/writes inodedata
 *  directly) — no page-side mirror. Page mutations emit file.changed synchronously.
 *
 *  EMISSION INVARIANT (resolved in Round 11c): when NO Fs9pBridge is attached over
 *  the same fs9p (as in 11b's standalone use + the e2e), SyncFs9pFs is the sole
 *  emitter and its synchronous file.changed is correct. If 11c attaches BOTH a
 *  Fs9pBridge (for the async Runtime FS) AND this SyncFs over one fs9p, the wrapped
 *  CreateFile/CreateDirectory/Unlink would ALSO emit → duplicate create/delete
 *  events. 11c must coordinate (share one emit+suppress path — e.g. construct
 *  SyncFs9pFs with the bridge and route mutations through its suppressed helpers).
 *  Not exercised in 11b (callers pass a no-op emit or none); do NOT pre-build it. */
export class SyncFs9pFs implements FileSystemApi {
  constructor(private readonly fs9p: Fs9p, private readonly emit: (e: RuntimeEvent) => void) {}

  private ws(path: string): string {
    const norm = "/" + path.split("/").filter(Boolean).join("/");
    return norm === "/" ? WORKSPACE : WORKSPACE + norm;
  }
  private cpath(path: string): string { return "/" + path.split("/").filter(Boolean).join("/"); }
  /** Basename — v86's SearchPath leaves `name` undefined for EXISTING paths, so
   *  rm/rename of an existing entry must derive it (same as fs-bridge.ts). */
  private base(path: string): string { const p = path.split("/").filter(Boolean); return p[p.length - 1] ?? ""; }
  /** Reject mutations under an image-owned mount point (bin/lib/usr/proc/dev/tmp). */
  private guardSkeleton(path: string, syscall: string): void {
    const first = path.split("/").filter(Boolean)[0];
    if (first !== undefined && SKELETON_DIRS.includes(first)) {
      throw new ErrnoError("EACCES", { path, syscall });
    }
  }
  private now(): number { return Math.round(Date.now() / 1000); }

  /** Fail loud on non-resident inodes (forwarder/submount status 5, on-storage
   *  status 2). Neither occurs in Erdou's `filesystem:{}` setup today; this keeps
   *  a future submount/lazy-image from silently returning wrong bytes. */
  private assertPlain(inode: { status?: number }, path: string, syscall: string): void {
    if (inode.status === 5 || inode.status === 2) throw new ErrnoError("EIO", { path, syscall });
  }

  readFile(path: string): Uint8Array {
    const w = this.fs9p.SearchPath(this.ws(path));
    if (w.id === -1) throw new ErrnoError("ENOENT", { path, syscall: "open" });
    const inode = this.fs9p.GetInode(w.id);
    this.assertPlain(inode as { status?: number }, path, "read");
    if ((inode.mode & S_IFMT) === S_IFDIR) throw new ErrnoError("EISDIR", { path, syscall: "read" });
    const data = this.fs9p.inodedata[w.id];
    if (!data) return new Uint8Array(0);                 // empty file (touch): no inodedata, size 0
    return data.slice(0, inode.size);                     // CLAMP to size (Write over-allocates 3/2×)
  }

  writeFile(path: string, data: Uint8Array | string, _opts?: WriteFileOptions): void {
    this.guardSkeleton(path, "open");
    const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const copy = new Uint8Array(buf.length); copy.set(buf);   // exact-length COPY (save_state serializes these)
    const w = this.fs9p.SearchPath(this.ws(path));
    let idx: number; let kind: ChangeKind;
    if (w.id === -1) {
      if (w.parentid === -1) throw new ErrnoError("ENOENT", { path, syscall: "open" });
      idx = this.fs9p.CreateFile(w.name, w.parentid);         // sync (goes through the bridge wrapper if attached → create event)
      kind = "create";
    } else {
      const inode = this.fs9p.GetInode(w.id);
      if ((inode.mode & S_IFMT) === S_IFDIR) throw new ErrnoError("EISDIR", { path, syscall: "write" });
      idx = w.id; kind = "modify";
    }
    this.fs9p.inodedata[idx] = copy;
    const inode = this.fs9p.GetInode(idx);
    inode.size = copy.length; inode.mtime = this.now(); inode.qid.version++; // qid bump defeats guest cache
    // create already emitted by the wrapped CreateFile if the bridge is attached;
    // overwrites bypass the wrapped Write → emit modify ourselves. Emit unconditionally
    // with the right kind; a duplicate create is harmless (consumers dedupe by path+tick).
    this.emit({ type: "file.changed", path: this.cpath(path), kind });
  }

  mkdir(path: string, opts?: MkdirOptions): void {
    this.guardSkeleton(path, "mkdir");
    const parts = path.split("/").filter(Boolean);
    let parentid = this.fs9p.SearchPath(WORKSPACE).id;
    for (let i = 0; i < parts.length; i++) {
      const existing = this.fs9p.Search(parentid, parts[i]!);
      if (existing !== -1) {
        if (i === parts.length - 1 && !opts?.recursive) throw new ErrnoError("EEXIST", { path, syscall: "mkdir" });
        parentid = existing;
      } else {
        if (i < parts.length - 1 && !opts?.recursive) throw new ErrnoError("ENOENT", { path, syscall: "mkdir" });
        parentid = this.fs9p.CreateDirectory(parts[i]!, parentid);
        this.emit({ type: "file.changed", path: "/" + parts.slice(0, i + 1).join("/"), kind: "create" });
      }
    }
  }

  readdir(path: string): FileEntry[] {
    const w = this.fs9p.SearchPath(this.ws(path));
    if (w.id === -1) throw new ErrnoError("ENOENT", { path, syscall: "scandir" });
    const inode = this.fs9p.GetInode(w.id);
    if ((inode.mode & S_IFMT) !== S_IFDIR) throw new ErrnoError("ENOTDIR", { path, syscall: "scandir" });
    const out: FileEntry[] = [];
    for (const [name, childId] of inode.direntries ?? []) {
      if (name === "." || name === "..") continue;
      const m = this.fs9p.GetInode(childId).mode & S_IFMT;
      out.push({ name, type: m === S_IFDIR ? "directory" : m === S_IFLNK ? "symlink" : "file" });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  rm(path: string, opts?: RmOptions): void {
    this.guardSkeleton(path, "unlink");
    const w = this.fs9p.SearchPath(this.ws(path));
    if (w.id === -1) { if (opts?.force) return; throw new ErrnoError("ENOENT", { path, syscall: "unlink" }); }
    const inode = this.fs9p.GetInode(w.id);
    if ((inode.mode & S_IFMT) === S_IFDIR && inode.direntries) {
      const kids = [...inode.direntries.keys()].filter((k) => k !== "." && k !== "..");
      if (kids.length && !opts?.recursive) throw new ErrnoError("ENOTEMPTY", { path, syscall: "rmdir" });
      for (const k of kids) this.rm(path.replace(/\/$/, "") + "/" + k, { recursive: true, force: true });
    }
    const ret = this.fs9p.Unlink(w.parentid, this.base(path));   // NOT w.name (undefined for existing paths)
    if (ret < 0) { if (opts?.force) return; throw new ErrnoError("ENOENT", { path, syscall: "unlink" }); }
    delete this.fs9p.inodedata[w.id];                            // free bytes only after a successful unlink
    this.emit({ type: "file.changed", path: this.cpath(path), kind: "delete" });
  }

  exists(path: string): boolean { return this.fs9p.SearchPath(this.ws(path)).id !== -1; }

  stat(path: string): Stat {
    const w = this.fs9p.SearchPath(this.ws(path));
    if (w.id === -1) throw new ErrnoError("ENOENT", { path, syscall: "stat" });
    const inode = this.fs9p.GetInode(w.id);
    const m = inode.mode & S_IFMT;
    return {
      type: m === S_IFDIR ? "directory" : m === S_IFLNK ? "symlink" : "file",
      size: inode.size, mode: inode.mode & 0o7777,
      mtimeMs: inode.mtime * 1000, ctimeMs: inode.mtime * 1000, birthtimeMs: inode.mtime * 1000,
    };
  }

  // FileSystemApi also declares appendFile/rename/copy/lstat/readlink/symlink/chmod.
  // Implement the ones apps/web needs now; the rest can throw a clear "not implemented
  // on the VM sync surface" until a consumer needs them (YAGNI). At minimum implement:
  lstat(path: string): Stat { return this.stat(path); } // SearchPath doesn't follow symlinks (parity with the async bridge)
  appendFile(path: string, data: Uint8Array | string): void {
    const cur = this.exists(path) ? this.readFile(path) : new Uint8Array(0);
    const extra = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const merged = new Uint8Array(cur.length + extra.length); merged.set(cur, 0); merged.set(extra, cur.length);
    this.writeFile(path, merged);
  }

  rename(_from: string, _to: string): void {
    throw new Error("SyncFs9pFs: rename not implemented (add when a consumer needs it)");
  }
  copy(_from: string, _to: string): void {
    throw new Error("SyncFs9pFs: copy not implemented (add when a consumer needs it)");
  }
  readlink(_path: string): string {
    throw new Error("SyncFs9pFs: readlink not implemented (add when a consumer needs it)");
  }
  symlink(_target: string, _linkPath: string): void {
    throw new Error("SyncFs9pFs: symlink not implemented (add when a consumer needs it)");
  }
  chmod(_path: string, _mode: number): void {
    throw new Error("SyncFs9pFs: chmod not implemented (add when a consumer needs it)");
  }
}
