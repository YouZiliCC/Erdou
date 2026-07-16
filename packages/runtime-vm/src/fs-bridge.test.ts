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

  it("readFile of an empty (never-written) file returns 0 bytes, not ENOENT", async () => {
    const fs = makeFakeFs9p(); bootWorkspace(fs);
    const bridge = new Fs9pBridge(fs, () => {}); bridge.attach();
    fs.CreateFile("empty.txt", fs.SearchPath("workspace").id); // inode, no inodedata, size 0
    expect((await bridge.readFile("/empty.txt")).length).toBe(0);
  });
});
