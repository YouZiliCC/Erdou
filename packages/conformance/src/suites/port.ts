import { describe, it, expect } from "vitest";
import type { RuntimeEvent } from "@erdou/runtime-contract";
import { type MakeRuntime, booted } from "../types.js";

export function portSuite(make: MakeRuntime): void {
  describe("port", () => {
    it("exposes a port as a URL and emits port.opened", async () => {
      const rt = await booted(make);
      const events: RuntimeEvent[] = [];
      rt.subscribe((e) => events.push(e));
      const url = await rt.exposePort(4321);
      expect(url).toContain("4321");
      expect(events.some((e) => e.type === "port.opened" && e.port === 4321)).toBe(true);
    });
  });
}
