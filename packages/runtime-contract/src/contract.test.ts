import { describe, it, expect } from "vitest";
import * as contract from "./index.js";
import { ErrnoError } from "./index.js";
import type { Runtime, RuntimeEvent, HttpRequest, HttpResponse, WsConnection } from "./index.js";

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
        threads: false,
        nativeAddons: false,
        realOs: false,
        interpreters: [],
        packageManagers: [],
        networkEgress: "cors-only",
        memoryLimitMB: null,
        snapshotCost: "cheap",
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

  it("carries an optional streamed-response body (head-time resolve, single-use iterable)", async () => {
    // `stream` present ⇒ `body` is empty and consumers iterate the chunks.
    const streamed: HttpResponse = {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: new Uint8Array(),
      stream: (async function* () {
        yield new Uint8Array([1, 2]);
      })(),
    };
    expect(streamed.body.length).toBe(0);
    const chunks: Uint8Array[] = [];
    for await (const c of streamed.stream!) chunks.push(c);
    expect(chunks).toEqual([new Uint8Array([1, 2])]);
    // …and a plain buffered response simply omits it.
    const buffered: HttpResponse = { status: 200, headers: {}, body: new Uint8Array([3]) };
    expect(buffered.stream).toBeUndefined();
  });

  it("carries the WebSocket shapes: WsConnection + the OPTIONAL Runtime.upgrade", async () => {
    // WsConnection is plain callbacks — text frames as string, binary as Uint8Array.
    const seen: Array<string | Uint8Array> = [];
    const ws: WsConnection = {
      protocol: "chat",
      send: (d) => seen.push(d),
      onMessage: () => {},
      onClose: () => {},
      close: () => {},
    };
    ws.send("hello");
    ws.send(new Uint8Array([1]));
    expect(seen).toEqual(["hello", new Uint8Array([1])]);

    // `upgrade` is an OPTIONAL capability method: a kernel without WebSocket
    // support omits it (absence = the fail-fast decline signal), one with
    // support implements it. Both shapes must compile against the contract.
    type UpgradeSlice = Pick<Runtime, "upgrade">;
    const declines: UpgradeSlice = {}; // browser kernel: no upgrade at all
    const supports: UpgradeSlice = { upgrade: async () => ws };
    expect(declines.upgrade).toBeUndefined();
    const req: HttpRequest = {
      method: "GET",
      url: "/ws",
      headers: { upgrade: "websocket" },
      body: new Uint8Array(),
    };
    expect((await supports.upgrade!(3000, req)).protocol).toBe("chat");
  });
});
