import type { HttpRequest } from "@erdou/runtime-contract";
import type { ParsedHead } from "./http-codec.js";

/**
 * RFC 6455 WebSocket CLIENT codec — the pure half of `VmRuntime.upgrade`.
 * Everything here is bytes-in/bytes-out with zero I/O so it is hermetically
 * testable; the live TcpConn wiring lives in vm-runtime.ts.
 *
 *  - handshake: build the upgrade request, validate the server's 101
 *    (Sec-WebSocket-Accept, Upgrade header, subprotocol selection);
 *  - frames: encode MASKED client frames (RFC: a client MUST mask) with
 *    7/16/64-bit lengths; incrementally parse UNMASKED server frames with
 *    fragmentation reassembly and interleaved control frames.
 *
 * Malformed input throws with a precise message (fail fast) — the caller
 * surfaces it as a connection teardown, never as silently-wrong frames.
 */

export const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// Opcodes (RFC 6455 §5.2).
export const OP_CONT = 0x0;
export const OP_TEXT = 0x1;
export const OP_BINARY = 0x2;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Dependency-free base64 (btoa is untyped on some server targets). */
export function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64[a >> 2]! + B64[((a & 3) << 4) | (b >> 4)]!;
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)]! : "=";
    out += i + 2 < bytes.length ? B64[c & 63]! : "=";
  }
  return out;
}

/** Pure-JS SHA-1 (RFC 3174) — only used for the handshake accept token, where
 *  SHA-1 is what the WebSocket protocol prescribes (not a security choice).
 *  Sync + dependency-free so the codec needs neither node:crypto nor an async
 *  crypto.subtle round-trip. */
