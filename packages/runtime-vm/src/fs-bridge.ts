import { ErrnoError } from "@erdou/runtime-contract";
import type { FileEntry, RuntimeEvent, Stat, WriteFileOptions, MkdirOptions, RmOptions } from "@erdou/runtime-contract";

export const WORKSPACE = "workspace";
export const SKELETON_DIRS = ["bin", "lib", "usr", "proc", "dev", "tmp"];

const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFREG = 0o100000, S_IFLNK = 0o120000;

/** The subset of v86's `emulator.fs9p` (class FS) the bridge drives. Method
 *  names verified present in the shipped minified build (Spike A). */
export interface Fs9pInode { mode: number; size: number; direntries?: Map<string, number>; symlink?: string; mtime: number; qid: { version: number }; }
export interface Fs9p {
  inodes: Fs9pInode[];
  /** idx -> file bytes (real v86 has this field; Write over-allocates ~3/2× while
   *  inode.size holds the exact length — readers must clamp to inode.size). */
  inodedata: Record<number, Uint8Array | undefined>;
  GetInode(idx: number): Fs9pInode;
  CreateFile(name: string, parentid: number): number;
  CreateDirectory(name: string, parentid: number): number;
  CreateSymlink(name: string, parentid: number, target: string): number;
  CreateBinaryFile(name: string, parentid: number, buf: Uint8Array): Promise<number>;
  Write(idx: number, offset: number, count: number, buf: Uint8Array): Promise<void>;
  ChangeSize(idx: number, size: number): Promise<void>;
  Unlink(parentid: number, name: string): number;
  Rename(olddir: number, oldname: string, newdir: number, newname: string): Promise<number>;
  Search(parentid: number, name: string): number;
  SearchPath(path: string): { id: number; parentid: number; name: string | undefined };
  GetFullPath(idx: number): string;
  read_file(path: string): Promise<Uint8Array | null>;
}

type ChangeKind = "create" | "modify" | "delete";

/** Collapse "." / ".." and clamp at the root. The COLLAPSE is exactly
 *  runtime-browser's vfs normalize(); the GRAMMAR deliberately is NOT — that
 *  normalize() throws EINVAL for anything not starting with "/", while this ROOTS a
 *  relative path ("etc/passwd" -> "/etc/passwd"). Both VM FS implementations have
 *  always rooted relatives and nothing upstream checks absoluteness (agent-tools'
 *  read_file/write_file only assert `typeof path === "string"`), so tightening to
 *  EINVAL would break working VM sessions and buy nothing: rooting CONTAINS rather
 *  than escapes — the result is "/"-prefixed, clamped at the root by the stack.pop()
 *  below, and ws() still puts WORKSPACE in front of it.
 *  MANDATORY before mapping to a 9p path: agent tools hand model-authored paths
 *  through untouched, and v86 puts REAL "."/".." direntries on every directory
 *  (link_under_dir), so an uncollapsed "/../etc/passwd" maps to 9p
 *  "workspace/../etc/passwd" and SearchPath walks straight out of the workspace
 *  into the guest image root — past guardSkeleton, which only sees the FIRST
 *  segment (".." / "." are never in SKELETON_DIRS). */
export function normalizeContractPath(path: string): string {
  const stack: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { stack.pop(); continue; }
    stack.push(seg);
  }
  return "/" + stack.join("/");
}

/** Wraps fs9p to observe guest writes and exposes an async workspace FS.
 *  Contract path `/x` maps to fs9p path `workspace/x`. */
export class Fs9pBridge {
  private suppress = 0;
  private inWrite = 0;
  private readonly paths = new Map<number, string>(); // inode idx -> fs9p-relative path ("" = export root)
  private readonly pendingChanges = new Map<string, ChangeKind>(); // contract path -> kind (coalesced)
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly coalesceMs: number;
  private orig: Record<string, (...a: any[]) => any> = {};

