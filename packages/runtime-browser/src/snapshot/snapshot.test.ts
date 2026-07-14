import { describe, it, expect } from "vitest";
import { Vfs } from "../vfs/vfs.js";
import { snapshotVfs, restoreVfs } from "./serialize.js";
import { MemorySnapshotStore } from "./memory-store.js";

describe("snapshot serialize/restore", () => {
  it("round-trips the filesystem exactly", () => {
    const vfs = new Vfs({ clock: () => 1 });
    vfs.mkdir("/a");
    vfs.writeFile("/a/f.txt", "hi");
    vfs.symlink("/a/f.txt", "/link");

    const snap = JSON.parse(JSON.stringify(snapshotVfs(vfs, 1)));

    // Diverge from the snapshot...
    vfs.rm("/a/f.txt");
    vfs.mkdir("/c");
    expect(vfs.exists("/a/f.txt")).toBe(false);

    // ...then restore it.
    restoreVfs(vfs, snap, 2);
    expect(vfs.readFileText("/a/f.txt")).toBe("hi");
    expect(vfs.exists("/c")).toBe(false);
    expect(vfs.readlink("/link")).toBe("/a/f.txt");
  });

  it("MemorySnapshotStore saves, loads, lists and deletes", async () => {
    const vfs = new Vfs({ clock: () => 1 });
    vfs.writeFile("/x", "data");
    const store = new MemorySnapshotStore();
    await store.save("proj", snapshotVfs(vfs, 1));
    expect(await store.list()).toEqual(["proj"]);
    const loaded = await store.load("proj");
    expect(loaded?.fs.type).toBe("directory");
    await store.delete("proj");
    expect(await store.load("proj")).toBeNull();
  });
});
