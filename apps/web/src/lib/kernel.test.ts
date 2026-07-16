import { describe, it, expect } from "vitest";
import { createBrowserKernel } from "./kernel.js";

describe("createBrowserKernel", () => {
  it("wires a browser runtime with languages provisioned and a working sync fs", async () => {
    const kernel = createBrowserKernel();
    expect(kernel.kind).toBe("browser");
    await kernel.runtime.boot();
    const caps = await kernel.runtime.getCapabilities();
    for (const name of ["python", "python3", "wasi", "git"]) {
      expect(caps.interpreters).toContain(name);
    }
    kernel.fs.writeFile("/k.txt", "via-kernel");
    expect(new TextDecoder().decode(await kernel.runtime.readFile("/k.txt"))).toBe("via-kernel");
  });

  it("opens a persistent shell session (cwd survives commands)", async () => {
    const kernel = createBrowserKernel();
    await kernel.runtime.boot();
    const shell = kernel.openShell();
    await kernel.runtime.mkdir("/proj", { recursive: true });
    await shell.exec("cd /proj");
    expect(shell.cwd).toBe("/proj");
    const r = await shell.exec("pwd");
    expect(r.stdout.trim()).toBe("/proj");
  });
});
