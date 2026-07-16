import { describe, it, expect } from "vitest";
import type { RuntimeEvent } from "@erdou/runtime-contract";
import { SyncFs9pFs } from "./sync-fs.js";
import { WORKSPACE } from "./fs-bridge.js";
import { makeFakeFs9p, bootWorkspace } from "./test-support/fake-fs9p.js";

describe("SyncFs9pFs", () => {
  it("sync writeFile then sync readFile returns the bytes (clamped to inode.size)", () => {
    const fs9p = makeFakeFs9p(); bootWorkspace(fs9p);
    const events: RuntimeEvent[] = [];
    const sf = new SyncFs9pFs(fs9p, (e) => events.push(e));
    sf.writeFile("/a.txt", "hello");
    expect(new TextDecoder().decode(sf.readFile("/a.txt"))).toBe("hello");
    expect(events).toContainEqual({ type: "file.changed", path: "/a.txt", kind: "create" });
    sf.writeFile("/a.txt", "hi");
    expect(new TextDecoder().decode(sf.readFile("/a.txt"))).toBe("hi");
    expect(events.filter((e) => e.type === "file.changed").at(-1)).toMatchObject({ path: "/a.txt", kind: "modify" });
  });

  it("mkdir + nested writeFile + readdir; rm removes; exists correct", () => {
    const fs9p = makeFakeFs9p(); bootWorkspace(fs9p);
    const sf = new SyncFs9pFs(fs9p, () => {});
    sf.mkdir("/d", { recursive: true });
    sf.writeFile("/d/x.txt", "1");
    expect(sf.readdir("/d").map((e) => e.name)).toEqual(["x.txt"]);
    expect(sf.exists("/d/x.txt")).toBe(true);
    const id = fs9p.SearchPath("workspace/d/x.txt").id; // capture BEFORE rm (SearchPath returns -1 after)
    sf.rm("/d/x.txt", {});
    expect(sf.exists("/d/x.txt")).toBe(false);
    expect(fs9p.inodedata).not.toHaveProperty(String(id)); // inodedata freed
  });

  it("readFile clamps to inode.size when fs9p.Write over-allocates (3/2×)", async () => {
    const fs9p = makeFakeFs9p(); bootWorkspace(fs9p);
    const sf = new SyncFs9pFs(fs9p, () => {});
    // drive a GUEST-style write through fs9p.Write (which over-allocates inodedata to 3/2×size)
    const id = fs9p.CreateFile("g.txt", fs9p.SearchPath(WORKSPACE).id);
    await fs9p.Write(id, 0, 4, new TextEncoder().encode("data"));
    expect(sf.readFile("/g.txt").length).toBe(4);                 // clamped to inode.size, not the padded tail
    expect(new TextDecoder().decode(sf.readFile("/g.txt"))).toBe("data");
  });

  it("readFile of a missing path throws ENOENT; readFile of an empty file returns 0 bytes", () => {
    const fs9p = makeFakeFs9p(); bootWorkspace(fs9p);
    const sf = new SyncFs9pFs(fs9p, () => {});
    expect(() => sf.readFile("/nope")).toThrow(/ENOENT/);
    // create with no data (mode-only) — inode exists, size 0, no inodedata
    fs9p.CreateFile("empty.txt", fs9p.SearchPath(WORKSPACE).id);
    expect(sf.readFile("/empty.txt").length).toBe(0);
  });

  it("rejects a page write under a skeleton dir with EACCES", () => {
    const fs9p = makeFakeFs9p(); bootWorkspace(fs9p);
    const sf = new SyncFs9pFs(fs9p, () => {});
    expect(() => sf.writeFile("/bin/x", "no")).toThrow(/EACCES/);
    expect(() => sf.mkdir("/tmp/y", { recursive: true })).toThrow(/EACCES/);
  });
});
