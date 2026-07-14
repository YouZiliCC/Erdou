import { describe, it, expect } from "vitest";
import { type MakeRuntime, booted } from "../types.js";

const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

export function filesystemSuite(make: MakeRuntime): void {
  describe("filesystem", () => {
    it("round-trips a file", async () => {
      const rt = await booted(make);
      await rt.writeFile("/f.txt", "hello");
      expect(decode(await rt.readFile("/f.txt"))).toBe("hello");
    });

    it("rejects reading a missing file", async () => {
      const rt = await booted(make);
      await expect(rt.readFile("/missing")).rejects.toThrow(/ENOENT/);
    });

    it("creates nested directories and lists them", async () => {
      const rt = await booted(make);
      await rt.mkdir("/a/b", { recursive: true });
      await rt.writeFile("/a/b/x", "1");
      expect((await rt.readdir("/a/b")).map((e) => e.name)).toEqual(["x"]);
      expect((await rt.stat("/a/b")).type).toBe("directory");
    });

    it("removes a tree recursively", async () => {
      const rt = await booted(make);
      await rt.mkdir("/d", { recursive: true });
      await rt.writeFile("/d/f", "1");
      await rt.rm("/d", { recursive: true });
      await expect(rt.stat("/d")).rejects.toThrow(/ENOENT/);
    });

    it("renames a file", async () => {
      const rt = await booted(make);
      await rt.writeFile("/from", "data");
      await rt.rename("/from", "/to");
      expect(decode(await rt.readFile("/to"))).toBe("data");
    });
  });
}
