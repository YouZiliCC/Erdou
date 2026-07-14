import { describe, it, expect } from "vitest";
import { type MakeRuntime, booted } from "../types.js";

const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

export function snapshotSuite(make: MakeRuntime): void {
  describe("snapshot", () => {
    it("restores filesystem state exactly", async () => {
      const rt = await booted(make);
      await rt.writeFile("/s.txt", "original");
      const snap = await rt.createSnapshot();

      await rt.writeFile("/s.txt", "changed");
      await rt.writeFile("/added.txt", "new");

      await rt.restoreSnapshot(snap);
      expect(decode(await rt.readFile("/s.txt"))).toBe("original");
      await expect(rt.readFile("/added.txt")).rejects.toThrow(/ENOENT/);
    });
  });
}
