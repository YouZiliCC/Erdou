import { describe, it, expect, vi } from "vitest";
import { openPtySession, type PtyChannel } from "./pty.js";

function fakeChannel(): PtyChannel & { sent: Uint8Array[]; emit: (b: Uint8Array) => void; resizes: [number, number][] } {
  let cb: (b: Uint8Array) => void = () => {};
  const sent: Uint8Array[] = []; const resizes: [number, number][] = [];
  return {
    sent, resizes,
    send: (b) => sent.push(b),
    subscribe: (fn) => { cb = fn; },
    resize: (c, r) => resizes.push([c, r]),
    emit: (b) => cb(b),
  };
}

const enc = new TextEncoder();

describe("openPtySession", () => {
  it("subscribes before launch, buffers writes until READY, streams onData, resize passes through", async () => {
    const ch = fakeChannel();
    const kill = vi.fn(async () => {});
    const launch = vi.fn(async () => ({ pid: 99 }));
    const sessionP = openPtySession(ch, launch, kill, { deadlineMs: 10_000 });
    expect(launch).toHaveBeenCalled();        // launch fired (after subscribe, which happened synchronously)
    ch.emit(enc.encode("PTYBRIDGE_READY\n"));  // the banner we could only catch by subscribing first
    const session = await sessionP;

    const got: Uint8Array[] = [];
    session.onData((d) => got.push(d));
    ch.emit(enc.encode("$ "));
    expect(new TextDecoder().decode(got[0]!)).toBe("$ ");

    session.write(enc.encode("ls\n"));
    expect(ch.sent.length).toBe(1);
    session.resize(80, 24);
    expect(ch.resizes.at(-1)).toEqual([80, 24]);

    await session.dispose();
    expect(kill).toHaveBeenCalledWith(99);
  });

  it("holds data that shares the READY chunk until onData registers (no first-prompt loss)", async () => {
    const ch = fakeChannel();
    const sessionP = openPtySession(ch, async () => ({ pid: 1 }), async () => {}, { deadlineMs: 10_000 });
    ch.emit(enc.encode("PTYBRIDGE_READY\n$ "));   // banner AND the first prompt in one chunk
    const session = await sessionP;
    const got: Uint8Array[] = [];
    session.onData((d) => got.push(d));            // registered AFTER the chunk arrived
    expect(new TextDecoder().decode(got[0] ?? new Uint8Array())).toBe("$ ");
  });

  it("rejects if PTYBRIDGE_READY never arrives (deadline)", async () => {
    const ch = fakeChannel();
    await expect(openPtySession(ch, async () => ({ pid: 1 }), async () => {}, { deadlineMs: 30 }))
      .rejects.toThrow(/PTYBRIDGE_READY/);
  });

  it("calls kill(pid) when deadline fires after launch resolves", async () => {
    const ch = fakeChannel();
    const kill = vi.fn(async () => {});
    // launch resolves with pid=42, but READY never arrives and deadline fires
    await expect(openPtySession(ch, async () => ({ pid: 42 }), kill, { deadlineMs: 30 }))
      .rejects.toThrow(/PTYBRIDGE_READY/);
    // assert kill(42) was called to reap the orphaned bridge
    expect(kill).toHaveBeenCalledWith(42);
  });
});
