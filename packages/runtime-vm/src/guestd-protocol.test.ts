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
});
