import { describe, it, expect, vi } from "vitest";
import type { RuntimeEvent } from "@erdou/runtime-contract";
import { Fs9pBridge } from "./fs-bridge.js";
import { makeFakeFs9p, bootWorkspace } from "./test-support/fake-fs9p.js";

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

  it("rejects page writes under a skeleton dir with EACCES", async () => {
    const fs = makeFakeFs9p(); bootWorkspace(fs);
    const bridge = new Fs9pBridge(fs, () => {}); bridge.attach();
    await expect(bridge.writeFile("/usr/x", "no")).rejects.toThrow(/EACCES/);
    await expect(bridge.mkdir("/tmp/y", { recursive: true })).rejects.toThrow(/EACCES/);
  });

  it("collapses '.' and '..' so a contract path cannot escape the workspace", async () => {
    const fs = makeFakeFs9p(); bootWorkspace(fs);
    // an image-owned /etc OUTSIDE workspace/ — the guest's real root, not in the
    // workspace snapshot, folder-sync or .zip export.
    const etc = fs.CreateDirectory("etc", 0);
    await fs.CreateBinaryFile("passwd", etc, new TextEncoder().encode("root:x:0:0"));
    const bridge = new Fs9pBridge(fs, () => {}); bridge.attach();
    // The escape route is real: v86 puts a ".." direntry on every directory, so an
    // un-normalized "workspace/../etc/passwd" resolves straight out of the workspace.
    expect(fs.SearchPath("workspace/../etc/passwd").id).not.toBe(-1);

    await expect(bridge.readFile("/../etc/passwd")).rejects.toThrow(/ENOENT/);
    await expect(bridge.writeFile("/../etc/passwd", "pwned")).rejects.toThrow(/ENOENT/);
    await expect(bridge.rm("/../etc", { recursive: true })).rejects.toThrow(/ENOENT/);
    await expect(bridge.rename("/../etc/passwd", "/stolen")).rejects.toThrow(/ENOENT/);
    // guest /etc untouched
    expect(fs.Search(0, "etc")).toBe(etc);
    expect(new TextDecoder().decode((await fs.read_file("etc/passwd"))!)).toBe("root:x:0:0");

    // "." must not hide the first segment from the skeleton guard either
    await expect(bridge.writeFile("/./bin/sh", "x")).rejects.toThrow(/EACCES/);
    await expect(bridge.rm("/tmp/../usr/lib", { recursive: true })).rejects.toThrow(/EACCES/);
  });

  it("normalizes '.'/'..' inside the workspace instead of rejecting them", async () => {
    const fs = makeFakeFs9p(); bootWorkspace(fs);
    const events: RuntimeEvent[] = [];
    const bridge = new Fs9pBridge(fs, (e) => events.push(e)); bridge.attach();
    await bridge.mkdir("/a/b", { recursive: true });
    await bridge.writeFile("/a/b/../c.txt", "in-workspace");
    expect(new TextDecoder().decode(await bridge.readFile("/a/c.txt"))).toBe("in-workspace");
    // the emitted event carries the normalized contract path, not the literal one
    expect(events.filter((e) => e.type === "file.changed").at(-1)).toMatchObject({ path: "/a/c.txt", kind: "create" });
  });

  it("rm frees the inode bytes (v86's Unlink only drops the direntry)", async () => {
    const fs = makeFakeFs9p(); bootWorkspace(fs);
    const bridge = new Fs9pBridge(fs, () => {}); bridge.attach();
    await bridge.writeFile("/big.bin", "x".repeat(4096));
    const id = fs.SearchPath("workspace/big.bin").id;
    expect(fs.inodedata[id]).toBeDefined();
    await bridge.rm("/big.bin");
    // Without this, every write→delete cycle (and every restoreSnapshot, which
    // rm's each top-level entry) retains its bytes for the whole session and
    // still serialises them into FS.get_state.
    expect(fs.inodedata[id]).toBeUndefined();
  });

  it("recursive rm frees the bytes of every file it removes", async () => {
    const fs = makeFakeFs9p(); bootWorkspace(fs);
    const bridge = new Fs9pBridge(fs, () => {}); bridge.attach();
    await bridge.mkdir("/d/sub", { recursive: true });
    await bridge.writeFile("/d/a.txt", "aaa");
    await bridge.writeFile("/d/sub/b.txt", "bbb");
    const ids = [fs.SearchPath("workspace/d/a.txt").id, fs.SearchPath("workspace/d/sub/b.txt").id];
    await bridge.rm("/d", { recursive: true });
    for (const id of ids) expect(fs.inodedata[id]).toBeUndefined();
  });

  it("readFile of an empty (never-written) file returns 0 bytes, not ENOENT", async () => {
    const fs = makeFakeFs9p(); bootWorkspace(fs);
    const bridge = new Fs9pBridge(fs, () => {}); bridge.attach();
    fs.CreateFile("empty.txt", fs.SearchPath("workspace").id); // inode, no inodedata, size 0
    expect((await bridge.readFile("/empty.txt")).length).toBe(0);
  });
});
