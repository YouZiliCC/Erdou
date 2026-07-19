import { describe, it, expect } from "vitest";
import { runConformance } from "./index.js";
import { BrowserRuntime } from "@erdou/runtime-browser";
import type { HttpHandler, Runtime, RuntimeEvent } from "@erdou/runtime-contract";

// This is the only place a concrete Runtime is imported — the suite modules
// themselves depend on @erdou/runtime-contract alone.
runConformance("BrowserRuntime", () => {
  const rt = new BrowserRuntime({ clock: () => 0 });
  // The browser kernel ships no `sleep` builtin, but `sleep` is part of the
  // suite's POSIX-ish baseline (the blocking exec-kill test needs a program
  // that outlives its promptness bound). Provide it through the public
  // program-registration seam as a never-settling program: kill(pid) is the
  // only way it ends — exactly what that test asserts — and there is no
  // pending timer left behind after the kill.
  rt.registerProgram("sleep", () => new Promise<number>(() => {}));
  return rt;
});

/**
 * The shared suite can only exercise the pure `Runtime` contract (dispatch,
 * events) — `serve` is reachable only through a spawned program's
 * `ExecContext.serve`, and `registerProgram` is a concrete `BrowserRuntime`
 * method, not part of the contract. So the full serve → dispatch → close →
 * port.closed → 502 roundtrip lives here, beside the only place a concrete
 * Runtime is already imported.
 */
describe("BrowserRuntime: WebSocket capability", () => {
  it("declines WebSockets by OMISSION — no upgrade method at all (the contract's fail-fast decline shape)", () => {
    // The browser kernel has no WebSocket-capable server producer (no node
    // executor; Python is WSGI = request/response), so it must not ship a
    // speculative `upgrade`. The preview bridge reads this absence and
    // surfaces the precise "not supported on this kernel" error to the shim.
    const rt: Runtime = new BrowserRuntime({ clock: () => 0 });
    expect(rt.upgrade).toBeUndefined();
  });
});

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
    // Plain handlers are untouched by the streaming addition: a buffered
    // response still carries its whole body as a Uint8Array, `stream` absent.
    expect(served.body).toBeInstanceOf(Uint8Array);
    expect(served.stream).toBeUndefined();
    expect(events.some((e) => e.type === "port.opened" && e.port === 8090)).toBe(true);

    // `closePort` is contract surface as of round 10 — close through the
    // public Runtime API and verify the port.closed event + 502 afterwards.
    await rt.closePort(8090);

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

/**
 * Streamed responses (`HttpResponse.stream`) through the same serve → dispatch
 * seam. The handler returns a head + an async-generator body whose progress is
 * test-controlled through gates — which makes head-first resolution PROVABLE:
 * a buffered implementation could only resolve dispatch after consuming the
 * generator, and the generator cannot advance until the test opens a gate.
 */
describe("BrowserRuntime: streamed dispatch (SSE)", () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  const GET = { method: "GET", url: "/events", headers: {}, body: new Uint8Array() };

  interface Gated {
    gates: Array<() => void>;
    open(i: number): Promise<void>;
    finallyRan: () => boolean;
    body: () => AsyncGenerator<Uint8Array>;
  }

  // A two-chunk SSE body parked on externally-opened gates.
  function gatedBody(): Gated {
    const gates: Array<() => void> = [];
    const gate = (): Promise<void> => new Promise<void>((r) => gates.push(r));
    let finallyRan = false;
    async function* body(): AsyncGenerator<Uint8Array> {
      try {
        await gate();
        yield enc("data: one\n\n");
        await gate();
        yield enc("data: two\n\n");
      } finally {
        finallyRan = true;
      }
    }
    return {
      gates,
      // Wait until the generator parks on gate i, then open it.
      async open(i: number): Promise<void> {
        const start = Date.now();
        while (gates.length <= i) {
          if (Date.now() - start > 2000) throw new Error(`gate ${i} never registered`);
          await new Promise((r) => setTimeout(r, 5));
        }
        gates[i]!();
      },
      finallyRan: () => finallyRan,
      body,
    };
  }

  async function serveStream(gated: Gated): Promise<BrowserRuntime> {
    const rt = new BrowserRuntime({ clock: () => 0 });
    await rt.boot();
    rt.registerProgram("sse", async (ctx) => {
      ctx.serve(8091, () => ({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: new Uint8Array(),
        stream: gated.body(),
      }));
      return 0;
    });
    const handle = await rt.spawn({ cmd: "sse" });
    await rt.wait(handle.pid);
    return rt;
  }

  it("resolves dispatch at HEAD-time, then iterates chunks in order as the producer releases them", async () => {
    const gated = gatedBody();
    const rt = await serveStream(gated);

    const res = await rt.dispatch(8091, GET);
    // Head-first proof: dispatch has resolved but the generator has not even
    // STARTED (no gate registered yet — nothing pulled, nothing buffered).
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.body.length).toBe(0);
    expect(res.stream).toBeDefined();
    expect(gated.gates.length).toBe(0);

    const it = res.stream![Symbol.asyncIterator]();
    const p1 = it.next();
    await gated.open(0);
    expect(new TextDecoder().decode((await p1).value)).toBe("data: one\n\n");

    const p2 = it.next();
    await gated.open(1);
    expect(new TextDecoder().decode((await p2).value)).toBe("data: two\n\n");

    expect((await it.next()).done).toBe(true);
    expect(gated.finallyRan()).toBe(true); // full consumption runs the generator's finally
  });

  it("an early iterator return() (client gone) runs the producer's finally", async () => {
    const gated = gatedBody();
    const rt = await serveStream(gated);

    const res = await rt.dispatch(8091, GET);
    const it = res.stream![Symbol.asyncIterator]();
    const p1 = it.next();
    await gated.open(0);
    await p1; // one chunk consumed…
    expect(gated.finallyRan()).toBe(false);
    await it.return!(); // …then the client goes away
    expect(gated.finallyRan()).toBe(true);
  });
});
