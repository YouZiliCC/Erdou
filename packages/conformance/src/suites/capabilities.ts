import { describe, it, expect } from "vitest";
import { type MakeRuntime, booted } from "../types.js";

const BOOLEAN_KEYS = [
  "nativeProcesses",
  "virtualPorts",
  "persistentStorage",
  "threads",
  "nativeAddons",
  "realOs",
] as const;

export function capabilitiesSuite(make: MakeRuntime): void {
  describe("capabilities", () => {
    it("reports every boolean capability flag as a boolean", async () => {
      const rt = await booted(make);
      const caps = await rt.getCapabilities();
      for (const key of BOOLEAN_KEYS) {
        expect(typeof caps[key], key).toBe("boolean");
      }
    });

    it("describes its environment: interpreters, package managers, network egress, memory, snapshot cost", async () => {
      const rt = await booted(make);
      const caps = await rt.getCapabilities();
      expect(Array.isArray(caps.interpreters)).toBe(true);
      expect(caps.interpreters.every((s) => typeof s === "string")).toBe(true);
      expect(Array.isArray(caps.packageManagers)).toBe(true);
      expect(caps.packageManagers.every((s) => typeof s === "string")).toBe(true);
      expect(["none", "cors-only", "full"]).toContain(caps.networkEgress);
      expect(caps.memoryLimitMB === null || typeof caps.memoryLimitMB === "number").toBe(true);
      expect(["cheap", "expensive"]).toContain(caps.snapshotCost);
    });
  });
}
