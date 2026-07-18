import { describe, it, expect } from "vitest";
import { reducePreviewSelection, isBundleRun, type PreviewSelectionState } from "./preview-select.js";

const state = (over: Partial<PreviewSelectionState> = {}): PreviewSelectionState => ({
  selected: null,
  pendingPort: null,
  handledNonce: 0,
  ...over,
});

describe("reducePreviewSelection — agent requests (open_preview)", () => {
  it("selects the requested port when it is already open — even over a user's live selection", () => {
    const next = reducePreviewSelection(state({ selected: 8080 }), { port: 3000, nonce: 1 }, [8080, 3000], [8080, 3000]);
    expect(next).toEqual({ selected: 3000, pendingPort: null, handledNonce: 1 });
  });

  it("a request that beats port.opened goes pending and keeps the current view; the port opening fulfills it", () => {
    // open_preview(3000) lands before port.opened(3000)'s async delivery.
    const afterRequest = reducePreviewSelection(state({ selected: 8080 }), { port: 3000, nonce: 1 }, [8080], [8080]);
    expect(afterRequest).toEqual({ selected: 8080, pendingPort: 3000, handledNonce: 1 });
    // The port arrives -> selected, pending cleared. Nonce unchanged: not re-applied.
    const afterOpen = reducePreviewSelection(afterRequest, { port: 3000, nonce: 1 }, [8080, 3000], [8080]);
    expect(afterOpen).toEqual({ selected: 3000, pendingPort: null, handledNonce: 1 });
  });

  it("an already-handled nonce is never re-applied (re-renders can't re-yank)", () => {
    const s = state({ selected: 8080, handledNonce: 1 });
    // User has since moved on; the old request must not fire again.
    const next = reducePreviewSelection(s, { port: 3000, nonce: 1 }, [8080, 3000], [8080, 3000]);
    expect(next.selected).toBe(8080);
  });

  it("port:null selects the most recently opened port", () => {
    const next = reducePreviewSelection(state({ selected: 8080 }), { port: null, nonce: 2 }, [8080, 3000, 5173], [8080, 3000, 5173]);
    expect(next.selected).toBe(5173);
    expect(next.pendingPort).toBeNull();
  });

  it("port:null with nothing open changes nothing (but marks the nonce handled)", () => {
    const next = reducePreviewSelection(state(), { port: null, nonce: 3 }, [], []);
    expect(next).toEqual({ selected: null, pendingPort: null, handledNonce: 3 });
  });
});

describe("reducePreviewSelection — agent-primary default (no request)", () => {
  it("a newly opened port fills an empty view", () => {
    const next = reducePreviewSelection(state(), null, [3000], []);
    expect(next.selected).toBe(3000);
  });

  it("picks the LATEST of several newly opened ports (a dev server + its HMR sibling)", () => {
    const next = reducePreviewSelection(state(), null, [5173, 5174], []);
    expect(next.selected).toBe(5174);
  });

  it("never yanks a user's selection off a still-open port", () => {
    const next = reducePreviewSelection(state({ selected: 8080 }), null, [8080, 3000], [8080]);
    expect(next.selected).toBe(8080);
  });

  it("replaces a STALE selection (its port closed) when a new port opens", () => {
    const next = reducePreviewSelection(state({ selected: 8080 }), null, [3000], [8080]);
    expect(next.selected).toBe(3000);
  });

  it("a port merely closing selects nothing new (stopping the viewed port leaves the view empty)", () => {
    const next = reducePreviewSelection(state({ selected: 8080 }), null, [3000], [8080, 3000]);
    // 3000 is open but not NEW — the stale selection stays (renders as nothing).
    expect(next.selected).toBe(8080);
  });

  it("a pending request survives an unrelated port opening and still wins when its port arrives", () => {
    const s = state({ pendingPort: 3000, handledNonce: 1 });
    const mid = reducePreviewSelection(s, { port: 3000, nonce: 1 }, [5174], []);
    expect(mid.selected).toBe(5174); // fills the empty view meanwhile
    expect(mid.pendingPort).toBe(3000);
    const done = reducePreviewSelection(mid, { port: 3000, nonce: 1 }, [5174, 3000], [5174]);
    expect(done.selected).toBe(3000);
    expect(done.pendingPort).toBeNull();
  });
});

describe("isBundleRun", () => {
  it("bundles when the field is empty and a bundle entry exists", () => {
    expect(isBundleRun("", null, true)).toBe(true);
    expect(isBundleRun("   ", null, true)).toBe(true);
  });

  it("bundles when the field still holds the auto-detected prefill (passive help, not a decision)", () => {
    expect(isBundleRun("erdou serve / --spa", "erdou serve / --spa", true)).toBe(true);
  });

  it("a user-typed command always wins", () => {
    expect(isBundleRun("python app.py", "erdou serve / --spa", true)).toBe(false);
  });

  it("never bundles without a bundle entry", () => {
    expect(isBundleRun("", null, false)).toBe(false);
    expect(isBundleRun("erdou serve / --spa", "erdou serve / --spa", false)).toBe(false);
  });
});
