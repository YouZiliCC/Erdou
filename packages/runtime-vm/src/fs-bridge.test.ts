import { describe, it, expect, vi } from "vitest";
import type { RuntimeEvent } from "@erdou/runtime-contract";
import { Fs9pBridge, WORKSPACE, type Fs9p } from "./fs-bridge.js";

/** A JS-map-backed fake of the v86 FS surface the bridge uses. Inodes are
 *  {mode,size,direntries?,symlink?,mtime,qid}; dirs hold a name→idx map. */
function makeFakeFs9p(): Fs9p & { root: number } {
  const inodes: any[] = [];
  const data: (Uint8Array | undefined)[] = [];
  const mkInode = (mode: number): number => {
    inodes.push({ mode, size: 0, direntries: (mode & 0o170000) === 0o040000 ? new Map() : undefined, mtime: 0, qid: { version: 0 } });
    data.push(undefined);
    return inodes.length - 1;
  };
  const root = mkInode(0o040755); // idx 0 = export root
  const fs: any = {
    inodes,
    GetInode: (i: number) => inodes[i],
    CreateDirectory(name: string, parent: number) { const i = mkInode(0o040755); inodes[parent].direntries.set(name, i); return i; },
    CreateFile(name: string, parent: number) { const i = mkInode(0o100644); inodes[parent].direntries.set(name, i); return i; },
    CreateSymlink(name: string, parent: number, target: string) { const i = mkInode(0o120777); inodes[i].symlink = target; inodes[parent].direntries.set(name, i); return i; },
    async CreateBinaryFile(name: string, parent: number, buf: Uint8Array) { const i = this.CreateFile(name, parent); data[i] = new Uint8Array(buf); inodes[i].size = buf.length; return i; },
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
      return { id, parentid, name: parts[parts.length - 1] ?? "" };
    },
    GetFullPath(_i: number) { return ""; }, // dir-only in v86; the bridge maintains its own map
    async Write(i: number, offset: number, count: number, buf: Uint8Array) {
      const cur = data[i] ?? new Uint8Array(0);
      const need = offset + count;
      const out = new Uint8Array(Math.max(cur.length, need));
      out.set(cur, 0); out.set(buf.subarray(0, count), offset);
      data[i] = out; inodes[i].size = out.length;
    },
    async ChangeSize(i: number, size: number) { const cur = data[i] ?? new Uint8Array(0); const out = new Uint8Array(size); out.set(cur.subarray(0, size), 0); data[i] = out; inodes[i].size = size; },
    Unlink(parent: number, name: string) { const d = inodes[parent].direntries; if (!d.has(name)) return -1; d.delete(name); return 0; },
    async Rename(od: number, on: string, nd: number, nn: string) { const s = inodes[od].direntries; if (!s.has(on)) return -1; const idx = s.get(on); s.delete(on); inodes[nd].direntries.set(nn, idx); return 0; },
    async read_file(path: string) { const w = this.SearchPath(path); return w.id === -1 ? null : (data[w.id] ?? new Uint8Array(0)); },
    root,
  };
  return fs;
}

function bootWorkspace(fs: any): void {
  const ws = fs.CreateDirectory(WORKSPACE, 0);
  // skeleton dirs, page-side (no wrappers yet)
  for (const d of ["bin", "lib", "usr", "proc", "dev", "tmp"]) fs.CreateDirectory(d, ws);
}

describe("Fs9pBridge", () => {
  it("page-side writeFile emits one synchronous create and reads back", async () => {
    const fs = makeFakeFs9p(); bootWorkspace(fs);
    const events: RuntimeEvent[] = [];
    const bridge = new Fs9pBridge(fs, (e) => events.push(e));
    bridge.attach();
    await bridge.writeFile("/hello.txt", "hi");
    expect(new TextDecoder().decode(await bridge.readFile("/hello.txt"))).toBe("hi");
    // The contract requires the event (conformance's file.changed test drives
    // page-side writes); it must land synchronously, not via the coalesce timer.
    const changes = events.filter((e) => e.type === "file.changed");
    expect(changes).toEqual([{ type: "file.changed", path: "/hello.txt", kind: "create" }]);
    await bridge.writeFile("/hello.txt", "bye");
    expect(events.filter((e) => e.type === "file.changed").at(-1)).toMatchObject({ path: "/hello.txt", kind: "modify" });
  });

  it("a guest write (through the wrapped fs9p) emits a coalesced file.changed with the contract path", async () => {
    vi.useFakeTimers();
    const fs = makeFakeFs9p(); bootWorkspace(fs);
    const events: RuntimeEvent[] = [];
    const bridge = new Fs9pBridge(fs, (e) => events.push(e), { coalesceMs: 5 });
    bridge.attach();
    const wsId = fs.SearchPath("workspace").id;
    // simulate the guest: create + two chunked writes to workspace/out.txt
    const id = fs.CreateFile("out.txt", wsId);
    await fs.Write(id, 0, 3, new TextEncoder().encode("abc"));
    await fs.Write(id, 3, 3, new TextEncoder().encode("def"));
    vi.advanceTimersByTime(6);
    const changes = events.filter((e) => e.type === "file.changed");
    expect(changes).toHaveLength(1); // coalesced, not 3
    expect(changes[0]).toMatchObject({ type: "file.changed", path: "/out.txt", kind: "create" });
    vi.useRealTimers();
  });

  it("readFile of a missing path rejects ENOENT; mkdir + readdir round-trips", async () => {
    const fs = makeFakeFs9p(); bootWorkspace(fs);
    const bridge = new Fs9pBridge(fs, () => {});
    bridge.attach();
    await expect(bridge.readFile("/nope")).rejects.toThrow(/ENOENT/);
    await bridge.mkdir("/d", { recursive: true });
    await bridge.writeFile("/d/x", "1");
    expect((await bridge.readdir("/d")).map((e) => e.name)).toEqual(["x"]);
  });

  it("writeFile into a missing intermediate directory throws ENOENT (does not silently create)", async () => {
    const fs = makeFakeFs9p(); bootWorkspace(fs);
    const bridge = new Fs9pBridge(fs, () => {}); bridge.attach();
    await expect(bridge.writeFile("/missing-dir/file.txt", "x")).rejects.toThrow(/ENOENT/);
    // and the bogus "missing-dir" file was NOT created
    await expect(bridge.readFile("/missing-dir")).rejects.toThrow(/ENOENT/);
  });

  it("rename moves a workspace file's content", async () => {
    const fs = makeFakeFs9p(); bootWorkspace(fs);
    const bridge = new Fs9pBridge(fs, () => {}); bridge.attach();
    await bridge.writeFile("/from.txt", "data");
    await bridge.rename("/from.txt", "/to.txt");
    expect(new TextDecoder().decode(await bridge.readFile("/to.txt"))).toBe("data");
    await expect(bridge.readFile("/from.txt")).rejects.toThrow(/ENOENT/);
  });

  it("stat reports type and rejects a missing path", async () => {
    const fs = makeFakeFs9p(); bootWorkspace(fs);
    const bridge = new Fs9pBridge(fs, () => {}); bridge.attach();
    await bridge.writeFile("/f.txt", "hi");
    expect((await bridge.stat("/f.txt")).type).toBe("file");
    await bridge.mkdir("/d", { recursive: true });
    expect((await bridge.stat("/d")).type).toBe("directory");
    await expect(bridge.stat("/nope")).rejects.toThrow(/ENOENT/);
  });
});
