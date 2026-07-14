import { describe, it, expect } from "vitest";
import { type MakeRuntime, booted } from "../types.js";

const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

export function shellSuite(make: MakeRuntime): void {
  describe("shell", () => {
    it("runs a pipeline", async () => {
      const rt = await booted(make);
      const p = await rt.exec("echo hi | grep h");
      await p.wait();
      expect(await p.stdout.text()).toBe("hi\n");
    });

    it("redirects stdout to a file", async () => {
      const rt = await booted(make);
      await (await rt.exec("echo data > /out.txt")).wait();
      expect(decode(await rt.readFile("/out.txt"))).toBe("data\n");
    });

    it("short-circuits with || and &&", async () => {
      const rt = await booted(make);
      const p = await rt.exec("false || echo ok");
      await p.wait();
      expect(await p.stdout.text()).toBe("ok\n");
    });
  });
}
