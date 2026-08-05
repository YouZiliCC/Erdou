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

    it("discards a redirect to /dev/null and still runs the command", async () => {
      // The single most common shell idiom an agent writes. The VM kernel has
      // a real device node; the browser kernel recognizes the path in the
      // shell. Either way, the CONTRACT is: the command runs and the fd is
      // silently discarded — never an ENOENT that fails the whole line.
      const rt = await booted(make);
      const p = await rt.exec("echo hi 2>/dev/null");
      expect((await p.wait()).code).toBe(0);
      expect(await p.stdout.text()).toBe("hi\n");
    });
  });
}
