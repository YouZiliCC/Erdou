import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  loadLayout,
  saveLayout,
  clampLayout,
  clampSidebar,
  clampReview,
  DEFAULT_LAYOUT,
  SIDEBAR_MIN,
  SIDEBAR_MAX,
  REVIEW_MIN,
  CENTER_MIN,
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

  it("clampLayout shrinks the review pane to preserve CENTER_MIN for the center column", () => {
    // viewport 1000, sidebar 300 → maxByCenter = 380 (>= REVIEW_MIN) so review 500 → 380
    const out = clampLayout({ sidebarWidth: 300, reviewWidth: 500, sidebarCollapsed: false }, 1000);
    expect(out.reviewWidth).toBe(1000 - 300 - CENTER_MIN); // 380
    expect(out.sidebarWidth + out.reviewWidth + CENTER_MIN).toBeLessThanOrEqual(1000);
  });

  it("clampLayout ignores the collapsed sidebar's width when reserving center space", () => {
    // collapsed → sidebar takes no room, so review may stay larger
    const out = clampLayout({ sidebarWidth: 400, reviewWidth: 600, sidebarCollapsed: true }, 1200);
    // 60% of 1200 = 720 ceiling; center floor: 1200 - 0 - 320 = 880 → review 600 unchanged
    expect(out.reviewWidth).toBe(600);
  });
});