export function sha1(data: Uint8Array): Uint8Array {
  const ml = data.length;
  // Pad to 512-bit blocks: 0x80, zeros, 64-bit big-endian bit length.
  const withOne = ml + 1;
  const padded = new Uint8Array(withOne + ((55 - ml) % 64 + 64) % 64 + 8);
  padded.set(data);
  padded[ml] = 0x80;
  const bits = ml * 8;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(bits / 2 ** 32));
  dv.setUint32(padded.length - 4, bits >>> 0);

  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Int32Array(80);
  const rol = (v: number, s: number): number => (v << s) | (v >>> (32 - s));
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getInt32(block + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rol(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (rol(a, 5) + f + e + k + w[i]!) | 0;
      e = d; d = c; c = rol(b, 30); b = a; a = t;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  const out = new Uint8Array(20);
  const ov = new DataView(out.buffer);
  ov.setInt32(0, h0); ov.setInt32(4, h1); ov.setInt32(8, h2); ov.setInt32(12, h3); ov.setInt32(16, h4);
  return out;
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

/** A fresh Sec-WebSocket-Key: 16 random bytes, base64. */
export function makeWsKey(random: (n: number) => Uint8Array = randomBytes): string {
  return base64(random(16));
}

/** The Sec-WebSocket-Accept the server must answer `key` with. */
export function wsAccept(key: string): string {
  return base64(sha1(new TextEncoder().encode(key + WS_GUID)));
}

// Headers the builder synthesizes itself — a caller-supplied copy is dropped
// so the wire request can never carry a conflicting duplicate.
const SYNTHESIZED = new Set(["upgrade", "connection", "sec-websocket-key", "sec-websocket-version"]);

/** Serialize the HTTP/1.1 upgrade request. The method is forced to GET (RFC
 *  6455 §4.1); `req.url` is the request-target; all other caller headers flow
 *  through verbatim (subprotocol offers ride in `sec-websocket-protocol`);
 *  `req.body` is ignored — an upgrade request has none. */
export function buildUpgradeRequest(req: HttpRequest, key: string): Uint8Array {
  const entries = Object.entries(req.headers).filter(([k]) => !SYNTHESIZED.has(k.toLowerCase()));
  const hasHost = entries.some(([k]) => k.toLowerCase() === "host");
  const lines = [`GET ${req.url} HTTP/1.1`];
  if (!hasHost) lines.push("Host: erdou.local");
  for (const [k, v] of entries) lines.push(`${k}: ${v}`);
  lines.push("Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Key: ${key}`, "Sec-WebSocket-Version: 13");
  return new TextEncoder().encode(lines.join("\r\n") + "\r\n\r\n");
}

/**
 * Validate the server's handshake response head against the request. Returns
 * the negotiated subprotocol (`""` when none). Throws with a precise message
 * on: a non-101 status, a missing/wrong `Upgrade` header, a wrong
 * `Sec-WebSocket-Accept`, or a server-selected subprotocol that was never
 * offered. A server that selects NO subprotocol despite offers is accepted
 * (protocol `""`) — that is the server's RFC-sanctioned prerogative.
 */
export function validateHandshake(head: ParsedHead, key: string, offered: string[]): string {
  if (head.status !== 101) {
    throw new Error(`server refused the WebSocket upgrade: HTTP ${head.status}`);
  }
  const up = (head.headers["upgrade"] ?? "").toLowerCase();
  if (up !== "websocket") {
    throw new Error(`server answered 101 without "Upgrade: websocket" (got ${JSON.stringify(head.headers["upgrade"] ?? "")})`);
  }
  const expected = wsAccept(key);
  const got = head.headers["sec-websocket-accept"] ?? "";
  if (got !== expected) {
    throw new Error(`bad Sec-WebSocket-Accept: expected ${expected}, got ${JSON.stringify(got)}`);
  }
  const chosen = (head.headers["sec-websocket-protocol"] ?? "").trim();
  if (chosen !== "" && !offered.includes(chosen)) {
    throw new Error(`server selected subprotocol ${JSON.stringify(chosen)} which was never offered (offered: ${JSON.stringify(offered)})`);
  }
  return chosen;
}

/** Encode one MASKED client frame (FIN set — the client side never fragments). */
export function encodeClientFrame(
  opcode: number,
  payload: Uint8Array,
  mask: Uint8Array = randomBytes(4),
): Uint8Array {
  if (mask.length !== 4) throw new Error(`encodeClientFrame: mask must be 4 bytes, got ${mask.length}`);
  const n = payload.length;
  const extra = n < 126 ? 0 : n <= 0xffff ? 2 : 8;
  const out = new Uint8Array(2 + extra + 4 + n);
  out[0] = 0x80 | (opcode & 0x0f); // FIN + opcode
  const dv = new DataView(out.buffer);
  if (extra === 0) out[1] = 0x80 | n;
  else if (extra === 2) { out[1] = 0x80 | 126; dv.setUint16(2, n); }
  else {
    out[1] = 0x80 | 127;
    dv.setUint32(2, Math.floor(n / 2 ** 32));
    dv.setUint32(6, n >>> 0);
  }
  out.set(mask, 2 + extra);
  const off = 2 + extra + 4;
  for (let i = 0; i < n; i++) out[off + i] = payload[i]! ^ mask[i & 3]!;
  return out;
}

export function encodeText(text: string, mask?: Uint8Array): Uint8Array {
  return encodeClientFrame(OP_TEXT, new TextEncoder().encode(text), mask);
}

export function encodeBinary(data: Uint8Array, mask?: Uint8Array): Uint8Array {
  return encodeClientFrame(OP_BINARY, data, mask);
}

export function encodePong(payload: Uint8Array, mask?: Uint8Array): Uint8Array {
  return encodeClientFrame(OP_PONG, payload, mask);
}

/** Close frame: empty payload when `code` is undefined (the peer reads that as
 *  1005 "no status"), else 2-byte big-endian code + UTF-8 reason. */
export function encodeClose(code?: number, reason = "", mask?: Uint8Array): Uint8Array {
  if (code === undefined) return encodeClientFrame(OP_CLOSE, new Uint8Array(), mask);
  const text = new TextEncoder().encode(reason);
  const payload = new Uint8Array(2 + text.length);
  new DataView(payload.buffer).setUint16(0, code);
  payload.set(text, 2);
  return encodeClientFrame(OP_CLOSE, payload, mask);
}

/** A fully-reassembled incoming event, ready for the connection layer. */
export type WsEvent =
  | { type: "text"; data: string }
  | { type: "binary"; data: Uint8Array }
  | { type: "ping"; payload: Uint8Array }
  | { type: "pong"; payload: Uint8Array }
  | { type: "close"; code: number; reason: string };

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Incremental parser for SERVER→client frames. Feed TCP bytes as they arrive
 * (split or coalesced arbitrarily); each `push` returns the events completed
 * by those bytes. Handles fragmentation (a TEXT/BINARY start frame with FIN=0,
 * CONT frames, control frames interleaved between fragments) and rejects
 * protocol violations with a thrown Error: RSV bits set (no extension was
 * negotiated), a MASKED server frame, an unknown opcode, a fragmented or
 * oversized control frame, a CONT without a started message, a new data frame
 * while one is still fragmented, or invalid UTF-8 in a text message.
 */
export class WsFrameParser {
  private buf = new Uint8Array(0);
  /** In-progress fragmented message: first frame's opcode + collected parts. */
  private fragOp: number | null = null;
  private fragParts: Uint8Array[] = [];

  push(bytes: Uint8Array): WsEvent[] {
    this.buf = this.buf.length === 0 ? bytes.slice() : concat(this.buf, bytes);
    const events: WsEvent[] = [];
    for (;;) {
      const frame = this.tryReadFrame();
      if (!frame) return events;
      const ev = this.consume(frame.fin, frame.opcode, frame.payload);
      if (ev) events.push(ev);
    }
  }

  /** Parse one wire frame off the buffer, or null while incomplete. */
  private tryReadFrame(): { fin: boolean; opcode: number; payload: Uint8Array } | null {
    const b = this.buf;
    if (b.length < 2) return null;
    const b0 = b[0]!;
    const b1 = b[1]!;
    if ((b0 & 0x70) !== 0) throw new Error(`WsFrameParser: RSV bits set (0x${b0.toString(16)}) but no extension was negotiated`);
    if ((b1 & 0x80) !== 0) throw new Error("WsFrameParser: received a MASKED server frame (RFC 6455: a server must not mask)");
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = (b[2]! << 8) | b[3]!;
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const dv = new DataView(b.buffer, b.byteOffset);
      const hi = dv.getUint32(2);
      const lo = dv.getUint32(6);
      len = hi * 2 ** 32 + lo;
      if (!Number.isSafeInteger(len)) throw new Error(`WsFrameParser: 64-bit frame length out of range (${hi}/${lo})`);
      off = 10;
    }
    if (b.length < off + len) return null;
    const payload = b.slice(off, off + len);
    this.buf = this.buf.subarray(off + len);
    return { fin, opcode, payload };
  }

  /** Apply one frame to the fragmentation state; return a completed event. */
  private consume(fin: boolean, opcode: number, payload: Uint8Array): WsEvent | null {
    if (opcode === OP_CLOSE || opcode === OP_PING || opcode === OP_PONG) {
      if (!fin) throw new Error(`WsFrameParser: fragmented control frame (opcode ${opcode})`);
      if (payload.length > 125) throw new Error(`WsFrameParser: control frame payload ${payload.length} > 125`);
      if (opcode === OP_PING) return { type: "ping", payload };
      if (opcode === OP_PONG) return { type: "pong", payload };
      if (payload.length === 1) throw new Error("WsFrameParser: close frame with a 1-byte payload");
      const code = payload.length >= 2 ? (payload[0]! << 8) | payload[1]! : 1005;
      return { type: "close", code, reason: utf8.decode(payload.subarray(2)) };
    }
    if (opcode === OP_TEXT || opcode === OP_BINARY) {
      if (this.fragOp !== null) throw new Error("WsFrameParser: new data frame while a fragmented message is in progress");
      if (fin) return this.complete(opcode, payload);
      this.fragOp = opcode;
      this.fragParts = [payload];
      return null;
    }
    if (opcode === OP_CONT) {
      if (this.fragOp === null) throw new Error("WsFrameParser: continuation frame without a started message");
      this.fragParts.push(payload);
      if (!fin) return null;
      const whole = this.fragParts.reduce((acc, p) => concat(acc, p), new Uint8Array(0));
      const op = this.fragOp;
      this.fragOp = null;
      this.fragParts = [];
      return this.complete(op, whole);
    }
    throw new Error(`WsFrameParser: unknown opcode ${opcode}`);
  }

  private complete(opcode: number, payload: Uint8Array): WsEvent {
    return opcode === OP_TEXT ? { type: "text", data: utf8.decode(payload) } : { type: "binary", data: payload };
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
