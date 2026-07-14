import { describe, it, expect } from "vitest";
import { PortRegistry } from "./registry.js";
import { EventBus } from "../core/event-bus.js";
import type { RuntimeEvent } from "@erdou/runtime-contract";

describe("PortRegistry", () => {
  it("rejects a double bind and frees on close", async () => {
    const reg = new PortRegistry(new EventBus());
    const port = reg.listen(3000);
    expect(() => reg.listen(3000)).toThrow(/EADDRINUSE/);
    await port.close();
    expect(() => reg.listen(3000)).not.toThrow();
  });

  it("exposePort returns a URL and emits port.opened", () => {
    const bus = new EventBus();
    const events: RuntimeEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const reg = new PortRegistry(bus);
    const url = reg.exposePort(3000);
    expect(url).toBe("https://3000.preview.erdou.local/");
    expect(events).toEqual([{ type: "port.opened", port: 3000, url }]);
  });
});
