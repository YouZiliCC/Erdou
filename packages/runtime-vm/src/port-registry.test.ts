import { describe, it, expect } from "vitest";
import type { RuntimeEvent, HttpHandler } from "@erdou/runtime-contract";
import { PortRegistry } from "./port-registry.js";

const req = { method: "GET", url: "/", headers: {}, body: new Uint8Array() };

describe("PortRegistry", () => {
  it("serves, dispatches, then closes with events and a 502 afterward", async () => {
    const events: RuntimeEvent[] = [];
    const reg = new PortRegistry((e) => events.push(e));
    const handler: HttpHandler = () => ({ status: 200, headers: {}, body: new TextEncoder().encode("hi") });
    reg.serve(8080, handler);
    expect(events.some((e) => e.type === "port.opened" && e.port === 8080)).toBe(true);
    const ok = await reg.dispatch(8080, req);
    expect(ok.status).toBe(200);
    reg.close(8080);
    expect(events.some((e) => e.type === "port.closed" && e.port === 8080)).toBe(true);
    expect((await reg.dispatch(8080, req)).status).toBe(502);
  });

  it("throws EADDRINUSE on double serve and is idempotent on close", () => {
    const reg = new PortRegistry(() => {});
    const h: HttpHandler = () => ({ status: 200, headers: {}, body: new Uint8Array() });
    reg.serve(3000, h);
    expect(() => reg.serve(3000, h)).toThrow(/EADDRINUSE/);
    reg.close(3000);
    expect(() => reg.close(3000)).not.toThrow();
  });
});
