import { describe, it, expect } from "vitest";
import { wirePtyTerminal, type PtySessionLike, type TermLike } from "./pty-terminal-wiring.js";

const text = (chunks: Uint8Array[]) => chunks.map((b) => new TextDecoder().decode(b));
// then/catch chain settles within microtasks; a macrotask outlasts all of them.
const settle = () => new Promise<void>((res) => setTimeout(res, 0));

/** Hand-rolled stand-in for xterm's Terminal: records write()s and lets tests
 *  fire the user-input / resize events the real terminal would emit. Like the
 *  real thing, `resize` mutates cols/rows AND emits onResize — a FitAddon
 *  fit() while nothing listens yet still changes the terminal's dimensions. */
function makeFakeTerm() {
  const dataCbs: Array<(data: string) => void> = [];
  const resizeCbs: Array<(size: { cols: number; rows: number }) => void> = [];
  const writes: Array<string | Uint8Array> = [];
  const size = { cols: 80, rows: 24 };
  const term: TermLike = {
    get cols() { return size.cols; },
    get rows() { return size.rows; },
    onData: (cb) => { dataCbs.push(cb); },
    onResize: (cb) => { resizeCbs.push(cb); },
    write: (d) => { writes.push(d); },
  };
  return {
    term,
    writes,
    type: (s: string) => { for (const cb of dataCbs) cb(s); },
    resize: (cols: number, rows: number) => {
      size.cols = cols;
      size.rows = rows;
      for (const cb of resizeCbs) cb({ cols, rows });
    },
  };
}

/** Fake PtySession. `echo: true` makes write() synchronously feed the bytes back
 *  through onData — like a real pty echoing keystrokes the instant they arrive. */
function makeFakeSession(opts: { echo?: boolean } = {}) {
  const written: Uint8Array[] = [];
  const resizes: Array<[number, number]> = [];
  let onDataCb: ((d: Uint8Array) => void) | undefined;
  let disposeCount = 0;
  const session: PtySessionLike = {
    write: (b) => {
      written.push(b);
      if (opts.echo) onDataCb?.(b);
    },
    onData: (cb) => { onDataCb = cb; },
    resize: (cols, rows) => { resizes.push([cols, rows]); },
    dispose: () => { disposeCount += 1; return Promise.resolve(); },
  };
  return { session, written, resizes, disposeCount: () => disposeCount };
}

function deferredOpen() {
  let resolve: (s: PtySessionLike) => void = () => {};
  let reject: (err: unknown) => void = () => {};
  const promise = new Promise<PtySessionLike>((res, rej) => { resolve = res; reject = rej; });
  const calls: Array<{ cols: number; rows: number }> = [];
  return {
    openPty: (opts: { cols: number; rows: number }) => { calls.push(opts); return promise; },
    resolve,
    reject,
    calls,
  };
}

describe("wirePtyTerminal", () => {
  // FU1 regression: term.onData must be attached AT MOUNT, before openPty
  // resolves — xterm buffers nothing, so a then-time attach drops these bytes.
  it("delivers keystrokes typed before openPty resolves to the session, in order", async () => {
    const { term, type } = makeFakeTerm();
    const { openPty, resolve } = deferredOpen();
    wirePtyTerminal(term, openPty);
    type("ls");
    type("\r");
    const fake = makeFakeSession();
    resolve(fake.session);
    await settle();
    expect(text(fake.written)).toEqual(["ls", "\r"]);
    type("pwd"); // post-open input goes straight through
    expect(text(fake.written)).toEqual(["ls", "\r", "pwd"]);
  });

  it("wires session output before flushing queued input, so immediate echoes render", async () => {
    const { term, type, writes } = makeFakeTerm();
    const { openPty, resolve } = deferredOpen();
    wirePtyTerminal(term, openPty);
    type("x");
    const fake = makeFakeSession({ echo: true }); // flush write → synchronous echo
    resolve(fake.session);
    await settle();
    const echoed = writes.filter((w): w is Uint8Array => typeof w !== "string");
    expect(text(echoed)).toEqual(["x"]);
  });

  it("writes the connecting hint at mount and erases it when openPty resolves", async () => {
    const { term, writes } = makeFakeTerm();
    const { openPty, resolve } = deferredOpen();
    wirePtyTerminal(term, openPty);
    expect(writes).toEqual(["\x1b[2mconnecting…\x1b[0m"]);
    resolve(makeFakeSession().session);
    await settle();
    expect(writes[1]).toBe("\r\x1b[2K");
  });

  it("openPty rejection drops queued keystrokes and writes the error line once", async () => {
    const { term, type, writes } = makeFakeTerm();
    const { openPty, reject } = deferredOpen();
    wirePtyTerminal(term, openPty);
    type("doomed");
    reject(new Error("boom"));
    await settle();
    const errorLines = writes.filter((w) => typeof w === "string" && w.includes("[pty error]"));
    expect(errorLines).toEqual(["\r\x1b[2K[pty error] Error: boom\r\n"]);
  });

  it("writes nothing when the rejection lands after cleanup", async () => {
    const { term, writes } = makeFakeTerm();
    const { openPty, reject } = deferredOpen();
    const cleanup = wirePtyTerminal(term, openPty);
    const before = writes.length;
    cleanup();
    reject(new Error("boom"));
    await settle();
    expect(writes.length).toBe(before);
  });

  it("cleanup before resolve disposes the late session and flushes nothing", async () => {
    const { term, type, writes } = makeFakeTerm();
    const { openPty, resolve } = deferredOpen();
    const cleanup = wirePtyTerminal(term, openPty);
    type("q");
    cleanup();
    const fake = makeFakeSession();
    resolve(fake.session);
    await settle();
    expect(fake.disposeCount()).toBe(1);
    expect(fake.written).toEqual([]);
    expect(writes).toEqual(["\x1b[2mconnecting…\x1b[0m"]); // no erase after dispose
  });

  // D3: the pty must open at the terminal's CURRENT (fitted) dimensions, not a
  // hardcoded 80x24 — the component fit()s before wiring.
  it("opens the pty with the terminal's current cols/rows", () => {
    const { term, resize } = makeFakeTerm();
    const { openPty, calls } = deferredOpen();
    resize(132, 43); // the component's mount-time fit(), before wiring
    wirePtyTerminal(term, openPty);
    expect(calls).toEqual([{ cols: 132, rows: 43 }]);
  });

  // D3: a fit() while openPty is in flight (hidden tab shown mid-connect)
  // resizes xterm before any onResize listener exists — the wiring must sync
  // the session to the terminal's current size once it opens.
  it("syncs a resize that landed during openPty to the session after it opens", async () => {
    const { term, resize } = makeFakeTerm();
    const { openPty, resolve } = deferredOpen();
    wirePtyTerminal(term, openPty); // opened at 80x24
    resize(120, 40); // no listener attached yet — mutates dims only
    const fake = makeFakeSession();
    resolve(fake.session);
    await settle();
    expect(fake.resizes).toEqual([[120, 40]]);
  });

  it("propagates resize to the session; cleanup after resolve disposes it and stops input", async () => {
    const { term, type, resize } = makeFakeTerm();
    const { openPty, resolve } = deferredOpen();
    const cleanup = wirePtyTerminal(term, openPty);
    const fake = makeFakeSession();
    resolve(fake.session);
    await settle();
    resize(100, 30);
    expect(fake.resizes).toEqual([[100, 30]]);
    cleanup();
    expect(fake.disposeCount()).toBe(1);
    type("late");
    expect(fake.written).toEqual([]);
  });
});
