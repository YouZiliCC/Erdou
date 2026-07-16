import { describe, it, expect } from "vitest";
import { encodeFrame, encodeJsonFrame, FrameReader, decodeJson, FrameType } from "./guestd-protocol.js";

const bytes = (...n: number[]): Uint8Array => new Uint8Array(n);

describe("guestd-protocol", () => {
  it("round-trips a binary frame through the reader", () => {
    const frame = encodeFrame(FrameType.STDOUT, 7, bytes(0x00, 0xff, 0x0a, 0x41));
    const r = new FrameReader();
    const out = r.push(frame);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe("O");
    expect(out[0]!.id).toBe(7);
    expect([...out[0]!.body]).toEqual([0x00, 0xff, 0x0a, 0x41]);
  });

  it("reassembles a frame split across chunks and splits merged frames", () => {
    const a = encodeJsonFrame(FrameType.EXEC, 1, { cmd: "echo hi" });
    const b = encodeFrame(FrameType.STDOUT, 1, bytes(0x68, 0x69));
    const both = new Uint8Array(a.length + b.length);
    both.set(a, 0);
    both.set(b, a.length);
    const r = new FrameReader();
    // split at an arbitrary interior byte
    const mid = a.length + 2;
    expect(r.push(both.slice(0, mid))).toHaveLength(1); // only `a` completes
    const rest = r.push(both.slice(mid));
    expect(rest).toHaveLength(1);
    expect(rest[0]!.type).toBe("O");
    expect(decodeJson(a.subarray(9))).toEqual({ cmd: "echo hi" }); // body starts after 4+1+4 header
  });

  it("carries all byte values 0x00-0xff intact", () => {
    const payload = new Uint8Array(256).map((_, i) => i);
    const r = new FrameReader();
    const [f] = r.push(encodeFrame(FrameType.STDERR, 99, payload));
    expect([...f!.body]).toEqual([...payload]);
  });

  it("resyncs past leading garbage (implausible length) to the next valid frame", () => {
    // 6 bytes of 0xEE: any 4-byte window reads as a huge payloadLen (> MAX) → each dropped one at a time
    const garbage = new Uint8Array(6).fill(0xee);
    const valid = encodeFrame(FrameType.STDOUT, 42, bytes(0x68, 0x69)); // "hi"
    const merged = new Uint8Array(garbage.length + valid.length);
    merged.set(garbage, 0);
    merged.set(valid, garbage.length);
    const r = new FrameReader();
    const out = r.push(merged);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe("O");
    expect(out[0]!.id).toBe(42);
    expect([...out[0]!.body]).toEqual([0x68, 0x69]);
  });

  it("resyncs past a plausible-length-but-unknown-type frame header", () => {
    // payloadLen 5 (plausible), type 'Z' (not a FrameType) → treated as noise, dropped byte-by-byte
    const noise = new Uint8Array([0x00, 0x00, 0x00, 0x05, 0x5a, 0x00, 0x00, 0x00, 0x00]);
    const valid = encodeJsonFrame(FrameType.EXIT, 7, { code: 0, signal: null });
    const merged = new Uint8Array(noise.length + valid.length);
    merged.set(noise, 0);
    merged.set(valid, noise.length);
    const r = new FrameReader();
    const out = r.push(merged);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe("X");
    expect(decodeJson(out[0]!.body)).toEqual({ code: 0, signal: null });
  });

  it("accepts a minimal empty-body frame (payloadLen === MIN_PAYLOAD 5)", () => {
    const empty = encodeFrame(FrameType.READY, 0, new Uint8Array(0)); // payloadLen = 1+4+0 = 5
    const r = new FrameReader();
    const out = r.push(empty);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe("R");
    expect(out[0]!.body.length).toBe(0);
  });

  it("does NOT drop a valid large (but under-cap) frame", () => {
    // a 1000-byte body is well-formed and under MAX_PAYLOAD → must be emitted intact, not resynced away
    const big = new Uint8Array(1000).map((_, i) => i & 0xff);
    const frame = encodeFrame(FrameType.STDOUT, 5, big);
    const r = new FrameReader();
    const out = r.push(frame);
    expect(out).toHaveLength(1);
    expect(out[0]!.body.length).toBe(1000);
    expect([...out[0]!.body]).toEqual([...big]);
  });
});
