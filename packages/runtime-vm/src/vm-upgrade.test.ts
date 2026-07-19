import { describe, it, expect } from "vitest";
import type { HttpRequest, WsConnection } from "@erdou/runtime-contract";
import { VmRuntime } from "./vm-runtime.js";
import type { TcpConn } from "./v86-host.js";
import { wsAccept, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING } from "./ws-codec.js";

// HERMETIC upgrade tests: VmRuntime.upgrade()'s handshake + connection state
// machine driven through a fake NetworkAdapter/TcpConn (same harness idiom as
// vm-dispatch.test.ts) — no emulator, no image. The gated net.e2e suite proves
// the same behavior against a real guest node WS server.

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
  /** The Sec-WebSocket-Key the runtime sent (parsed from the written upgrade). */
  sentKey(): string {
    const text = dec.decode(this.written[0]!);
    const m = /Sec-WebSocket-Key: (\S+)/.exec(text);
    if (!m) throw new Error("no Sec-WebSocket-Key in the written upgrade request:\n" + text);
    return m[1]!;
  }
}

function fakeRuntime(conn: FakeConn, probe = true): VmRuntime {
  const rt = new VmRuntime(async () => {
    throw new Error("hermetic test: must not boot");
  });
  (rt as unknown as { host: unknown }).host = {
    networkAdapter: () => ({
      tcp_probe: async () => probe,
      connect: () => conn,
    }),
  };
  return rt;
}

const REQ: HttpRequest = { method: "GET", url: "/ws", headers: {}, body: new Uint8Array() };
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** An unmasked server data/control frame (short payloads only). */
function frame(opcode: number, payload: Uint8Array): Uint8Array {
  return new Uint8Array([0x80 | opcode, payload.length, ...payload]);
}

/** Unmask the LAST client frame the runtime wrote. */
function lastWritten(conn: FakeConn): { opcode: number; payload: Uint8Array } {
  const f = conn.written[conn.written.length - 1]!;
  const opcode = f[0]! & 0x0f;
  const len = f[1]! & 0x7f;
  const mask = f.subarray(2, 6);
  const payload = new Uint8Array(len);
  for (let i = 0; i < len; i++) payload[i] = f[6 + i]! ^ mask[i & 3]!;
  return { opcode, payload };
}

/** Start an upgrade and complete a valid 101 handshake, optionally with
 *  trailing bytes coalesced behind the 101 head. */
async function established(
  conn: FakeConn,
  opts: { protocolHeader?: string; req?: HttpRequest; trailing?: Uint8Array } = {},
): Promise<WsConnection> {
  const rt = fakeRuntime(conn);
  const pending = rt.upgrade(8000, opts.req ?? REQ);
  pending.catch(() => {}); // avoid unhandled-rejection noise if the test fails first
  await tick(); // tcp_probe resolves, handlers register
  conn.emit("connect");
  const accept = wsAccept(conn.sentKey());
  const head =
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    (opts.protocolHeader ? `Sec-WebSocket-Protocol: ${opts.protocolHeader}\r\n` : "") +
    "\r\n";
  const headBytes = enc(head);
  const wire = opts.trailing
    ? new Uint8Array([...headBytes, ...opts.trailing])
    : headBytes;
  conn.emit("data", wire);
  return pending;
}

