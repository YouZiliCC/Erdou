import { describe, it, expect } from "vitest";
import * as contract from "./index.js";
import { ErrnoError } from "./index.js";
import type { Runtime, RuntimeEvent, HttpRequest, HttpResponse } from "./index.js";

describe("contract surface", () => {
  it("exports ErrnoError as a working constructor", () => {
    expect(typeof ErrnoError).toBe("function");
    expect(new ErrnoError("EINVAL").code).toBe("EINVAL");
  });

  it("only ships runtime values for errors — the rest are erased types", () => {
    // Every non-error export is a type and disappears at runtime; the only
    // runtime bindings are ErrnoError and the errno factory helpers.
    expect(Object.keys(contract)).toContain("ErrnoError");
    expect(Object.keys(contract)).toContain("enoent");
    expect(Object.keys(contract)).not.toContain("Runtime");
  });

  it("allows a structurally-typed Runtime and event to compile", () => {
    // Compile-time proof the interfaces are usable; asserts at runtime too.
    const ev: RuntimeEvent = { type: "port.opened", port: 3000, url: "x" };
    expect(ev.type).toBe("port.opened");
    const partial: Pick<Runtime, "getCapabilities"> = {
      getCapabilities: async () => ({
        nativeProcesses: true,
        virtualPorts: true,
        persistentStorage: true,
        network: true,
        threads: false,
        nativeAddons: false,
      }),
    };
    expect(typeof partial.getCapabilities).toBe("function");
  });

  it("carries HTTP request/response + port.closed shapes", () => {
    const req: HttpRequest = { method: "GET", url: "/", headers: {}, body: new Uint8Array() };
    const res: HttpResponse = { status: 200, headers: { "content-type": "text/plain" }, body: new Uint8Array() };
    const ev: RuntimeEvent = { type: "port.closed", port: 8000 };
    expect(req.method).toBe("GET");
    expect(res.status).toBe(200);
    expect(ev.type).toBe("port.closed");
  });
});
