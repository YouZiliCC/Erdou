import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  loadLayout,
  saveLayout,
  clampLayout,
  clampSidebar,
  clampReview,
  maxReviewForCenter,
  maxSidebarForCenter,
  DEFAULT_LAYOUT,
  SIDEBAR_MIN,
  SIDEBAR_MAX,
  REVIEW_MIN,
  CENTER_MIN,
  RAIL_WIDTH,
  SPLITTER_WIDTH,
  type LayoutState,
} from "./layout-state.js";

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

const KEY = "erdou:layout";

describe("layout-state persistence", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", makeLocalStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns DEFAULT_LAYOUT when nothing is stored", () => {
    expect(loadLayout()).toEqual(DEFAULT_LAYOUT);
  });

  it("round-trips a valid saved layout", () => {
    const state: LayoutState = { sidebarWidth: 300, reviewWidth: 500, sidebarCollapsed: true };
    saveLayout(state);
    expect(loadLayout()).toEqual(state);
  });

  it("clamps an out-of-range stored sidebar width to its bounds", () => {
    localStorage.setItem(KEY, JSON.stringify({ sidebarWidth: 9999, reviewWidth: 460, sidebarCollapsed: false }));
    expect(loadLayout().sidebarWidth).toBe(SIDEBAR_MAX);

    localStorage.setItem(KEY, JSON.stringify({ sidebarWidth: 10, reviewWidth: 460, sidebarCollapsed: false }));
    expect(loadLayout().sidebarWidth).toBe(SIDEBAR_MIN);
  });

  it("clamps a too-small stored review width up to its floor", () => {
    localStorage.setItem(KEY, JSON.stringify({ sidebarWidth: 238, reviewWidth: 50, sidebarCollapsed: false }));
    expect(loadLayout().reviewWidth).toBe(REVIEW_MIN);
  });

  it("clamps a persisted review width too wide for the CURRENT viewport on load", () => {
    // A width valid on a wide screen must be reduced against THIS viewport so the
    // center column keeps CENTER_MIN — otherwise the chat UI is stranded to 0px.
    vi.stubGlobal("window", { innerWidth: 1000 });
    localStorage.setItem(KEY, JSON.stringify({ sidebarWidth: 238, reviewWidth: 1500, sidebarCollapsed: false }));
    // 1000 - 238 sidebar - 10 splitters - 320 center = 432 (< the 600 60%-ceiling)
    expect(loadLayout().reviewWidth).toBe(1000 - 238 - 2 * SPLITTER_WIDTH - CENTER_MIN);
  });

  it("tolerates corrupt JSON by falling back to defaults", () => {
    localStorage.setItem(KEY, "{ not valid json");
    expect(loadLayout()).toEqual(DEFAULT_LAYOUT);
  });

  it("fills missing/garbage fields with defaults, keeping valid ones", () => {
    localStorage.setItem(KEY, JSON.stringify({ sidebarWidth: 250, reviewWidth: "wide", sidebarCollapsed: "yes" }));
    const loaded = loadLayout();
    expect(loaded.sidebarWidth).toBe(250);
    expect(loaded.reviewWidth).toBe(DEFAULT_LAYOUT.reviewWidth);
    expect(loaded.sidebarCollapsed).toBe(false);
  });

  it("saves values clamped to valid bounds (bad in-memory state can't be written out of range)", () => {
    saveLayout({ sidebarWidth: 5000, reviewWidth: 10, sidebarCollapsed: false });
    const raw = JSON.parse(localStorage.getItem(KEY) as string) as LayoutState;
    expect(raw.sidebarWidth).toBe(SIDEBAR_MAX);
    expect(raw.reviewWidth).toBe(REVIEW_MIN);
  });
});

describe("layout-state clamping helpers", () => {
  it("clampSidebar enforces [SIDEBAR_MIN, SIDEBAR_MAX]", () => {
    expect(clampSidebar(0)).toBe(SIDEBAR_MIN);
    expect(clampSidebar(99999)).toBe(SIDEBAR_MAX);
    expect(clampSidebar(300)).toBe(300);
  });

  it("clampReview enforces the floor, and a 60%-of-viewport ceiling when given one", () => {
    expect(clampReview(10)).toBe(REVIEW_MIN);
    // 60% of 1000 = 600 ceiling
    expect(clampReview(900, 1000)).toBe(600);
    expect(clampReview(400, 1000)).toBe(400);
  });

  it("clampLayout shrinks the review pane to preserve CENTER_MIN (incl. splitter chrome)", () => {
    // viewport 1000, sidebar 300, two 5px splitters → maxByCenter = 370 so review 500 → 370
    const out = clampLayout({ sidebarWidth: 300, reviewWidth: 500, sidebarCollapsed: false }, 1000);
    expect(out.reviewWidth).toBe(1000 - 300 - 2 * SPLITTER_WIDTH - CENTER_MIN); // 370
    expect(out.sidebarWidth + 2 * SPLITTER_WIDTH + out.reviewWidth + CENTER_MIN).toBeLessThanOrEqual(1000);
  });

  it("clampLayout reserves the collapsed rail + splitter (not 0) when preserving center", () => {
    // collapsed still consumes the 34px rail + review splitter, so at a tight
    // viewport the review pane must yield those pixels too (not treat sidebar as 0).
    const out = clampLayout({ sidebarWidth: 400, reviewWidth: 600, sidebarCollapsed: true }, 900);
    // clampReview first caps at the 60% ceiling (540); center floor then bites:
    // 900 - 34 rail - 10 splitters - 320 center = 536 (would be 540 if the rail were ignored)
    expect(out.reviewWidth).toBe(900 - RAIL_WIDTH - 2 * SPLITTER_WIDTH - CENTER_MIN); // 536
  });

  it("clampLayout leaves the collapsed layout untouched when there is ample room", () => {
    // At a wide viewport the 60% ceiling binds, not the center floor, so review stays put.
    const out = clampLayout({ sidebarWidth: 400, reviewWidth: 600, sidebarCollapsed: true }, 1200);
    expect(out.reviewWidth).toBe(600);
  });
});

describe("layout-state center-preservation math (shared by ResizableShell drags)", () => {
  it("maxReviewForCenter subtracts sidebar + two splitters + CENTER_MIN when expanded", () => {
    expect(maxReviewForCenter(300, false, 1000)).toBe(1000 - 300 - 2 * SPLITTER_WIDTH - CENTER_MIN); // 370
  });

  it("maxReviewForCenter subtracts the rail (not the sidebar width) when collapsed", () => {
    expect(maxReviewForCenter(400, true, 1200)).toBe(1200 - RAIL_WIDTH - 2 * SPLITTER_WIDTH - CENTER_MIN); // 836
  });

  it("maxSidebarForCenter subtracts review + two splitters + CENTER_MIN", () => {
    expect(maxSidebarForCenter(460, 1000)).toBe(1000 - 460 - 2 * SPLITTER_WIDTH - CENTER_MIN); // 210
  });
});
