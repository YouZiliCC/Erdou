import { describe, it, expect } from "vitest";
import { PortRegistry } from "./registry.js";
import { EventBus } from "../core/event-bus.js";
import type { HttpHandler, RuntimeEvent } from "@erdou/runtime-contract";

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

  it("serve + dispatch invokes the handler", async () => {
    const bus = new EventBus();
    const ports = new PortRegistry(bus);
    ports.serve(8000, (req) => ({
      status: 200,
      headers: { "content-type": "text/plain" },
      body: new TextEncoder().encode("hi " + req.url),
    }));
    const res = await ports.dispatch(8000, { method: "GET", url: "/x", headers: {}, body: new Uint8Array() });
    expect(res.status).toBe(200);
    expect(new TextDecoder().decode(res.body)).toBe("hi /x");
  });

  it("dispatch on an unbound port is a 502", async () => {
    const ports = new PortRegistry(new EventBus());
    const res = await ports.dispatch(9999, { method: "GET", url: "/", headers: {}, body: new Uint8Array() });
    expect(res.status).toBe(502);
  });

  it("serve twice on a port throws EADDRINUSE; close frees it", () => {
    const ports = new PortRegistry(new EventBus());
    const h: HttpHandler = () => ({ status: 200, headers: {}, body: new Uint8Array() });
    ports.serve(8000, h);
    expect(() => ports.serve(8000, h)).toThrow(/EADDRINUSE/);
    ports.close(8000);
    expect(() => ports.serve(8000, h)).not.toThrow();
  });

  it("close emits port.closed", () => {
    const bus = new EventBus();
    const events: RuntimeEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const ports = new PortRegistry(bus);
    const h: HttpHandler = () => ({ status: 200, headers: {}, body: new Uint8Array() });
    ports.serve(8000, h);
    ports.close(8000);
    expect(events.some((e) => e.type === "port.closed" && e.port === 8000)).toBe(true);
  });

  it("ports() lists currently-served ports", () => {
    const ports = new PortRegistry(new EventBus());
    const h: HttpHandler = () => ({ status: 200, headers: {}, body: new Uint8Array() });
    ports.serve(8000, h);
    ports.serve(9000, h);
    expect(ports.ports().sort()).toEqual([8000, 9000]);
  });
});
