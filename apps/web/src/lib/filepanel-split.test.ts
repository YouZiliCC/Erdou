import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  clampSplit,
  splitForDrag,
  loadSplit,
  saveSplit,
  DEFAULT_SPLIT,
  SPLIT_MIN,
  SPLIT_MAX,
  TREE_MIN,
  VIEWER_MIN,
} from "./filepanel-split.js";

/** Minimal in-memory localStorage — this (node) test env has none by default. */
function makeLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  } as Storage;
}

const KEY = "erdou:filepanel-split";

describe("clampSplit", () => {
  it("passes an in-range ratio through", () => {
    expect(clampSplit(0.5)).toBe(0.5);
    expect(clampSplit(SPLIT_MIN)).toBe(SPLIT_MIN);
    expect(clampSplit(SPLIT_MAX)).toBe(SPLIT_MAX);
  });

  it("clamps out-of-range ratios to the static bounds", () => {
    expect(clampSplit(0)).toBe(SPLIT_MIN);
    expect(clampSplit(-3)).toBe(SPLIT_MIN);
    expect(clampSplit(1)).toBe(SPLIT_MAX);
    expect(clampSplit(99)).toBe(SPLIT_MAX);
  });

  it("falls back to DEFAULT_SPLIT for non-numeric / non-finite garbage", () => {
    expect(clampSplit("0.5")).toBe(DEFAULT_SPLIT);
    expect(clampSplit(NaN)).toBe(DEFAULT_SPLIT);
    expect(clampSplit(Infinity)).toBe(DEFAULT_SPLIT);
    expect(clampSplit(null)).toBe(DEFAULT_SPLIT);
    expect(clampSplit(undefined)).toBe(DEFAULT_SPLIT);
    expect(clampSplit({})).toBe(DEFAULT_SPLIT);
  });
});

describe("splitForDrag", () => {
  it("maps an unconstrained pointer position straight to its ratio", () => {
    expect(splitForDrag(200, 400)).toBe(0.5);
  });

  it("enforces the tree pixel floor on a short body", () => {
    // 400px body: 15% would be 60px < TREE_MIN(80), so the px floor bites.
    expect(splitForDrag(40, 400)).toBe(TREE_MIN / 400); // 0.2
  });

  it("enforces the viewer pixel floor on a short body", () => {
    // Dragging to the bottom of a 400px body leaves the viewer VIEWER_MIN px.
    expect(splitForDrag(380, 400)).toBe((400 - VIEWER_MIN) / 400); // 0.725
  });

  it("enforces the static ratio bounds on a tall body (they outbite the px floors)", () => {
    // 1000px body: px floors (80/110) are weaker than the 15%/85% ratio bounds.
    expect(splitForDrag(100, 1000)).toBe(SPLIT_MIN);
    expect(splitForDrag(950, 1000)).toBe(SPLIT_MAX);
  });

  it("lets the tree floor win when the body cannot grant both px floors", () => {
    // 150px body: maxTree = 150-110 = 40 < TREE_MIN, so the tree keeps its 80px.
    expect(splitForDrag(75, 150)).toBe(TREE_MIN / 150);
  });

  it("yields DEFAULT_SPLIT for a degenerate body height instead of NaN", () => {
    expect(splitForDrag(100, 0)).toBe(DEFAULT_SPLIT);
    expect(splitForDrag(100, -5)).toBe(DEFAULT_SPLIT);
    expect(splitForDrag(100, NaN)).toBe(DEFAULT_SPLIT);
  });
});

describe("split persistence", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", makeLocalStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns DEFAULT_SPLIT when nothing is stored", () => {
    expect(loadSplit()).toBe(DEFAULT_SPLIT);
  });

  it("round-trips a valid saved ratio", () => {
    saveSplit(0.33);
    expect(loadSplit()).toBe(0.33);
  });

  it("clamps an out-of-range stored ratio on load", () => {
    localStorage.setItem(KEY, "0.02");
    expect(loadSplit()).toBe(SPLIT_MIN);
    localStorage.setItem(KEY, "7");
    expect(loadSplit()).toBe(SPLIT_MAX);
  });

  it("tolerates corrupt JSON by falling back to the default", () => {
    localStorage.setItem(KEY, "{ not valid json");
    expect(loadSplit()).toBe(DEFAULT_SPLIT);
  });

  it("tolerates valid-JSON garbage (wrong type) by falling back to the default", () => {
    localStorage.setItem(KEY, JSON.stringify("wide"));
    expect(loadSplit()).toBe(DEFAULT_SPLIT);
    localStorage.setItem(KEY, JSON.stringify({ ratio: 0.4 }));
    expect(loadSplit()).toBe(DEFAULT_SPLIT);
  });

  it("saves values clamped (bad in-memory state can't be written out of range)", () => {
    saveSplit(42);
    expect(JSON.parse(localStorage.getItem(KEY) as string)).toBe(SPLIT_MAX);
    saveSplit(-1);
    expect(JSON.parse(localStorage.getItem(KEY) as string)).toBe(SPLIT_MIN);
  });
});
