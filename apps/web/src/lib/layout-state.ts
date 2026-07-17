/**
 * Persisted geometry for the resizable 3-column shell (ResizableShell): the
 * sidebar width, the review-pane width, and whether the left sidebar is
 * collapsed. This is the hermetic, unit-tested seam — all clamping and
 * localStorage tolerance lives here so the drag/collapse UI stays trivial.
 *
 * Center width is never stored: the center column always flexes to fill the
 * gap, and CENTER_MIN is the floor the drag handlers must preserve.
 */
export interface LayoutState {
  sidebarWidth: number;
  reviewWidth: number;
  sidebarCollapsed: boolean;
}

// Sidebar: ~180–420px (238 matches the pre-resize fixed width).
export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 420;
// Review: floor of 300px; ceiling is 60% of the viewport (only known at drag time).
export const REVIEW_MIN = 300;
export const REVIEW_MAX_FRACTION = 0.6;
// The center column must never be squeezed below this.
export const CENTER_MIN = 320;
// Fixed chrome between the columns (must match styles.css): each vertical
// splitter is 5px, and a collapsed sidebar is replaced by a 34px rail. The
// center-preservation math has to reserve these so CENTER_MIN isn't undershot.
export const SPLITTER_WIDTH = 5;
export const RAIL_WIDTH = 34;

const KEY = "erdou:layout";

/** Width consumed by everything to the left of the center column plus the two
 *  inter-column splitters: the sidebar (or, when collapsed, the 34px rail) and
 *  both 5px splitters. (A collapsed sidebar drops its own splitter, so counting
 *  two is a 5px-conservative reserve — it can only keep the center slightly
 *  wider, never strand it.) */
function leftChrome(sidebarWidth: number, collapsed: boolean): number {
  return (collapsed ? RAIL_WIDTH : sidebarWidth) + 2 * SPLITTER_WIDTH;
}

/** Largest review width that still leaves the center column at least CENTER_MIN,
 *  for the given sidebar geometry and viewport. Shared by clampLayout (load /
 *  resize) and the review-splitter drag so both reserve the same chrome. */
export function maxReviewForCenter(
  sidebarWidth: number,
  collapsed: boolean,
  viewportWidth: number,
): number {
  return viewportWidth - leftChrome(sidebarWidth, collapsed) - CENTER_MIN;
}

/** Largest sidebar width that still leaves the center column at least CENTER_MIN,
 *  for the given review width and viewport (sidebar drags are only reachable
 *  while expanded, so both splitters are always present). */
export function maxSidebarForCenter(reviewWidth: number, viewportWidth: number): number {
  return viewportWidth - reviewWidth - 2 * SPLITTER_WIDTH - CENTER_MIN;
}

export const DEFAULT_LAYOUT: LayoutState = {
  sidebarWidth: 238,
  reviewWidth: 460,
  sidebarCollapsed: false,
};

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

/** Clamp a raw sidebar width to its static bounds. */
export function clampSidebar(width: number): number {
  return clampNum(width, SIDEBAR_MIN, SIDEBAR_MAX, DEFAULT_LAYOUT.sidebarWidth);
}

/** Clamp a raw review width. With a viewport its ceiling is 60% of it (never
 *  below REVIEW_MIN); without one only the floor is enforced. */
export function clampReview(width: number, viewportWidth?: number): number {
  const max =
    viewportWidth && viewportWidth > 0
      ? Math.max(REVIEW_MIN, viewportWidth * REVIEW_MAX_FRACTION)
      : Number.MAX_SAFE_INTEGER;
  return clampNum(width, REVIEW_MIN, max, DEFAULT_LAYOUT.reviewWidth);
}

/** Normalize a (possibly out-of-range or partly-garbage) layout to valid
 *  bounds. When `viewportWidth` is given, also guarantees the center column
 *  keeps at least CENTER_MIN by shrinking the review pane if the two side
 *  columns would otherwise overrun the viewport. */
export function clampLayout(state: LayoutState, viewportWidth?: number): LayoutState {
  const sidebarCollapsed = state.sidebarCollapsed === true;
  const sidebarWidth = clampSidebar(state.sidebarWidth);
  let reviewWidth = clampReview(state.reviewWidth, viewportWidth);
  if (viewportWidth && viewportWidth > 0) {
    const maxByCenter = maxReviewForCenter(sidebarWidth, sidebarCollapsed, viewportWidth);
    if (maxByCenter >= REVIEW_MIN && reviewWidth > maxByCenter) reviewWidth = maxByCenter;
  }
  return { sidebarWidth, reviewWidth, sidebarCollapsed };
}

/** Read the persisted layout, filling missing/garbage fields with defaults and
 *  clamping everything to valid bounds. Corrupt JSON or an absent value yields
 *  a fresh copy of DEFAULT_LAYOUT (never throws).
 *
 *  Clamps against the CURRENT viewport (window.innerWidth): a review width that
 *  was valid on a wide screen but is too wide for this one is reduced to keep
 *  the center column at CENTER_MIN, so reloading on a narrower window can never
 *  strand the Conversation + Composer to 0px. Read-only — the persisted
 *  (desired) width is left intact so re-widening the window restores it. */
export function loadLayout(): LayoutState {
  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : undefined;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return clampLayout({ ...DEFAULT_LAYOUT }, viewportWidth);
    const parsed = JSON.parse(raw) as Partial<LayoutState>;
    return clampLayout(
      {
        sidebarWidth:
          typeof parsed.sidebarWidth === "number" ? parsed.sidebarWidth : DEFAULT_LAYOUT.sidebarWidth,
        reviewWidth:
          typeof parsed.reviewWidth === "number" ? parsed.reviewWidth : DEFAULT_LAYOUT.reviewWidth,
        sidebarCollapsed:
          typeof parsed.sidebarCollapsed === "boolean"
            ? parsed.sidebarCollapsed
            : DEFAULT_LAYOUT.sidebarCollapsed,
      },
      viewportWidth,
    );
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

/** Persist the layout, clamped to valid static bounds so a bad in-memory value
 *  can never be written back out of range. */
export function saveLayout(state: LayoutState): void {
  localStorage.setItem(KEY, JSON.stringify(clampLayout(state)));
}
