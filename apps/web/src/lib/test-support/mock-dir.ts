import type { DirHandleLike, FileHandleLike } from "../local-mount.js";

/** In-memory `DirHandleLike`/`FileHandleLike` test double for the File System
 *  Access API — shared by local-mount.test.ts and folder-state.test.ts.
 *  Not a `*.test.ts` file itself, so vitest never collects it as a suite. */
export class MockFile implements FileHandleLike {
  kind = "file" as const;
  constructor(
    public data: Uint8Array,
    public lastModified = 0,
  ) {}
  async getFile() {
    const d = this.data;
    const lastModified = this.lastModified;
    return { arrayBuffer: async () => d.slice().buffer, lastModified };
  }
  async createWritable() {
    const self = this;
    return {
      async write(d: BufferSource) {
        self.data = new Uint8Array(d as Uint8Array);
        self.lastModified = Date.now();
      },
      async close() {},
    };
  }
}

export class MockDir implements DirHandleLike {
  kind = "directory" as const;
  children = new Map<string, MockFile | MockDir>();
  constructor(public name: string) {}
  async *entries(): AsyncIterableIterator<[string, FileHandleLike | DirHandleLike]> {
    for (const [k, v] of this.children) yield [k, v];
  }
  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandleLike> {
    let d = this.children.get(name);
    if (!d) {
      if (!opts?.create) throw new Error("ENOENT");
      d = new MockDir(name);
      this.children.set(name, d);
    }
    return d as MockDir;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandleLike> {
    let f = this.children.get(name);
    if (!f) {
      if (!opts?.create) throw new Error("ENOENT");
      f = new MockFile(new Uint8Array());
      this.children.set(name, f);
    }
    return f as MockFile;
  }
  async removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void> {
    const e = this.children.get(name);
    if (!e) throw new Error("ENOENT");
    if (e instanceof MockDir && e.children.size > 0 && !opts?.recursive)
      throw new Error("InvalidModificationError: directory not empty");
    this.children.delete(name);
  }
}
