import { describe, it, expect } from "vitest";
import { type MakeRuntime, booted } from "../types.js";

export function processSuite(make: MakeRuntime): void {
  describe("process", () => {
    it("execs a command with the right exit code and stdout", async () => {
      const rt = await booted(make);
      const p = await rt.exec("echo hello");
      expect(await p.wait()).toEqual({ code: 0, signal: null });
      expect(await p.stdout.text()).toBe("hello\n");
    });

    it("spawns a program and waits on its pid", async () => {
      const rt = await booted(make);
      const handle = await rt.spawn({ cmd: "echo", args: ["x"] });
      expect((await rt.wait(handle.pid)).code).toBe(0);
      expect(await handle.stdout.text()).toBe("x\n");
    });

    it("surfaces an error for an unknown command", async () => {
      const rt = await booted(make);
      await expect(rt.spawn({ cmd: "definitely-not-a-command" })).rejects.toThrow(/ENOENT/);
    });

    it("exec's handle carries a real pid — visible to getProcesses and waitable via the runtime", async () => {
      const rt = await booted(make);
      const p = await rt.exec("echo pid-check");
      expect(p.pid).toBeGreaterThan(0);
      expect((await rt.wait(p.pid)).code).toBe(0);
      expect(await p.stdout.text()).toBe("pid-check\n");
      const info = (await rt.getProcesses()).find((x) => x.pid === p.pid);
      expect(info?.state).toBe("exited");
    });
  });
}
