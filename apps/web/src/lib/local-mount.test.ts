import { describe, it, expect } from "vitest";
import { Vfs } from "@erdou/runtime-browser";
import { loadFolderIntoVfs, saveVfsToFolder, rescanFolder, type MountMtimes } from "./local-mount.js";
import { MockDir, MockFile } from "./test-support/mock-dir.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

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

  it("skips .git, node_modules and .erdou on load", async () => {
    const root = new MockDir("project");
    root.children.set("a.txt", new MockFile(enc.encode("x")));
    root.children.set(".git", new MockDir(".git"));
    root.children.set("node_modules", new MockDir("node_modules"));
    root.children.set(".erdou", new MockDir(".erdou"));
    const fs = new Vfs({ clock: () => 0 });
    await loadFolderIntoVfs(root, fs, "/");
    expect(fs.exists("/a.txt")).toBe(true);
    expect(fs.exists("/.git")).toBe(false);
    expect(fs.exists("/node_modules")).toBe(false);
    expect(fs.exists("/.erdou")).toBe(false);
  });

  it("rescanFolder pulls a file whose disk mtime changed", async () => {
    const fs = new Vfs({ clock: () => 0 });
    const mtimes: MountMtimes = new Map();
    const root = new MockDir("project");
    root.children.set("a.txt", new MockFile(enc.encode("v1"), 1000));
    await loadFolderIntoVfs(root, fs, "/", mtimes);
    expect(fs.readFileText("/a.txt")).toBe("v1");

    // simulate an external edit: same handle, newer content + mtime
    root.children.set("a.txt", new MockFile(enc.encode("v2"), 2000));
    const pulled = await rescanFolder(root, fs, mtimes, "/");
    expect(pulled).toContain("/a.txt");
    expect(fs.readFileText("/a.txt")).toBe("v2");
  });

  it("rescanFolder does not re-pull a file the browser just wrote back", async () => {
    const fs = new Vfs({ clock: () => 0 });
    const mtimes: MountMtimes = new Map();
    const root = new MockDir("project");
    root.children.set("a.txt", new MockFile(enc.encode("v1"), 1000));
    await loadFolderIntoVfs(root, fs, "/", mtimes);
    fs.writeFile("/a.txt", "local-edit");
    await saveVfsToFolder(fs, root, "/", mtimes); // records the written mtime
    const pulled = await rescanFolder(root, fs, mtimes, "/");
    expect(pulled).toEqual([]); // our own write is not seen as external
  });
});
