import { describe, it, expect } from "vitest";
import { BrowserRuntime } from "../browser-runtime.js";

describe("ShellSession", () => {
  it("persists cwd across exec calls", async () => {
    const rt = new BrowserRuntime();
    await rt.boot();
    const sh = rt.openShell();
    await sh.exec("mkdir /a");
    await sh.exec("cd /a");
    expect(sh.cwd).toBe("/a");
    const r = await sh.exec("pwd");
    expect(r.stdout.trim()).toBe("/a");
    expect(r.code).toBe(0);
  });

  it("persists env across exec calls", async () => {
    const rt = new BrowserRuntime();
    await rt.boot();
    const sh = rt.openShell();
    await sh.exec("export X=hi");
    const r = await sh.exec("echo $X");
    expect(r.stdout.trim()).toBe("hi");
  });

  it("reports non-zero exit codes and stderr", async () => {
    const rt = new BrowserRuntime();
    await rt.boot();
    const sh = rt.openShell();
    const r = await sh.exec("cat /nope.txt");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/ENOENT/);
  });
});