describe("VmRuntime.upgrade — hermetic handshake", () => {
  it("probe-first: an unreachable port rejects with a message naming the port, no connection attempted", async () => {
    const conn = new FakeConn();
    const rt = fakeRuntime(conn, false);
    await expect(rt.upgrade(8000, REQ)).rejects.toThrow(/no server listening on port 8000/);
    expect(conn.written).toEqual([]);
  });

  it("writes a well-formed upgrade request on connect and resolves on a valid 101", async () => {
    const conn = new FakeConn();
    const ws = await established(conn);
    const sent = dec.decode(conn.written[0]!);
    expect(sent).toContain("GET /ws HTTP/1.1");
    expect(sent).toContain("Upgrade: websocket");
    expect(sent).toContain("Sec-WebSocket-Version: 13");
    expect(ws.protocol).toBe("");
  });

  it("negotiates a subprotocol offered via sec-websocket-protocol", async () => {
    const conn = new FakeConn();
    const ws = await established(conn, {
      req: { ...REQ, headers: { "sec-websocket-protocol": "chat, log" } },
      protocolHeader: "chat",
    });
    expect(ws.protocol).toBe("chat");
  });

  it("a non-101 answer rejects with the HTTP status and releases the conn", async () => {
    const conn = new FakeConn();
    const rt = fakeRuntime(conn);
    const pending = rt.upgrade(8000, REQ);
    await tick();
    conn.emit("connect");
    conn.emit("data", enc("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n"));
    await expect(pending).rejects.toThrow(/HTTP 404/);
    expect(conn.closed).toBeGreaterThan(0);
  });

  it("a wrong Sec-WebSocket-Accept rejects fail-fast", async () => {
    const conn = new FakeConn();
    const rt = fakeRuntime(conn);
    const pending = rt.upgrade(8000, REQ);
    await tick();
    conn.emit("connect");
    conn.emit("data", enc("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: bogus\r\n\r\n"));
    await expect(pending).rejects.toThrow(/bad Sec-WebSocket-Accept/);
  });

  it("a TCP close before the 101 rejects with a precise message", async () => {
    const conn = new FakeConn();
    const rt = fakeRuntime(conn);
    const pending = rt.upgrade(8000, REQ);
    await tick();
    conn.emit("connect");
    conn.emit("close");
    await expect(pending).rejects.toThrow(/closed before the handshake completed/);
  });

  it("a handshake split across data events still validates (accumulation)", async () => {
    const conn = new FakeConn();
    const rt = fakeRuntime(conn);
    const pending = rt.upgrade(8000, REQ);
    await tick();
    conn.emit("connect");
    const accept = wsAccept(conn.sentKey());
    const full = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`;
    conn.emit("data", enc(full.slice(0, 40)));
    conn.emit("data", enc(full.slice(40)));
    const ws = await pending;
    expect(ws.protocol).toBe("");
  });
});

describe("VmRuntime.upgrade — hermetic established connection", () => {
  it("delivers text and binary frames; frames coalesced behind the 101 are buffered until onMessage attaches", async () => {
    const conn = new FakeConn();
    const ws = await established(conn, { trailing: frame(OP_TEXT, enc("early")) });
    conn.emit("data", frame(OP_BINARY, new Uint8Array([1, 2])));
    // Nothing is lost: both frames arrived BEFORE the consumer attached.
    const got: Array<string | Uint8Array> = [];
    ws.onMessage((d) => got.push(d));
    expect(got).toEqual(["early", new Uint8Array([1, 2])]);
    conn.emit("data", frame(OP_TEXT, enc("live")));
    expect(got).toEqual(["early", new Uint8Array([1, 2]), "live"]);
  });

  it("send() writes masked text/binary frames the peer can unmask", async () => {
    const conn = new FakeConn();
    const ws = await established(conn);
    ws.send("hello");
    expect(lastWritten(conn)).toEqual({ opcode: OP_TEXT, payload: enc("hello") });
    ws.send(new Uint8Array([7, 8, 9]));
    expect(lastWritten(conn)).toEqual({ opcode: OP_BINARY, payload: new Uint8Array([7, 8, 9]) });
  });

  it("auto-answers a server ping with a pong echoing the payload", async () => {
    const conn = new FakeConn();
    const ws = await established(conn);
    ws.onMessage(() => {});
    const before = conn.written.length;
    conn.emit("data", frame(OP_PING, enc("beat")));
    expect(conn.written.length).toBe(before + 1);
    const pong = lastWritten(conn);
    expect(pong.opcode).toBe(0xa);
    expect(dec.decode(pong.payload)).toBe("beat");
  });

  it("server-initiated close: echoes the Close frame, fires onClose once with code+reason, releases the conn", async () => {
    const conn = new FakeConn();
    const ws = await established(conn);
    const closes: Array<[number, string]> = [];
    ws.onClose((code, reason) => closes.push([code, reason]));
    conn.emit("data", frame(OP_CLOSE, new Uint8Array([0x03, 0xe8, ...enc("bye")])));
    expect(closes).toEqual([[1000, "bye"]]);
    const echo = lastWritten(conn);
    expect(echo.opcode).toBe(OP_CLOSE);
    expect(conn.closed).toBeGreaterThan(0);
    // late TCP close must not double-fire
    conn.emit("close");
    expect(closes.length).toBe(1);
    expect(() => ws.send("nope")).toThrow(/closed/);
  });

  it("client-initiated close: writes a Close frame, completes on the server echo", async () => {
    const conn = new FakeConn();
    const ws = await established(conn);
    const closes: Array<[number, string]> = [];
    ws.onClose((code, reason) => closes.push([code, reason]));
    ws.close(1000, "done");
    const sent = lastWritten(conn);
    expect(sent.opcode).toBe(OP_CLOSE);
    expect((sent.payload[0]! << 8) | sent.payload[1]!).toBe(1000);
    expect(closes).toEqual([]); // not yet — awaiting the echo
    expect(() => ws.send("x")).toThrow(/closing/);
    conn.emit("data", frame(OP_CLOSE, new Uint8Array([0x03, 0xe8])));
    expect(closes).toEqual([[1000, ""]]);
    expect(conn.closed).toBeGreaterThan(0);
  });

  it("a TCP close without a Close frame is abnormal closure 1006, buffered for a late onClose subscriber", async () => {
    const conn = new FakeConn();
    const ws = await established(conn);
    conn.emit("close"); // guest vanished
    const closes: Array<[number, string]> = [];
    ws.onClose((code, reason) => closes.push([code, reason])); // attached AFTER the drop
    expect(closes.length).toBe(1);
    expect(closes[0]![0]).toBe(1006);
    expect(closes[0]![1]).toMatch(/without a WebSocket Close frame/);
  });

  it("a protocol violation (masked server frame) tears down with 1006 + the precise reason", async () => {
    const conn = new FakeConn();
    const ws = await established(conn);
    const closes: Array<[number, string]> = [];
    ws.onClose((code, reason) => closes.push([code, reason]));
    conn.emit("data", new Uint8Array([0x81, 0x81, 1, 2, 3, 4, 0])); // mask bit set
    expect(closes.length).toBe(1);
    expect(closes[0]![0]).toBe(1006);
    expect(closes[0]![1]).toMatch(/MASKED server frame/);
    expect(conn.closed).toBeGreaterThan(0);
  });

  it("runtime shutdown destroys live connections with a truthful cause", async () => {
    const conn = new FakeConn();
    const rt = fakeRuntime(conn);
    (rt as unknown as { booted: boolean }).booted = true; // shutdown() only tears down when booted
    (rt as unknown as { host: { destroy?: () => Promise<void> } }).host.destroy = async () => {};
    const pending = rt.upgrade(8000, REQ);
    await tick();
    conn.emit("connect");
    const accept = wsAccept(conn.sentKey());
    conn.emit("data", enc(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`));
    const ws = await pending;
    const closes: Array<[number, string]> = [];
    ws.onClose((code, reason) => closes.push([code, reason]));
    await rt.shutdown();
    expect(closes).toEqual([[1006, "runtime shutdown"]]);
    expect(conn.closed).toBeGreaterThan(0);
  });
});
