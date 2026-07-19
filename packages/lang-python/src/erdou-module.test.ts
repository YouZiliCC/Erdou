import { describe, it, expect } from "vitest";
import type { ExecContext, HttpHandler, HttpRequest, HttpResponse } from "@erdou/runtime-contract";
import { ERDOU_SETUP, createServeBinding } from "./erdou-module.js";
import type { Pyodide, PyProxy } from "./pyodide.js";

// Unit tests for the WSGI streaming plumbing: a fake Pyodide provides JS
// implementations of the `__erdou_wsgi_start/next/close` primitives with the
// exact calling convention the Python side implements (list-proxy returns,
// bytes-proxy chunks, None exhaustion, `[error_bytes]` failures, token
// registry). The Python code itself is exercised end-to-end in the headless
// browser check (real Pyodide) — here we prove the JS handler's behavior.

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = new TextDecoder();

/** Wrap a plain value as the minimal PyProxy the handler consumes. */
function proxy(value: unknown): PyProxy & { destroyed: boolean } {
  const p = {
    destroyed: false,
    copy: () => proxy(value),
    toJs: () => value,
    destroy() {
      p.destroyed = true;
    },
  };
  return p;
}

interface StartResult {
  status: string;
  headers: [string, string][];
  first?: Uint8Array;
  exhausted?: boolean;
  token?: number | null;
}

/** A fake Pyodide whose globals carry the three WSGI primitives. `chunks`
 *  scripts what `__erdou_wsgi_next` yields per call after the start. */
function fakeWsgi(start: StartResult, chunks: Array<Uint8Array | { error: Uint8Array }> = []) {
  const calls = { next: 0, close: [] as number[] };
  let remaining = [...chunks];
  const live = new Set<number>();
  if (start.token != null && !start.exhausted) live.add(start.token);
  const globals = new Map<string, unknown>([
    [
      "__erdou_wsgi_start",
      (..._args: unknown[]) =>
        proxy([start.status, start.headers, start.first ?? new Uint8Array(), start.exhausted ?? false, start.token ?? null]),
    ],
    [
      "__erdou_wsgi_next",
      (token: unknown) => {
        calls.next++;
        if (!live.has(token as number)) return undefined; // deregistered → None
        const c = remaining.shift();
        if (c === undefined) {
          live.delete(token as number); // exhaustion closes + deregisters in Python
          calls.close.push(token as number);
          return undefined;
        }
        if (c instanceof Uint8Array) return proxy(c);
        live.delete(token as number); // an error also closes + deregisters
        calls.close.push(token as number);
        return proxy([c.error]);
      },
    ],
    [
      "__erdou_wsgi_close",
      (token: unknown) => {
        if (!live.delete(token as number)) return undefined; // idempotent no-op
        calls.close.push(token as number);
        return undefined;
      },
    ],
  ]);
  const py: Pyodide = {
    runPythonAsync: async () => undefined,
    setStdout: () => {},
    setStderr: () => {},
    globals: { get: (n: string) => globals.get(n), set: () => {} },
    FS: {
      readdir: () => [],
      stat: () => ({ mode: 0 }),
      isDir: () => false,
      isFile: () => false,
      readFile: () => new Uint8Array(),
      writeFile: () => {},
      mkdir: () => {},
      analyzePath: () => ({ exists: false }),
    },
  };
  return { py, calls, live };
}

/** Register a handler through the real createServeBinding and return it. */
function servedHandler(py: Pyodide): HttpHandler {
  let handler: HttpHandler | undefined;
  const ctx = { serve: (_port: number, h: HttpHandler) => (handler = h) } as unknown as ExecContext;
  const bind = createServeBinding(py, ctx);
  bind(8000, proxy("the-app"));
  if (!handler) throw new Error("serve was not called");
  return handler;
}

const GET: HttpRequest = { method: "GET", url: "/", headers: {}, body: new Uint8Array() };

