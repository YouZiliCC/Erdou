import { describe, it, expect } from "vitest";
import type { RuntimeEvent } from "@erdou/runtime-contract";
import { type MakeRuntime, booted, until } from "../types.js";

export function portSuite(make: MakeRuntime): void {
  describe("port", () => {
    it("exposes a port as a URL and emits port.opened", async () => {
      const rt = await booted(make);
      const events: RuntimeEvent[] = [];
      rt.subscribe((e) => events.push(e));
      const url = await rt.exposePort(4321);
      expect(url).toContain("4321");
      await until(() => events.some((e) => e.type === "port.opened" && e.port === 4321));
    });

    // `dispatch` is the pure-contract half of the HTTP surface: any Runtime
    // must answer a request routed to an unbound port with a 502 HttpResponse
    // rather than throwing. (The other half — serve → dispatch → close —
    // requires registering a handler, which is only reachable through a
    // spawned program's `ExecContext.serve`; `registerProgram` isn't part of
    // the `Runtime` contract, so that roundtrip lives in the concrete
    // BrowserRuntime harness instead of here.)
    it("dispatch on an unbound port returns a 502 HttpResponse instead of throwing", async () => {
      const rt = await booted(make);
      const res = await rt.dispatch(59999, {
        method: "GET",
        url: "/",
        headers: {},
        body: new Uint8Array(),
      });
      expect(res.status).toBe(502);
      expect(res.body).toBeInstanceOf(Uint8Array);
      expect(res.headers).toBeTruthy();
    });

    it("closePort is contract surface and idempotent — closing an unserved port resolves as a no-op", async () => {
      const rt = await booted(make);
      await expect(rt.closePort(59998)).resolves.toBeUndefined();
    });
  });
}
