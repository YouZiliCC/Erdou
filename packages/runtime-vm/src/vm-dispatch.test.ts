import { describe, it, expect } from "vitest";
import type { HttpRequest, HttpResponse } from "@erdou/runtime-contract";
import { VmRuntime } from "./vm-runtime.js";
import type { TcpConn } from "./v86-host.js";

// HERMETIC dispatch tests: the two-phase (buffered vs SSE-streamed) dispatch
// logic driven through a fake NetworkAdapter/TcpConn — no emulator, no image.
// The gated net.e2e suite proves the same behavior against a real guest.

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = new TextDecoder();

type Handler = (...args: never[]) => void;

class FakeConn implements TcpConn {
  private handlers = new Map<string, Handler[]>();
  written: Uint8Array[] = [];
  closed = 0;
  on(event: string, cb: Handler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
  }
  write(bytes: Uint8Array): void {
    this.written.push(bytes);
  }
  close(): void {
    this.closed++;
  }
  emit(event: "connect" | "close"): void;
  emit(event: "data", data: Uint8Array): void;
  emit(event: string, data?: Uint8Array): void {
    for (const cb of this.handlers.get(event) ?? []) (cb as (d?: Uint8Array) => void)(data);
  }
}

/** A VmRuntime whose host is replaced by a fake single-conn network adapter.
 *  dispatch() touches nothing else on the runtime, so no boot is needed —
 *  `booted` is faked so shutdown() takes its real teardown path (host.destroy
 *  is a no-op here; guestd/bridge are undefined and optional-chained). */
function fakeRuntime(conn: FakeConn, probe = true): VmRuntime {
  const rt = new VmRuntime(async () => {
    throw new Error("hermetic test: must not boot");
  });
  (rt as unknown as { host: unknown }).host = {
    networkAdapter: () => ({
      tcp_probe: async () => probe,
      connect: () => conn,
    }),
    destroy: async () => {},
  };
  (rt as unknown as { booted: boolean }).booted = true;
  return rt;
}

const GET: HttpRequest = { method: "GET", url: "/events", headers: {}, body: new Uint8Array() };
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Start a dispatch and drive the fake conn through its connect handshake.
 *  The pending dispatch rides in a wrapper object — returning it bare from an
 *  async function would let `await` flatten (= wait on) it. */
async function dispatched(conn: FakeConn, req: HttpRequest = GET): Promise<{ res: Promise<HttpResponse>; rt: VmRuntime }> {
  const rt = fakeRuntime(conn);
  const res = rt.dispatch(8000, req);
  await tick(); // let the async tcp_probe resolve and the handlers register
  conn.emit("connect");
  return { res, rt };
}

