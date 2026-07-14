import { describe, it, expect } from "vitest";
import { EventBus } from "./event-bus.js";
import type { RuntimeEvent } from "@erdou/runtime-contract";

const evt: RuntimeEvent = { type: "port.opened", port: 3000, url: "u" };

describe("EventBus", () => {
  it("fans out to all listeners", () => {
    const bus = new EventBus();
    const a: RuntimeEvent[] = [];
    const b: RuntimeEvent[] = [];
    bus.subscribe((e) => a.push(e));
    bus.subscribe((e) => b.push(e));
    bus.emit(evt);
    expect(a).toEqual([evt]);
    expect(b).toEqual([evt]);
  });

  it("unsubscribe stops delivery to that listener only", () => {
    const bus = new EventBus();
    const a: RuntimeEvent[] = [];
    const b: RuntimeEvent[] = [];
    const off = bus.subscribe((e) => a.push(e));
    bus.subscribe((e) => b.push(e));
    off();
    bus.emit(evt);
    expect(a).toEqual([]);
    expect(b).toEqual([evt]);
  });
});