describe("ERDOU_SETUP (Python source sanity)", () => {
  it("ships the two-primitive WSGI redesign and drops the old single-shot helper", () => {
    expect(ERDOU_SETUP).toContain("def __erdou_wsgi_start");
    expect(ERDOU_SETUP).toContain("def __erdou_wsgi_next");
    expect(ERDOU_SETUP).toContain("def __erdou_wsgi_close");
    expect(ERDOU_SETUP).not.toContain("__erdou_call_wsgi");
    // PEP 3333: close() must run on the app iterable on every path.
    expect(ERDOU_SETUP.match(/getattr\((result|state\.get\('result'\)), 'close', None\)/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

describe("WSGI handler — buffered path (every non-SSE response)", () => {
  it("drains the iterable to a complete body, lowercases headers, parses the status line", async () => {
    const { py, calls } = fakeWsgi(
      { status: "201 Created", headers: [["Content-Type", "text/plain"], ["X-A", "b"]], first: enc("he"), token: 1 },
      [enc("llo")],
    );
    const res = await servedHandler(py)(GET);
    expect(res.status).toBe(201);
    expect(res.headers["content-type"]).toBe("text/plain");
    expect(res.headers["x-a"]).toBe("b");
    expect(dec.decode(res.body)).toBe("hello");
    expect(res.stream).toBeUndefined();
    expect(calls.close).toEqual([1]); // exhaustion closed the iterable in "Python"
  });

  it("an exhausted-at-start app (head known, no live iterator) buffers without any next calls", async () => {
    const { py, calls } = fakeWsgi({
      status: "200 OK",
      headers: [["Content-Type", "text/plain"]],
      first: enc("whole"),
      exhausted: true,
      token: null,
    });
    const res = await servedHandler(py)(GET);
    expect(dec.decode(res.body)).toBe("whole");
    expect(calls.next).toBe(0);
  });

  it("a start failure surfaces the Python-side 500 + traceback shape unchanged", async () => {
    const { py } = fakeWsgi({
      status: "500 Internal Server Error",
      headers: [["Content-Type", "text/plain; charset=utf-8"]],
      first: enc("WSGI application error:\nTraceback…"),
      exhausted: true,
      token: null,
    });
    const res = await servedHandler(py)(GET);
    expect(res.status).toBe(500);
    expect(dec.decode(res.body)).toContain("WSGI application error:");
  });

  it("a mid-drain error becomes the same 500 + traceback body the old single-shot drain produced", async () => {
    const { py } = fakeWsgi(
      { status: "200 OK", headers: [["Content-Type", "text/plain"]], token: 3 },
      [enc("partial"), { error: enc("WSGI application error:\nboom") }],
    );
    const res = await servedHandler(py)(GET);
    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(dec.decode(res.body)).toBe("WSGI application error:\nboom"); // drained chunks dropped, like the old code
  });

  it("a NON-event-stream content-type never engages streaming even with a live iterator", async () => {
    const { py } = fakeWsgi(
      { status: "200 OK", headers: [["Content-Type", "application/json"]], first: enc("["), token: 9 },
      [enc("]")],
    );
    const res = await servedHandler(py)(GET);
    expect(res.stream).toBeUndefined();
    expect(dec.decode(res.body)).toBe("[]");
  });
});

describe("WSGI handler — streaming path (text/event-stream)", () => {
  const sseStart = (token: number, first = enc("data: 0\n\n")): StartResult => ({
    status: "200 OK",
    headers: [["Content-Type", "text/event-stream"], ["Cache-Control", "no-store"]],
    first,
    token,
  });

  it("resolves at head-time with an empty body and a stream; chunks arrive per pull, in order", async () => {
    const { py, calls } = fakeWsgi(sseStart(5), [enc("data: 1\n\n"), enc("data: 2\n\n")]);
    const res = await servedHandler(py)(GET);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.body.length).toBe(0);
    expect(res.stream).toBeDefined();
    expect(calls.next).toBe(0); // head-first: nothing pulled yet

    const got: string[] = [];
    for await (const c of res.stream!) got.push(dec.decode(c));
    expect(got).toEqual(["data: 0\n\n", "data: 1\n\n", "data: 2\n\n"]);
    expect(calls.close).toEqual([5]); // exhaustion released the Python side exactly once
  });

  it("an SSE head with charset parameter still streams; matching is on the media type", async () => {
    const { py } = fakeWsgi(
      {
        status: "200 OK",
        headers: [["Content-Type", "text/event-stream; charset=utf-8"]],
        first: enc("data: x\n\n"),
        token: 6,
      },
      [],
    );
    const res = await servedHandler(py)(GET);
    expect(res.stream).toBeDefined();
  });

  it("consumer return() mid-stream (client gone) closes the WSGI iterable once", async () => {
    const { py, calls, live } = fakeWsgi(sseStart(7), [enc("data: 1\n\n"), enc("data: 2\n\n")]);
    const res = await servedHandler(py)(GET);
    const it2 = res.stream![Symbol.asyncIterator]();
    expect(dec.decode((await it2.next()).value)).toBe("data: 0\n\n");
    await it2.return!();
    expect(calls.close).toEqual([7]);
    expect(live.size).toBe(0);
    expect((await it2.next()).done).toBe(true); // single-use, stays done
  });

  it("consumer return() BEFORE the first pull still releases the Python side (no token leak)", async () => {
    const { py, calls } = fakeWsgi(sseStart(8), [enc("data: 1\n\n")]);
    const res = await servedHandler(py)(GET);
    const it2 = res.stream![Symbol.asyncIterator]();
    await it2.return!(); // an instantly-gone client: no next() ever ran
    expect(calls.close).toEqual([8]);
  });

  it("a mid-stream app error rejects the iteration with the WSGI traceback (fail-fast)", async () => {
    const { py, calls } = fakeWsgi(sseStart(9), [
      enc("data: 1\n\n"),
      { error: enc("WSGI application error:\nkaboom") },
    ]);
    const res = await servedHandler(py)(GET);
    const it2 = res.stream![Symbol.asyncIterator]();
    await it2.next(); // first
    await it2.next(); // data: 1
    await expect(it2.next()).rejects.toThrow(/WSGI application error:[\s\S]*kaboom/);
    expect(calls.close).toEqual([9]); // the error already closed it Python-side; release was idempotent
  });

  it("an SSE app that is exhausted at start falls back to a plain empty-bodied response", async () => {
    const { py } = fakeWsgi({
      status: "200 OK",
      headers: [["Content-Type", "text/event-stream"]],
      exhausted: true,
      token: null,
    });
    const res = await servedHandler(py)(GET);
    expect(res.stream).toBeUndefined();
    expect(res.body.length).toBe(0);
  });
});

describe("WSGI handler — proxy hygiene", () => {
  it("destroys every per-call PyProxy (start result + each chunk)", async () => {
    const made: Array<PyProxy & { destroyed: boolean }> = [];
    const track = <T extends PyProxy & { destroyed: boolean }>(p: T): T => {
      made.push(p);
      return p;
    };
    const globals = new Map<string, unknown>([
      ["__erdou_wsgi_start", () => track(proxy(["200 OK", [["Content-Type", "text/plain"]], enc("a"), false, 1]))],
      [
        "__erdou_wsgi_next",
        (() => {
          let n = 0;
          return () => (n++ === 0 ? track(proxy(enc("b"))) : undefined);
        })(),
      ],
      ["__erdou_wsgi_close", () => undefined],
    ]);
    const py = {
      runPythonAsync: async () => undefined,
      setStdout: () => {},
      setStderr: () => {},
      globals: { get: (n: string) => globals.get(n), set: () => {} },
      FS: {} as Pyodide["FS"],
    } as Pyodide;
    const res = await servedHandler(py)(GET);
    expect(dec.decode(res.body)).toBe("ab");
    expect(made.length).toBe(2);
    expect(made.every((p) => p.destroyed)).toBe(true);
  });
});
