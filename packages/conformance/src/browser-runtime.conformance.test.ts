import { describe, it, expect } from "vitest";
import { runConformance } from "./index.js";
import { BrowserRuntime, type PortRegistry } from "@erdou/runtime-browser";
import type { HttpHandler, RuntimeEvent } from "@erdou/runtime-contract";

// This is the only place a concrete Runtime is imported — the suite modules
// themselves depend on @erdou/runtime-contract alone.
runConformance("BrowserRuntime", () => new BrowserRuntime({ clock: () => 0 }));

/**
 * The shared suite can only exercise the pure `Runtime` contract (dispatch,
 * events) — `serve` is reachable only through a spawned program's
 * `ExecContext.serve`, and `registerProgram` is a concrete `BrowserRuntime`
 * method, not part of the contract. So the full serve → dispatch → close →
 * port.closed → 502 roundtrip lives here, beside the only place a concrete
 * Runtime is already imported.
 */
describe("BrowserRuntime: HTTP serve/dispatch/close roundtrip", () => {
  it("serves a handler from a spawned program, dispatches to it, then closes and 502s", async () => {
    const rt = new BrowserRuntime({ clock: () => 0 });
    await rt.boot();

    const events: RuntimeEvent[] = [];
    rt.subscribe((e) => events.push(e));

    const echo: HttpHandler = (req) => ({
      status: 200,
      headers: { "content-type": "text/plain" },
      body: new TextEncoder().encode(`echo ${req.method} ${req.url}`),
    });
    rt.registerProgram("http-echo", async (ctx) => {
      ctx.serve(8090, echo);
      return 0;
    });

    const handle = await rt.spawn({ cmd: "http-echo" });
    await rt.wait(handle.pid);

    const served = await rt.dispatch(8090, {
      method: "GET",
      url: "/ping",
      headers: {},
      body: new Uint8Array(),
    });
    expect(served.status).toBe(200);
    expect(new TextDecoder().decode(served.body)).toBe("echo GET /ping");
    expect(events.some((e) => e.type === "port.opened" && e.port === 8090)).toBe(true);

    // `closePort` isn't on the public Runtime/BrowserRuntime surface yet (it
    // lands with the preview panel's stop button, per the round-9 plan) —
    // reach the kernel's PortRegistry directly so this test still exercises
    // the real close()/port.closed wiring through this runtime's own event
    // bus, on the exact port just served above.
    const ports = (rt as unknown as { ports: PortRegistry }).ports;
    ports.close(8090);

    expect(events.some((e) => e.type === "port.closed" && e.port === 8090)).toBe(true);

    const afterClose = await rt.dispatch(8090, {
      method: "GET",
      url: "/ping",
      headers: {},
      body: new Uint8Array(),
    });
    expect(afterClose.status).toBe(502);
  });
});
