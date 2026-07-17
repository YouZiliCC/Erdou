import { describe, it, expect } from "vitest";
import { Vfs } from "@erdou/runtime-browser";
import { pullDiskToWorkspace, pushWorkspaceToDisk, reselectFolder } from "./folder-sync-controls.js";
import { VM_PRESERVE_DIRS } from "./kernel.js";
import { MockDir, MockFile } from "./test-support/mock-dir.js";
import type { DirHandleLike } from "./local-mount.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("folder sync controls", () => {
  it("pullDiskToWorkspace applies every disk file into the VFS (disk wins)", async () => {
    const root = new MockDir("project");
    root.children.set("README.md", new MockFile(enc.encode("# disk")));
    const src = new MockDir("src");
    src.children.set("main.ts", new MockFile(enc.encode("console.log(1)")));
    root.children.set("src", src);

    const fs = new Vfs({ clock: () => 0 });
    // A stale workspace value must be overwritten by the manual pull.
    fs.mkdir("/", { recursive: true });
    fs.writeFile("/README.md", "# stale workspace");

    const count = await pullDiskToWorkspace(root, fs);
    expect(count).toBe(2);
    expect(fs.readFileText("/README.md")).toBe("# disk");
    expect(fs.readFileText("/src/main.ts")).toBe("console.log(1)");
  });

  it("pushWorkspaceToDisk writes VFS files to the mock handle and SKIPS VM_PRESERVE_DIRS at root on the VM kernel", async () => {
    const fs = new Vfs({ clock: () => 0 });
    fs.mkdir("/etc", { recursive: true });
    fs.writeFile("/etc/pip.conf", "baked"); // image-owned, VM kernel
    fs.mkdir("/root", { recursive: true });
    fs.writeFile("/root/.npmrc", "baked"); // image-owned, VM kernel
    fs.mkdir("/bin", { recursive: true });
    fs.writeFile("/bin/stub", "skeleton"); // skeleton stub dir
    fs.writeFile("/app.py", "print(1)"); // real user file
    fs.mkdir("/src/bin", { recursive: true });
    fs.writeFile("/src/bin/keep.ts", "nested bin is a real project dir");

    const root = new MockDir("project");
    await pushWorkspaceToDisk(root, fs, undefined, new Set(VM_PRESERVE_DIRS));

    expect(root.children.has("etc")).toBe(false); // baked config not on disk
    expect(root.children.has("root")).toBe(false);
    expect(root.children.has("bin")).toBe(false); // root skeleton stub skipped
    expect(root.children.has("app.py")).toBe(true); // real user file synced

    const savedSrc = root.children.get("src") as MockDir;
    const nestedBin = savedSrc.children.get("bin") as MockDir; // nested bin is real
    expect(dec.decode((nestedBin.children.get("keep.ts") as MockFile).data)).toBe(
      "nested bin is a real project dir",
    );
  });

  it("reselectFolder picks a DIFFERENT folder and swaps the handle in via mount", async () => {
    const next = new MockDir("new-folder");
    let mounted: DirHandleLike | null = null;
    const result = await reselectFolder(
      async () => next,
      async (h) => {
        mounted = h;
      },
    );
    expect(result).toBe(next);
    expect(mounted).toBe(next);
    expect((mounted as unknown as MockDir).name).toBe("new-folder");
  });

  it("reselectFolder returns null and does not mount when the user cancels the picker", async () => {
    let mountCalled = false;
    const result = await reselectFolder(
      async () => {
        throw new DOMException("cancelled", "AbortError");
      },
      async () => {
        mountCalled = true;
      },
    );
    expect(result).toBeNull();
    expect(mountCalled).toBe(false);
  });
});
