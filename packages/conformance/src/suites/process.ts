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
  });
}