describe("VmRuntime.dispatch — hermetic two-phase", () => {
  it("probe-first: an unreachable port is a 502, no connection attempted", async () => {
    const conn = new FakeConn();
    const rt = fakeRuntime(conn, false);
    const res = await rt.dispatch(8000, GET);
    expect(res.status).toBe(502);
    expect(dec.decode(res.body)).toContain("No server listening on port 8000");
    expect(conn.written).toEqual([]);
  });

  it("non-SSE stays buffered and byte-identical: complete-on-content-length, framing headers stripped, stream absent", async () => {
    const conn = new FakeConn();
    const { res: p } = await dispatched(conn);
    expect(dec.decode(conn.written[0]!)).toContain("GET /events HTTP/1.1");
    conn.emit("data", enc("HTTP/1.0 200 OK\r\nContent-Type: text/html\r\nContent-Length: 5\r\n\r\nhello"));
    const res = await p;
    expect(res.status).toBe(200);
    expect(dec.decode(res.body)).toBe("hello");
    expect(res.stream).toBeUndefined();
    expect(res.headers["content-length"]).toBeUndefined();
    expect(res.headers["content-type"]).toBe("text/html");
    expect(conn.closed).toBeGreaterThan(0); // completion releases the conn
  });

  it("an SSE head resolves dispatch immediately (head-first) and streams unframed chunks until conn close", async () => {
    const conn = new FakeConn();
    const { res: p } = await dispatched(conn);
    // Head + the first event in ONE data chunk: the leftover past the head
    // must become the first stream chunk.
    conn.emit("data", enc("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\ndata: a\n\n"));
    const res = await p; // resolves NOW — no completion rule, no idle wait
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.body.length).toBe(0);
    expect(res.stream).toBeDefined();

    const it2 = res.stream![Symbol.asyncIterator]();
    expect(dec.decode((await it2.next()).value)).toBe("data: a\n\n");

    // A later event arrives long after any idle window would have fired.
    const pending = it2.next();
    conn.emit("data", enc("data: b\n\n"));
    expect(dec.decode((await pending).value)).toBe("data: b\n\n");

    // Guest FIN ends an unframed stream.
    conn.emit("close");
    expect((await it2.next()).done).toBe(true);
    expect(conn.closed).toBeGreaterThan(0); // passive close completed → conn released
  });

  it("a head split across data events still streams (sniff continues until CRLFCRLF)", async () => {
    const conn = new FakeConn();
    const { res: p } = await dispatched(conn);
    conn.emit("data", enc("HTTP/1.1 200 OK\r\nConte"));
    conn.emit("data", enc("nt-Type: text/event-stream\r\n\r\n"));
    const res = await p;
    expect(res.stream).toBeDefined();
    const it2 = res.stream![Symbol.asyncIterator]();
    const pending = it2.next();
    conn.emit("data", enc("data: later\n\n"));
    expect(dec.decode((await pending).value)).toBe("data: later\n\n");
    await it2.return!();
  });

  it("chunked SSE (uvicorn/FastAPI shape) is de-chunked incrementally and ends at the terminator", async () => {
    const conn = new FakeConn();
    const { res: p } = await dispatched(conn);
    conn.emit(
      "data",
      enc("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n9\r\ndata: a\n\n\r\n"),
    );
    const res = await p;
    expect(res.headers["transfer-encoding"]).toBeUndefined(); // stripped — body is de-framed
    const it2 = res.stream![Symbol.asyncIterator]();
    expect(dec.decode((await it2.next()).value)).toBe("data: a\n\n");

    // Split mid-chunk across TCP segments.
    const pending = it2.next();
    conn.emit("data", enc("9\r\ndata:"));
    conn.emit("data", enc(" b\n\n\r\n"));
    expect(dec.decode((await pending).value) + dec.decode((await it2.next()).value)).toBe("data: b\n\n");

    conn.emit("data", enc("0\r\n\r\n")); // terminator, no conn close needed
    expect((await it2.next()).done).toBe(true);
    expect(conn.closed).toBeGreaterThan(0);
  });

  it("consumer return() (client gone) closes the guest conn and later data is dropped", async () => {
    const conn = new FakeConn();
    const { res: p } = await dispatched(conn);
    conn.emit("data", enc("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\ndata: a\n\n"));
    const res = await p;
    const it2 = res.stream![Symbol.asyncIterator]();
    await it2.next();
    expect(conn.closed).toBe(0);
    await it2.return!();
    expect(conn.closed).toBeGreaterThan(0);
    conn.emit("data", enc("data: never\n\n")); // must not throw, must not resurrect
    expect((await it2.next()).done).toBe(true);
  });

  it("a body split across thousands of TCP segments assembles byte-identically, in linear work", async () => {
    const SEG = 1460; // v86's TCP segment size
    const bodyLen = 16 * 1024 * 1024;
    const body = new Uint8Array(bodyLen);
    for (let i = 0; i < bodyLen; i++) body[i] = (i * 31) & 0xff;
    const head = enc(`HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: ${bodyLen}\r\n\r\n`);
    const whole = new Uint8Array(head.length + bodyLen);
    whole.set(head, 0);
    whole.set(body, head.length);

    const one = new FakeConn();
    const { res: p1 } = await dispatched(one);
    one.emit("data", whole);
    const r1 = await p1;

    const many = new FakeConn();
    const { res: p2 } = await dispatched(many);
    const started = performance.now();
    for (let o = 0; o < whole.length; o += SEG) many.emit("data", whole.subarray(o, Math.min(o + SEG, whole.length)));
    // Completion is decided by the Content-Length counter, on the segment that
    // satisfies it — not by the 600ms idle fallback (finish() closes the conn).
    expect(many.closed).toBeGreaterThan(0);
    const r2 = await p2;
    const elapsedMs = performance.now() - started;

    expect(r2.status).toBe(r1.status);
    expect(r2.headers).toEqual(r1.headers);
    expect(r2.body.length).toBe(r1.body.length);
    // Index-based compare, not toEqual: a mismatch must report an offset, not
    // print a 4MB diff.
    let diff = -1;
    for (let i = 0; i < r1.body.length; i++) if (r1.body[i] !== r2.body[i]) { diff = i; break; }
    expect(diff).toBe(-1);
    // Per-event work must be O(1) in the bytes already received. Re-accumulating
    // the whole response on each of the ~11500 events is ~190GB of memcpy plus
    // 11500 multi-megabyte allocations — measured at 16.1s here, i.e. past the
    // 15s hard cap, which in the real emulator TRUNCATES the download. The
    // incremental counters do it in well under a second.
    expect(elapsedMs).toBeLessThan(3_000);
  }, 300_000);

  it("buffered chunked completes on a terminator split across segments (not on the idle fallback)", async () => {
    const conn = new FakeConn();
    const { res: p } = await dispatched(conn);
    conn.emit("data", enc("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n"));
    expect(conn.closed).toBe(0); // no terminator yet
    conn.emit("data", enc("0\r"));
    conn.emit("data", enc("\n\r\n")); // "0\r\n\r\n" straddles two TCP segments
    expect(conn.closed).toBeGreaterThan(0); // completed on the terminator, synchronously
    const res = await p;
    expect(dec.decode(res.body)).toBe("hello");
  });

  it("a malformed status line never self-completes — it finishes on close as a 502", async () => {
    const conn = new FakeConn();
    const { res: p } = await dispatched(conn);
    conn.emit("data", enc("NOT-HTTP garbage\r\nContent-Length: 5\r\n\r\nhello"));
    expect(conn.closed).toBe(0); // sniffing stopped; no completion rule can fire
    conn.emit("close");
    const res = await p;
    expect(res.status).toBe(502);
    expect(dec.decode(res.body)).toContain("malformed or incomplete response");
  });

  it("shutdown() fails an in-flight SSE stream instead of parking its consumer forever", async () => {
    const conn = new FakeConn();
    const { res: p, rt } = await dispatched(conn);
    conn.emit("data", enc("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\ndata: a\n\n"));
    const res = await p;
    const it2 = res.stream![Symbol.asyncIterator]();
    expect(dec.decode((await it2.next()).value)).toBe("data: a\n\n");
    const pending = it2.next(); // parked: no idle timer, no hard cap, no more data
    await rt.shutdown();
    // After host.destroy() no conn event can ever arrive — a silent close would
    // hang the preview request forever, so the stream must ERROR.
    await expect(pending).rejects.toThrow(/shutdown/i);
  }, 10_000); // a regression here HANGS — fail in 10s, not at the 120s file timeout

  it("a stream that ends normally is dropped from the shutdown set (no per-request leak)", async () => {
    const conn = new FakeConn();
    const { res: p, rt } = await dispatched(conn);
    conn.emit("data", enc("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n"));
    const res = await p;
    const live = (rt as unknown as { sseStreams: Set<unknown> }).sseStreams;
    expect(live.size).toBe(1);
    conn.emit("close"); // guest FIN ends an unframed stream
    expect((await res.stream![Symbol.asyncIterator]().next()).done).toBe(true);
    expect(live.size).toBe(0);
    await rt.shutdown(); // nothing left to fail
  });

  it("malformed chunked framing errors the stream (fail-fast) instead of truncating silently", async () => {
    const conn = new FakeConn();
    const { res: p } = await dispatched(conn);
    conn.emit(
      "data",
      enc("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n"),
    );
    const res = await p;
    const it2 = res.stream![Symbol.asyncIterator]();
    const pending = it2.next();
    conn.emit("data", enc("zz\r\n"));
    await expect(pending).rejects.toThrow(/malformed chunk-size/);
    expect(conn.closed).toBeGreaterThan(0);
  });
});