  constructor(private readonly fs: Fs9p, private readonly emit: (e: RuntimeEvent) => void, opts: { coalesceMs?: number } = {}) {
    this.coalesceMs = opts.coalesceMs ?? 10;
  }

  attach(): void {
    this.paths.set(0, "");
    this.rebuildIndex();
    const fs = this.fs as any;
    for (const m of ["CreateFile", "CreateDirectory", "CreateSymlink", "Write", "ChangeSize", "Unlink", "Rename"]) this.orig[m] = fs[m];
    const self = this;
    const join = (dir: string, name: string) => (dir ? dir + "/" + name : name);
    const dirPath = (parentid: number): string => {
      let p = self.paths.get(parentid);
      if (p === undefined) { p = self.fs.GetFullPath(parentid); self.paths.set(parentid, p); }
      return p;
    };

    fs.CreateFile = function (name: string, parentid: number) {
      const idx = self.orig.CreateFile!.call(this, name, parentid);
      const p = join(dirPath(parentid), name); self.paths.set(idx, p);
      self.record(p, "create"); return idx;
    };
    fs.CreateDirectory = function (name: string, parentid: number) {
      const idx = self.orig.CreateDirectory!.call(this, name, parentid);
      if (parentid >= 0) { const p = join(dirPath(parentid), name); self.paths.set(idx, p); self.record(p, "create"); }
      return idx;
    };
    fs.CreateSymlink = function (name: string, parentid: number, target: string) {
      const idx = self.orig.CreateSymlink!.call(this, name, parentid, target);
      const p = join(dirPath(parentid), name); self.paths.set(idx, p); self.record(p, "create"); return idx;
    };
    fs.Write = async function (idx: number, offset: number, count: number, buffer: Uint8Array) {
      self.inWrite++;
      try { await self.orig.Write!.call(this, idx, offset, count, buffer); } finally { self.inWrite--; }
      self.record(self.paths.get(idx) ?? `<inode:${idx}>`, "modify");
    };
    fs.ChangeSize = async function (idx: number, newsize: number) {
      const oldsize = this.GetInode(idx).size;
      await self.orig.ChangeSize!.call(this, idx, newsize);
      if (!self.inWrite && newsize !== oldsize) self.record(self.paths.get(idx) ?? `<inode:${idx}>`, "modify");
    };
    fs.Unlink = function (parentid: number, name: string) {
      const idx = this.Search(parentid, name);
      const p = idx !== -1 ? (self.paths.get(idx) ?? join(dirPath(parentid), name)) : null;
      const ret = self.orig.Unlink!.call(this, parentid, name);
      if (ret === 0 && idx !== -1 && p !== null) { self.paths.delete(idx); self.record(p, "delete"); }
      return ret;
    };
    fs.Rename = async function (olddir: number, oldname: string, newdir: number, newname: string) {
      const idx = this.Search(olddir, oldname);
      const oldPath = idx !== -1 ? (self.paths.get(idx) ?? join(dirPath(olddir), oldname)) : null;
      const ret = await self.orig.Rename!.call(this, olddir, oldname, newdir, newname);
      if (ret === 0 && idx !== -1 && oldPath !== null) {
        const newPath = join(dirPath(newdir), newname);
        const prefix = oldPath + "/";
        for (const [i, p] of self.paths) {
          if (i === idx) self.paths.set(i, newPath);
          else if (p.startsWith(prefix)) self.paths.set(i, newPath + "/" + p.slice(prefix.length));
        }
        self.record(oldPath, "delete"); self.record(newPath, "create");
      }
      return ret;
    };
  }

  /** Re-walk workspace/ into the idx→path map (call after restore_state). */
  rebuildIndex(): void {
    this.paths.clear();
    this.paths.set(0, "");
    const ws = this.fs.SearchPath(WORKSPACE);
    if (ws.id === -1) return;
    const walk = (id: number, rel: string): void => {
      this.paths.set(id, rel);
      const d = this.fs.inodes[id]?.direntries;
      if (!d) return;
      for (const [name, childId] of d) {
        if (name === "." || name === "..") continue;
        walk(childId, rel ? rel + "/" + name : name);
      }
    };
    walk(ws.id, WORKSPACE);
  }

