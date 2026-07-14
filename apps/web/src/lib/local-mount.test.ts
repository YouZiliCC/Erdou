import { describe, it, expect } from "vitest";
import { Vfs } from "@erdou/runtime-browser";
import { loadFolderIntoVfs, saveVfsToFolder, type DirHandleLike, type FileHandleLike } from "./local-mount.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

class MockFile implements FileHandleLike {
  kind = "file" as const;
  constructor(public data: Uint8Array) {}
  async getFile() {
    const d = this.data;
    return { arrayBuffer: async () => d.slice().buffer };
  }
  async createWritable() {
    const self = this;
    return {
      async write(d: BufferSource) {
        self.data = new Uint8Array(d as Uint8Array);
      },
      async close() {},
    };
  }
}

class MockDir implements DirHandleLike {
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
}

describe("local folder mount", () => {
  it("loads a folder into the VFS, then syncs changes back to disk", async () => {
    const root = new MockDir("project");
    root.children.set("README.md", new MockFile(enc.encode("# Hi")));
    const src = new MockDir("src");
    src.children.set("main.ts", new MockFile(enc.encode("console.log(1)")));
    root.children.set("src", src);

    const fs = new Vfs({ clock: () => 0 });
    const count = await loadFolderIntoVfs(root, fs, "/");
    expect(count).toBe(2);
    expect(fs.readFileText("/README.md")).toBe("# Hi");
    expect(fs.readFileText("/src/main.ts")).toBe("console.log(1)");

    // The agent changes a file and adds a new one...
    fs.writeFile("/README.md", "# Changed");
    fs.writeFile("/src/new.ts", "export const x = 1;");
    await saveVfsToFolder(fs, root, "/");

    // ...and it lands back in the (mock) local folder.
    expect(dec.decode((root.children.get("README.md") as MockFile).data)).toBe("# Changed");
    const savedSrc = root.children.get("src") as MockDir;
    expect(dec.decode((savedSrc.children.get("new.ts") as MockFile).data)).toBe("export const x = 1;");
  });

  it("skips .git and node_modules on load", async () => {
    const root = new MockDir("project");
    root.children.set("a.txt", new MockFile(enc.encode("x")));
    root.children.set(".git", new MockDir(".git"));
    root.children.set("node_modules", new MockDir("node_modules"));
    const fs = new Vfs({ clock: () => 0 });
    await loadFolderIntoVfs(root, fs, "/");
    expect(fs.exists("/a.txt")).toBe(true);
    expect(fs.exists("/.git")).toBe(false);
    expect(fs.exists("/node_modules")).toBe(false);
  });
});
