import { WORKSPACE, type Fs9p } from "../fs-bridge.js";

/** A JS-map-backed fake of the v86 FS surface the bridge uses. Inodes are
 *  {mode,size,direntries?,symlink?,mtime,qid}; dirs hold a name→idx map.
 *  `inodedata` is the ONE store for file bytes (real v86 has this field too) —
 *  both the guest-path methods (CreateBinaryFile/Write/ChangeSize) and the
 *  sync reader (SyncFs9pFs) read/write it directly; no separate mirror.
 *  Shared by fs-bridge.test.ts and workspace-snapshot.test.ts. */
export function makeFakeFs9p(): Fs9p & { root: number } {
  const inodes: any[] = [];
  const inodedata: Record<number, Uint8Array | undefined> = {};
  const mkInode = (mode: number): number => {
    inodes.push({ mode, size: 0, direntries: (mode & 0o170000) === 0o040000 ? new Map() : undefined, mtime: 0, qid: { version: 0 } });
    return inodes.length - 1;
  };
  const root = mkInode(0o040755); // idx 0 = export root
  const fs: any = {
    inodes,
    inodedata,
    GetInode: (i: number) => inodes[i],
    CreateDirectory(name: string, parent: number) { const i = mkInode(0o040755); inodes[parent].direntries.set(name, i); return i; },
    CreateFile(name: string, parent: number) { const i = mkInode(0o100644); inodes[parent].direntries.set(name, i); return i; },
    CreateSymlink(name: string, parent: number, target: string) { const i = mkInode(0o120777); inodes[i].symlink = target; inodes[parent].direntries.set(name, i); return i; },
    async CreateBinaryFile(name: string, parent: number, buf: Uint8Array) { const i = this.CreateFile(name, parent); inodedata[i] = new Uint8Array(buf); inodes[i].size = buf.length; return i; },
    Search(parent: number, name: string) { const d = inodes[parent].direntries; return d && d.has(name) ? d.get(name) : -1; },
    SearchPath(path: string) {
      const parts = path.split("/").filter(Boolean);
      let id = 0, parentid = 0;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i]!;
        const nx = this.Search(id, p);
        if (nx === -1) {
          // real v86: interior segment missing → parentid -1; leaf missing → real parent id
          const isLeaf = i === parts.length - 1;
          return { id: -1, parentid: isLeaf ? id : -1, name: p };
        }
        parentid = id; // parent of the segment just resolved
        id = nx;
      }
      // real v86 only sets `name` when the leaf is missing; existing paths leave it undefined
      return { id, parentid, name: undefined };
    },
    GetFullPath(_i: number) { return ""; }, // dir-only in v86; the bridge maintains its own map
    async Write(i: number, offset: number, count: number, buf: Uint8Array) {
      const cur = inodedata[i] ?? new Uint8Array(0);
      const need = offset + count;
      const alloc = Math.floor((3 * need) / 2);
      const out = new Uint8Array(Math.max(cur.length, alloc));
      out.set(cur, 0); out.set(buf.subarray(0, count), offset);
      inodedata[i] = out; inodes[i].size = need;
    },
    async ChangeSize(i: number, size: number) { const cur = inodedata[i] ?? new Uint8Array(0); const out = new Uint8Array(size); out.set(cur.subarray(0, size), 0); inodedata[i] = out; inodes[i].size = size; },
    Unlink(parent: number, name: string) { const d = inodes[parent].direntries; if (!d.has(name)) return -1; d.delete(name); return 0; },
    async Rename(od: number, on: string, nd: number, nn: string) { const s = inodes[od].direntries; if (!s.has(on)) return -1; const idx = s.get(on); s.delete(on); inodes[nd].direntries.set(nn, idx); return 0; },
    async read_file(path: string) { const w = this.SearchPath(path); if (w.id === -1) return null; const d = inodedata[w.id]; return d ? d.slice(0, inodes[w.id].size) : null; },
    root,
  };
  return fs;
}

export function bootWorkspace(fs: any): void {
  const ws = fs.CreateDirectory(WORKSPACE, 0);
  // skeleton dirs, page-side (no wrappers yet)
  for (const d of ["bin", "lib", "usr", "proc", "dev", "tmp"]) fs.CreateDirectory(d, ws);
}
