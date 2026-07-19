import { describe, it, expect } from "vitest";
import {
  base64, sha1, makeWsKey, wsAccept, buildUpgradeRequest, validateHandshake,
  encodeClientFrame, encodeText, encodeBinary, encodeClose, encodePong,
  WsFrameParser, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_CONT,
} from "./ws-codec.js";
import { parseHead } from "./http-codec.js";
import type { HttpRequest } from "@erdou/runtime-contract";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = new TextDecoder();

/** Build an UNMASKED server frame (what the parser consumes). */
function serverFrame(opcode: number, payload: Uint8Array, fin = true): Uint8Array {
  const n = payload.length;
  const extra = n < 126 ? 0 : n <= 0xffff ? 2 : 8;
  const out = new Uint8Array(2 + extra + n);
  out[0] = (fin ? 0x80 : 0) | opcode;
  const dv = new DataView(out.buffer);
  if (extra === 0) out[1] = n;
  else if (extra === 2) { out[1] = 126; dv.setUint16(2, n); }
  else { out[1] = 127; dv.setUint32(2, 0); dv.setUint32(6, n); }
  out.set(payload, 2 + extra);
  return out;
}

/** Unmask a client frame back to its payload (asserting the mask bit is set). */
function unmaskClientFrame(frame: Uint8Array): { opcode: number; fin: boolean; payload: Uint8Array } {
  const fin = (frame[0]! & 0x80) !== 0;
  const opcode = frame[0]! & 0x0f;
  expect(frame[1]! & 0x80, "client frame must be masked").toBe(0x80);
  let len = frame[1]! & 0x7f;
  let off = 2;
  const dv = new DataView(frame.buffer, frame.byteOffset);
  if (len === 126) { len = dv.getUint16(2); off = 4; }
  else if (len === 127) { len = dv.getUint32(2) * 2 ** 32 + dv.getUint32(6); off = 10; }
  const mask = frame.subarray(off, off + 4);
  const body = frame.subarray(off + 4, off + 4 + len);
  const payload = new Uint8Array(len);
  for (let i = 0; i < len; i++) payload[i] = body[i]! ^ mask[i & 3]!;
  return { opcode, fin, payload };
}

