import { describe, it, expect } from "vitest";
import { Vfs } from "@erdou/runtime-browser";
import { loadFolderIntoVfs, saveVfsToFolder, rescanFolder, type MountMtimes } from "./local-mount.js";
import { VM_PRESERVE_DIRS } from "./kernel.js";
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

  it("saveVfsToFolder skips rootSkip entries only at the root — a same-named nested dir is a real project dir and is written", async () => {
    // Final-review Fix 2: the VM kernel's readdir("/") exposes its skeleton
    // bind-mount stub dirs (bin/lib/usr/proc/dev/tmp) alongside real project
    // files. `rootSkip` lets a folder save omit them, but ONLY at the
    // workspace root — a project that happens to have its own `/src/bin/`
    // must still sync normally.
    const fs = new Vfs({ clock: () => 0 });
    fs.mkdir("/bin", { recursive: true });
    fs.writeFile("/bin/skip-me.txt", "should not reach disk");
    fs.mkdir("/src/bin", { recursive: true });
    fs.writeFile("/src/bin/keep-me.txt", "nested bin is a real project dir");
    fs.writeFile("/src/index.ts", "export {}");

    const root = new MockDir("project");
    await saveVfsToFolder(fs, root, "/", undefined, new Set(["bin"]));

    expect(root.children.has("bin")).toBe(false); // top-level "bin" was skipped

    const src = root.children.get("src") as MockDir;
    expect(src).toBeDefined();
    expect(src.children.has("index.ts")).toBe(true); // src/ itself was written

    const nestedBin = src.children.get("bin") as MockDir;
    expect(nestedBin).toBeDefined(); // src/bin/ was written (not root-level)
    expect(dec.decode((nestedBin.children.get("keep-me.txt") as MockFile).data)).toBe(
      "nested bin is a real project dir",
    );
  });

  it("saveVfsToFolder with VM_PRESERVE_DIRS keeps the VM-baked /etc,/root config off the user's real folder", async () => {
    // Round 13 (R12.5 IMP2 class): a VM carries baked /etc/pip.conf +
    // /root/.npmrc IN its 9p workspace root. When a VM has a real folder
    // mounted, the folder save must NOT dump those image-owned config dirs
    // onto the user's disk — studio passes VM_PRESERVE_DIRS (skeleton + etc +
    // root) as `rootSkip` for the VM kernel, not the bare SKELETON_DIRS.
    const fs = new Vfs({ clock: () => 0 });
    fs.mkdir("/etc", { recursive: true });
    fs.writeFile("/etc/pip.conf", "baked");
    fs.mkdir("/root", { recursive: true });
    fs.writeFile("/root/.npmrc", "baked");
    fs.writeFile("/app.py", "print(1)"); // real user file

    const root = new MockDir("project");
    await saveVfsToFolder(fs, root, "/", undefined, new Set(VM_PRESERVE_DIRS));

    expect(root.children.has("etc")).toBe(false); // baked config not written to disk
    expect(root.children.has("root")).toBe(false);
    expect(root.children.has("app.py")).toBe(true); // real user file still synced
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