  // ---- event coalescing + workspace filter ----
  private contractPath(fs9pPath: string): string | null {
    if (fs9pPath === WORKSPACE) return "/";
    if (fs9pPath.startsWith(WORKSPACE + "/")) {
      const rest = fs9pPath.slice(WORKSPACE.length + 1);
      const parts = rest.split("/");
      if (SKELETON_DIRS.includes(parts[0]!) ) return null; // bind-mount points are image-owned
      return "/" + rest;
    }
    return null; // sys-root / bind-mount writes — not the workspace
  }

  private record(fs9pPath: string, kind: ChangeKind): void {
    if (this.suppress) return;
    const cp = this.contractPath(fs9pPath);
    if (cp === null || cp === "/") return;
    // create beats modify; delete overrides a pending create/modify.
    const prev = this.pendingChanges.get(cp);
    if (kind === "delete") this.pendingChanges.set(cp, "delete");
    else if (prev === undefined) this.pendingChanges.set(cp, kind);
    else if (prev === "modify" && kind === "create") this.pendingChanges.set(cp, "create");
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), this.coalesceMs);
  }

  flush(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined; }
    const batch = [...this.pendingChanges.entries()];
    this.pendingChanges.clear();
    for (const [path, kind] of batch) this.emit({ type: "file.changed", path, kind });
  }

  /** Tear down: stop the coalesce timer without flushing (shutdown discards
   *  in-flight change notifications — there's no listener left to receive them). */
  dispose(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined; }
    this.pendingChanges.clear();
  }

  /** Emit a page-side (contract-API) file.changed SYNCHRONOUSLY — NOT through
   *  the coalesce timer — so it lands within the caller's call (honors the
   *  contract's one-macrotask delivery bound; conformance's file.changed test
   *  does writeFile→writeFile→rm and waits for each event). `contractPath` is
   *  already "/x" form. Guest writes stay coalesced via record(); these don't. */
  private emitChange(contractPath: string, kind: ChangeKind): void {
    this.emit({ type: "file.changed", path: contractPath, kind });
  }

  /** Normalize a contract path to "/x" form (for events). */
  private cpath(path: string): string {
    return normalizeContractPath(path);
  }

  /** Basename (last path segment). v86's SearchPath only fills `name` when the
   *  final component is MISSING (id === -1); for an EXISTING path it leaves
   *  `name` undefined (its loop index runs off the end). So for Unlink/Rename of
   *  an existing entry we must derive the name from the path, not trust w.name. */
  private base(path: string): string {
    const parts = normalizeContractPath(path).split("/").filter(Boolean);
    return parts[parts.length - 1] ?? "";
  }

  /** Reject mutations under an image-owned mount point (bin/lib/usr/proc/dev/tmp).
   *  Checks the NORMALIZED first segment — "/./bin/sh" and "/tmp/../usr/lib" both
   *  land on a mount point while their literal first segment does not. */
  private guardSkeleton(path: string, syscall: string): void {
    const norm = normalizeContractPath(path);
    const first = norm.split("/").filter(Boolean)[0];
    if (first !== undefined && SKELETON_DIRS.includes(first)) {
      throw new ErrnoError("EACCES", { path: norm, syscall });
    }
  }

  // ---- async workspace FS (contract "/x" <-> fs9p "workspace/x") ----
  private ws(path: string): string {
    const norm = normalizeContractPath(path);
    return norm === "/" ? WORKSPACE : WORKSPACE + norm;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const w = this.fs.SearchPath(this.ws(path));
    if (w.id === -1) throw new ErrnoError("ENOENT", { path, syscall: "open" });
    const data = await this.fs.read_file(this.ws(path));
    return data ?? new Uint8Array(0); // empty/never-written file: inode exists, no inodedata
  }

  async writeFile(path: string, data: Uint8Array | string, _opts?: WriteFileOptions): Promise<void> {
    this.guardSkeleton(path, "open");
    const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
    this.suppress++;
    try {
      const w = this.fs.SearchPath(this.ws(path));
      let idx: number;
      let kind: ChangeKind;
      if (w.id === -1) {
        if (w.parentid === -1) throw new ErrnoError("ENOENT", { path, syscall: "open" });
        idx = await this.fs.CreateBinaryFile(this.base(path), w.parentid, buf);
        kind = "create";
      } else {
        // A contract path can resolve onto a DIRECTORY ("/somedir", or "/a/b/.."
        // after normalization). ChangeSize+Write against a directory inode install
        // file bytes and rewrite inode.size on it — silent corruption that survives
        // into get_state. Same refusal (and shape) as SyncFs9pFs.writeFile.
        if ((this.fs.GetInode(w.id).mode & S_IFMT) === S_IFDIR) throw new ErrnoError("EISDIR", { path, syscall: "write" });
        await this.fs.ChangeSize(w.id, buf.length);
        await this.fs.Write(w.id, 0, buf.length, buf);
        idx = w.id; kind = "modify";
      }
      const inode = this.fs.GetInode(idx); inode.mtime = Math.round(Date.now() / 1000); inode.qid.version++;
      this.paths.set(idx, this.ws(path));
      this.emitChange(this.cpath(path), kind); // synchronous — contract requires the event
    } finally { this.suppress--; }
    void _opts;
  }

  async readdir(path: string): Promise<FileEntry[]> {
    const w = this.fs.SearchPath(this.ws(path));
    if (w.id === -1) throw new ErrnoError("ENOENT", { path, syscall: "scandir" });
    const inode = this.fs.GetInode(w.id);
    if ((inode.mode & S_IFMT) !== S_IFDIR) throw new ErrnoError("ENOTDIR", { path, syscall: "scandir" });
    const out: FileEntry[] = [];
    for (const [name, childId] of inode.direntries ?? []) {
      if (name === "." || name === "..") continue;
      const m = this.fs.GetInode(childId).mode & S_IFMT;
      out.push({ name, type: m === S_IFDIR ? "directory" : m === S_IFLNK ? "symlink" : "file" });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async mkdir(path: string, opts?: MkdirOptions): Promise<void> {
    this.guardSkeleton(path, "mkdir");
    this.suppress++;
    try {
      const parts = normalizeContractPath(path).split("/").filter(Boolean);
      let parentid = this.fs.SearchPath(WORKSPACE).id;
      for (let i = 0; i < parts.length; i++) {
        const existing = this.fs.Search(parentid, parts[i]!);
        if (existing !== -1) {
          if (i === parts.length - 1 && !opts?.recursive) throw new ErrnoError("EEXIST", { path, syscall: "mkdir" });
          parentid = existing;
        } else {
          if (i < parts.length - 1 && !opts?.recursive) throw new ErrnoError("ENOENT", { path, syscall: "mkdir" });
          const id = this.fs.CreateDirectory(parts[i]!, parentid);
          this.paths.set(id, WORKSPACE + "/" + parts.slice(0, i + 1).join("/"));
          this.emitChange("/" + parts.slice(0, i + 1).join("/"), "create"); // each newly-created dir
          parentid = id;
        }
      }
    } finally { this.suppress--; }
  }

  async rm(path: string, opts?: RmOptions): Promise<void> {
    this.guardSkeleton(path, "unlink");
    // The workspace ROOT is never removable, and refusing it must happen BEFORE the
    // recursive walk: "/" (or anything normalizing to it, e.g. "/a/..") otherwise
    // deletes the user's top-level entries one by one until the first skeleton dir
    // raises EACCES — a half-erased workspace, and with force:true not even an error.
    // Deleting the root itself would also unlink workspace/ from the export root.
    if (normalizeContractPath(path) === "/") throw new ErrnoError("EACCES", { path: "/", syscall: "unlink" });
    this.suppress++;
    try {
      const w = this.fs.SearchPath(this.ws(path));
      if (w.id === -1) { if (opts?.force) return; throw new ErrnoError("ENOENT", { path, syscall: "unlink" }); }
      const inode = this.fs.GetInode(w.id);
      if ((inode.mode & S_IFMT) === S_IFDIR && inode.direntries) {
        const kids = [...inode.direntries.keys()].filter((k) => k !== "." && k !== "..");
        if (kids.length && !opts?.recursive) throw new ErrnoError("ENOTEMPTY", { path, syscall: "rmdir" });
        for (const k of kids) await this.rm(path.replace(/\/$/, "") + "/" + k, { recursive: true, force: true });
      }
      const ret = this.fs.Unlink(w.parentid, this.base(path));
      if (ret < 0 && !opts?.force) throw new ErrnoError("ENOENT", { path, syscall: "unlink" });
      // Free the bytes only after a SUCCESSFUL unlink (mirrors SyncFs9pFs.rm).
      // v86's Unlink just drops the direntry and flags the inode; the data is
      // released by CloseInode→DeleteData, which only the guest's 9p Tclunk
      // drives and never runs for a host-side unlink — so without this every
      // write→delete cycle (and every restoreSnapshot, which rm's each
      // top-level entry) retains its megabytes for the session AND keeps
      // serialising them into FS.get_state.
      if (ret === 0) delete this.fs.inodedata[w.id];
      this.paths.delete(w.id);
      this.emitChange(this.cpath(path), "delete");
    } finally { this.suppress--; }
  }

  async rename(from: string, to: string): Promise<void> {
    this.guardSkeleton(from, "rename");
    this.guardSkeleton(to, "rename");
    this.suppress++;
    try {
      const src = this.fs.SearchPath(this.ws(from));
      if (src.id === -1) throw new ErrnoError("ENOENT", { path: from, syscall: "rename" });
      const dst = this.fs.SearchPath(this.ws(to));
      const ret = await this.fs.Rename(src.parentid, this.base(from), dst.parentid, this.base(to));
      if (ret < 0) throw new ErrnoError("ENOENT", { path: to, syscall: "rename" });
      this.rebuildIndex();
      this.emitChange(this.cpath(from), "delete");
      this.emitChange(this.cpath(to), "create");
    } finally { this.suppress--; }
  }

  symlink(target: string, linkPath: string): void {
    this.suppress++;
    try {
      const w = this.fs.SearchPath(this.ws(linkPath));
      if (w.id !== -1) throw new ErrnoError("EEXIST", { path: linkPath, syscall: "symlink" });
      const id = this.fs.CreateSymlink(this.base(linkPath), w.parentid, target);
      this.paths.set(id, this.ws(linkPath));
    } finally { this.suppress--; }
    this.emitChange(this.cpath(linkPath), "create");
  }

  chmod(path: string, mode: number): void {
    const w = this.fs.SearchPath(this.ws(path));
    if (w.id === -1) throw new ErrnoError("ENOENT", { path, syscall: "chmod" });
    const inode = this.fs.GetInode(w.id);
    inode.mode = (inode.mode & ~0o7777) | (mode & 0o7777);
    inode.qid.version++;
    this.emitChange(this.cpath(path), "modify");
  }

  async stat(path: string): Promise<Stat> {
    const w = this.fs.SearchPath(this.ws(path));
    if (w.id === -1) throw new ErrnoError("ENOENT", { path, syscall: "stat" });
    const inode = this.fs.GetInode(w.id);
    const m = inode.mode & S_IFMT;
    return {
      type: m === S_IFDIR ? "directory" : m === S_IFLNK ? "symlink" : "file",
      size: inode.size, mode: inode.mode & 0o7777,
      mtimeMs: inode.mtime * 1000, ctimeMs: inode.mtime * 1000, birthtimeMs: inode.mtime * 1000,
    };
  }
}