describe("ws-codec: handshake", () => {
  it("wsAccept matches the RFC 6455 §1.3 worked example", () => {
    expect(wsAccept("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  it("sha1/base64 match a known vector", () => {
    // sha1("abc") = a9993e364706816aba3e25717850c26c9cd0d89d
    const digest = sha1(enc("abc"));
    expect([...digest].map((b) => b.toString(16).padStart(2, "0")).join("")).toBe(
      "a9993e364706816aba3e25717850c26c9cd0d89d",
    );
    expect(base64(enc("hello"))).toBe("aGVsbG8=");
    expect(base64(enc("hi"))).toBe("aGk=");
    expect(base64(new Uint8Array())).toBe("");
  });

  it("makeWsKey is 16 bytes base64 (24 chars, deterministic under an injected RNG)", () => {
    const key = makeWsKey((n) => new Uint8Array(n).fill(7));
    expect(key).toBe(base64(new Uint8Array(16).fill(7)));
    expect(key.length).toBe(24);
  });

  it("buildUpgradeRequest forces GET, synthesizes the upgrade headers once, and passes others through", () => {
    const req: HttpRequest = {
      method: "POST", // forced to GET
      url: "/ws?room=1",
      headers: {
        cookie: "a=1",
        "sec-websocket-protocol": "chat, log",
        Connection: "keep-alive", // synthesized — the caller's copy is dropped
      },
      body: enc("ignored"),
    };
    const text = dec.decode(buildUpgradeRequest(req, "KEY123"));
    expect(text.startsWith("GET /ws?room=1 HTTP/1.1\r\n")).toBe(true);
    expect(text).toContain("Host: erdou.local\r\n");
    expect(text).toContain("cookie: a=1\r\n");
    expect(text).toContain("sec-websocket-protocol: chat, log\r\n");
    expect(text).toContain("Upgrade: websocket\r\n");
    expect(text).toContain("Sec-WebSocket-Key: KEY123\r\n");
    expect(text).toContain("Sec-WebSocket-Version: 13\r\n");
    expect(text.match(/Connection/gi)?.length).toBe(1); // no duplicate
    expect(text).not.toContain("keep-alive");
    expect(text.endsWith("\r\n\r\n")).toBe(true);
    expect(text).not.toContain("ignored"); // body never serialized
  });

  it("validateHandshake accepts a correct 101 and returns the negotiated protocol", () => {
    const key = "dGhlIHNhbXBsZSBub25jZQ==";
    const head = parseHead(enc(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${wsAccept(key)}\r\nSec-WebSocket-Protocol: chat\r\n\r\n`,
    ))!;
    expect(validateHandshake(head, key, ["chat", "log"])).toBe("chat");
  });

  it("rejects non-101 / missing Upgrade / wrong accept / unoffered protocol — each with a precise message", () => {
    const key = "dGhlIHNhbXBsZSBub25jZQ==";
    const head = (s: string) => parseHead(enc(s))!;
    expect(() => validateHandshake(head("HTTP/1.1 200 OK\r\n\r\n"), key, []))
      .toThrow(/refused the WebSocket upgrade: HTTP 200/);
    expect(() => validateHandshake(
      head(`HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`), key, [],
    )).toThrow(/without "Upgrade: websocket"/);
    expect(() => validateHandshake(
      head("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: nope\r\n\r\n"), key, [],
    )).toThrow(/bad Sec-WebSocket-Accept/);
    expect(() => validateHandshake(
      head(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${wsAccept(key)}\r\nSec-WebSocket-Protocol: evil\r\n\r\n`),
      key, ["chat"],
    )).toThrow(/never offered/);
  });
});

describe("ws-codec: client frame encoding", () => {
  const MASK = new Uint8Array([1, 2, 3, 4]);

  it("encodes a masked text frame (7-bit length) that unmasks back to the payload", () => {
    const f = encodeText("hello", MASK);
    const { opcode, fin, payload } = unmaskClientFrame(f);
    expect(fin).toBe(true);
    expect(opcode).toBe(OP_TEXT);
    expect(dec.decode(payload)).toBe("hello");
    expect(f.length).toBe(2 + 4 + 5);
  });

  it("uses the 16-bit extended length for 126..65535-byte payloads", () => {
    const body = new Uint8Array(300).fill(0xab);
    const f = encodeBinary(body, MASK);
    expect(f[1]! & 0x7f).toBe(126);
    const { opcode, payload } = unmaskClientFrame(f);
    expect(opcode).toBe(OP_BINARY);
    expect(payload).toEqual(body);
  });

  it("uses the 64-bit extended length past 65535 bytes", () => {
    const body = new Uint8Array(70_000).fill(3);
    const f = encodeBinary(body, MASK);
    expect(f[1]! & 0x7f).toBe(127);
    const { payload } = unmaskClientFrame(f);
    expect(payload.length).toBe(70_000);
    expect(payload[69_999]).toBe(3);
  });

  it("encodes close frames: empty without a code, code+reason otherwise", () => {
    expect(unmaskClientFrame(encodeClose(undefined, "", MASK)).payload.length).toBe(0);
    const { opcode, payload } = unmaskClientFrame(encodeClose(1000, "bye", MASK));
    expect(opcode).toBe(OP_CLOSE);
    expect((payload[0]! << 8) | payload[1]!).toBe(1000);
    expect(dec.decode(payload.subarray(2))).toBe("bye");
  });

  it("pong echoes the ping payload; a bad mask length fails fast", () => {
    const { payload } = unmaskClientFrame(encodePong(enc("pp"), MASK));
    expect(dec.decode(payload)).toBe("pp");
    expect(() => encodeClientFrame(OP_TEXT, enc("x"), new Uint8Array(3))).toThrow(/mask must be 4 bytes/);
  });
});

describe("ws-codec: server frame parser", () => {
  it("parses text and binary frames, split or coalesced arbitrarily", () => {
    const p = new WsFrameParser();
    const wire = new Uint8Array([
      ...serverFrame(OP_TEXT, enc("one")),
      ...serverFrame(OP_BINARY, new Uint8Array([9, 8, 7])),
    ]);
    // byte-by-byte: no event until a frame completes, all events in order
    const events = [];
    for (const b of wire) events.push(...p.push(new Uint8Array([b])));
    expect(events).toEqual([
      { type: "text", data: "one" },
      { type: "binary", data: new Uint8Array([9, 8, 7]) },
    ]);
    // coalesced in one push
    expect(new WsFrameParser().push(wire).length).toBe(2);
  });

  it("parses 16-bit and 64-bit lengths", () => {
    const big = new Uint8Array(70_000).fill(5);
    const p = new WsFrameParser();
    const evs = p.push(new Uint8Array([
      ...serverFrame(OP_BINARY, new Uint8Array(300).fill(1)),
      ...serverFrame(OP_BINARY, big),
    ]));
    expect(evs.length).toBe(2);
    expect(evs[0]).toMatchObject({ type: "binary" });
    expect((evs[1] as { data: Uint8Array }).data.length).toBe(70_000);
  });

  it("reassembles a fragmented text message with an interleaved control frame", () => {
    const p = new WsFrameParser();
    expect(p.push(serverFrame(OP_TEXT, enc("hel"), false))).toEqual([]);
    // control frames may interleave between fragments (RFC 6455 §5.4)
    expect(p.push(serverFrame(OP_PING, enc("k")))).toEqual([{ type: "ping", payload: enc("k") }]);
    expect(p.push(serverFrame(OP_CONT, enc("lo"), false))).toEqual([]);
    expect(p.push(serverFrame(OP_CONT, enc("!")))).toEqual([{ type: "text", data: "hello!" }]);
  });

  it("parses close frames: code+reason, and bare close as 1005", () => {
    const payload = new Uint8Array([0x03, 0xe8, ...enc("done")]); // 1000 "done"
    expect(new WsFrameParser().push(serverFrame(OP_CLOSE, payload)))
      .toEqual([{ type: "close", code: 1000, reason: "done" }]);
    expect(new WsFrameParser().push(serverFrame(OP_CLOSE, new Uint8Array())))
      .toEqual([{ type: "close", code: 1005, reason: "" }]);
  });

  it("fails fast on protocol violations, each with a precise message", () => {
    expect(() => new WsFrameParser().push(new Uint8Array([0xc1, 0x00]))).toThrow(/RSV bits/);
    expect(() => new WsFrameParser().push(new Uint8Array([0x81, 0x81, 1, 2, 3, 4, 0]))).toThrow(/MASKED server frame/);
    expect(() => new WsFrameParser().push(serverFrame(0x3, enc("x")))).toThrow(/unknown opcode/);
    expect(() => new WsFrameParser().push(serverFrame(OP_PING, enc("x"), false))).toThrow(/fragmented control frame/);
    expect(() => new WsFrameParser().push(serverFrame(OP_CONT, enc("x")))).toThrow(/continuation frame without/);
    const p = new WsFrameParser();
    p.push(serverFrame(OP_TEXT, enc("a"), false));
    expect(() => p.push(serverFrame(OP_TEXT, enc("b")))).toThrow(/while a fragmented message is in progress/);
    expect(() => new WsFrameParser().push(serverFrame(OP_CLOSE, new Uint8Array([0x03])))).toThrow(/1-byte payload/);
    expect(() => new WsFrameParser().push(serverFrame(OP_TEXT, new Uint8Array([0xff, 0xfe])))).toThrow(); // invalid UTF-8
  });

  it("round-trips: what encodeClientFrame masks, an unmasking peer reads back", () => {
    // Sanity: our own masked frames carry the intended bytes (the guest server
    // side of the e2e does exactly this unmasking).
    const body = new Uint8Array(200).map((_, i) => i % 251);
    const { payload } = unmaskClientFrame(encodeBinary(body));
    expect(payload).toEqual(body);
  });
});
