import { describe, it, expect } from "vitest";
import { type MakeRuntime, booted } from "../types.js";

const REQUIRED_KEYS = [
  "nativeProcesses",
  "virtualPorts",
  "persistentStorage",
  "network",
  "threads",
  "nativeAddons",
] as const;

export function capabilitiesSuite(make: MakeRuntime): void {
  describe("capabilities", () => {
    it("reports every required capability flag as a boolean", async () => {
      const rt = await booted(make);
      const caps = await rt.getCapabilities();
      for (const key of REQUIRED_KEYS) {
        expect(typeof caps[key]).toBe("boolean");
      }
    });
  });
}
