import { describe, it, expect } from "vitest";
import { snapshotWorkspace, restoreWorkspace } from "./workspace-snapshot.js";
import { Fs9pBridge, WORKSPACE } from "./fs-bridge.js";
// reuse the fake from fs-bridge.test via a tiny local copy of makeFakeFs9p + bootWorkspace:
import { makeFakeFs9p, bootWorkspace } from "./test-support/fake-fs9p.js";

describe("workspace snapshot", () => {
  it("captures only the user files (not skeleton dirs), restores exactly", async () => {
    const fs = makeFakeFs9p(); bootWorkspace(fs);
    const bridge = new Fs9pBridge(fs, () => {}); bridge.attach();
    await bridge.mkdir("/sub", { recursive: true });
    await bridge.writeFile("/a.txt", "one");
    await bridge.writeFile("/sub/b.txt", "two");

    const snap = await snapshotWorkspace(fs, () => 0);
    // skeleton dirs (bin/lib/usr/proc/dev/tmp) excluded; only a.txt + sub/b.txt
    const top = snap.fs.type === "directory" ? Object.keys(snap.fs.children) : [];
    expect(top.sort()).toEqual(["a.txt", "sub"]);

    // mutate then restore
    await bridge.writeFile("/a.txt", "changed");
    await bridge.writeFile("/added.txt", "new");
    await restoreWorkspace(fs, bridge, snap);
    expect(new TextDecoder().decode(await bridge.readFile("/a.txt"))).toBe("one");
    await expect(bridge.readFile("/added.txt")).rejects.toThrow(/ENOENT/);
    expect(new TextDecoder().decode(await bridge.readFile("/sub/b.txt"))).toBe("two");
  });

  it("threads each file's path through the DFS instead of a per-file full-tree re-walk", async () => {
    const fs = makeFakeFs9p(); bootWorkspace(fs);
    const bridge = new Fs9pBridge(fs, () => {}); bridge.attach();
    await bridge.mkdir("/sub", { recursive: true });
    await bridge.writeFile("/a.txt", "one");
    await bridge.writeFile("/sub/b.txt", "two");
    await bridge.writeFile("/sub/c.txt", "three");

    // Snapshot runs on the 400ms-debounced save path; recomputing each file's
    // path with a fresh DFS from the workspace root made a save O(n^2).
    let searches = 0;
    const realSearchPath = fs.SearchPath.bind(fs);
    fs.SearchPath = (p: string) => { searches++; return realSearchPath(p); };
    const snap = await snapshotWorkspace(fs, () => 0);
    expect(searches).toBe(1 + 3); // the root lookup + one read_file resolve per file — nothing per-file beyond that

    const root = snap.fs.type === "directory" ? snap.fs.children : {};
    const sub = root["sub"]?.type === "directory" ? root["sub"].children : {};
    expect(root["a.txt"]).toMatchObject({ type: "file", data: btoa("one") });
    expect(sub["b.txt"]).toMatchObject({ type: "file", data: btoa("two") });
    expect(sub["c.txt"]).toMatchObject({ type: "file", data: btoa("three") });
  });

  it("restores file modes and symlinks", async () => {
    const fs = makeFakeFs9p(); bootWorkspace(fs);
    const bridge = new Fs9pBridge(fs, () => {}); bridge.attach();
    await bridge.writeFile("/run.sh", "#!/bin/sh\necho hi");
    // mark it executable + add a symlink (via the new bridge methods)
    bridge.chmod("/run.sh", 0o755);
    bridge.symlink("run.sh", "/link.sh");

    const snap = await snapshotWorkspace(fs, () => 0);
    await bridge.rm("/run.sh", { force: true });
    await bridge.rm("/link.sh", { force: true });
    await restoreWorkspace(fs, bridge, snap);

    expect((await bridge.stat("/run.sh")).mode & 0o777).toBe(0o755);
    const link = fs.SearchPath("workspace/link.sh");
    expect(fs.GetInode(link.id).symlink).toBe("run.sh");
  });
});
