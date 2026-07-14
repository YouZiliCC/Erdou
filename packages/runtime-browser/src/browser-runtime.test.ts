import { describe, it, expect } from "vitest";
import { BrowserRuntime } from "./browser-runtime.js";
import type { RuntimeEvent } from "@erdou/runtime-contract";

describe("BrowserRuntime", () => {
  it("reads and writes files through the contract", async () => {
    const rt = new BrowserRuntime({ clock: () => 0 });
    await rt.boot();
    await rt.writeFile("/hello.txt", "hi");
    expect(new TextDecoder().decode(await rt.readFile("/hello.txt"))).toBe("hi");
  });

  it("execs a shell pipeline and captures stdout + exit code", async () => {
    const rt = new BrowserRuntime({ clock: () => 0 });
    await rt.boot();
    const p = await rt.exec("echo hi | grep h");
    expect(await p.wait()).toEqual({ code: 0, signal: null });
    expect(await p.stdout.text()).toBe("hi\n");
  });

  it("lists a created directory via ls", async () => {
    const rt = new BrowserRuntime({ clock: () => 0 });
    await rt.boot();
    await rt.mkdir("/proj");
    const p = await rt.exec("ls -a /");
    await p.wait();
    expect(await p.stdout.text()).toContain("proj");
  });

  it("snapshots, mutates and restores", async () => {
    const rt = new BrowserRuntime({ clock: () => 0 });
    await rt.boot();
    await rt.writeFile("/a.txt", "one");
    const snap = await rt.createSnapshot();
    await rt.writeFile("/a.txt", "two");
    await rt.writeFile("/b.txt", "new");
    await rt.restoreSnapshot(snap);
    expect(new TextDecoder().decode(await rt.readFile("/a.txt"))).toBe("one");
    await expect(rt.readFile("/b.txt")).rejects.toThrow(/ENOENT/);
  });

  it("exposes a virtual port and emits port.opened", async () => {
    const rt = new BrowserRuntime({ clock: () => 0 });
    await rt.boot();
    const events: RuntimeEvent[] = [];
    rt.subscribe((e) => events.push(e));
    const url = await rt.exposePort(3000);
    expect(url).toContain("3000");
    expect(events).toContainEqual({ type: "port.opened", port: 3000, url });
  });

  it("reports browser-native capabilities", async () => {
    const caps = await new BrowserRuntime().getCapabilities();
    expect(caps.nativeProcesses).toBe(true);
    expect(caps.virtualPorts).toBe(true);
    expect(caps.nativeAddons).toBe(false);
  });

  it("spawns a program directly and waits on its pid", async () => {
    const rt = new BrowserRuntime({ clock: () => 0 });
    await rt.boot();
    const handle = await rt.spawn({ cmd: "echo", args: ["direct"] });
    expect(await rt.wait(handle.pid)).toEqual({ code: 0, signal: null });
    expect(await handle.stdout.text()).toBe("direct\n");
  });
});
