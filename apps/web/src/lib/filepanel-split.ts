/**
 * Persisted geometry for the Files tab's tree/preview split (FilePanel): the
 * fraction of the split body given to the file tree, with the preview viewer
 * taking the rest. Mirrors layout-state.ts — all clamping and localStorage
 * tolerance lives here so the drag UI in FilePanel stays trivial.
 *
 * The current FilePanel stacks the tree ABOVE the preview, so the splitter is
 * horizontal and drags along Y; the ratio is tree-height / body-height.
 */

// Static ratio bounds: the persisted value (and any drag result) always lands
// in [SPLIT_MIN, SPLIT_MAX] so neither side can be collapsed away entirely.
export const SPLIT_MIN = 0.15;
export const SPLIT_MAX = 0.85;
export const DEFAULT_SPLIT = 0.5;

// Pixel floors enforced at drag time (the ratio bounds alone are too weak on a
// short panel): the tree keeps a few visible rows, the viewer keeps its header
// plus a couple of lines.
export const TREE_MIN = 80;
export const VIEWER_MIN = 110;

/** localStorage key for the Files tab's split. Other split panels (e.g. the
 *  Diff tab) pass their own key so their geometry persists independently. */
export const FILEPANEL_SPLIT_KEY = "erdou:filepanel-split";
export const DIFFPANEL_SPLIT_KEY = "erdou:diffpanel-split";
const KEY = FILEPANEL_SPLIT_KEY;

/** Clamp a raw ratio to the static [SPLIT_MIN, SPLIT_MAX] bounds; anything
 *  non-numeric or non-finite falls back to DEFAULT_SPLIT. */
export function clampSplit(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_SPLIT;
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, v));
}

/** Map a drag position (the pointer's offset from the top of the split body,
 *  in px) to a valid ratio: both pixel floors are enforced, then the static
 *  ratio bounds. On a body too short to grant both floors the tree floor wins
 *  (the viewer just gets whatever is left). A degenerate body height (<= 0,
 *  e.g. mid-teardown) yields DEFAULT_SPLIT rather than NaN. */
export function splitForDrag(treePx: number, bodyHeight: number): number {
  if (!(bodyHeight > 0)) return DEFAULT_SPLIT;
  const maxTree = bodyHeight - VIEWER_MIN;
  const px = Math.min(Math.max(treePx, TREE_MIN), Math.max(TREE_MIN, maxTree));
  return clampSplit(px / bodyHeight);
}

/** Read the persisted split ratio, clamped to valid bounds. Corrupt JSON, a
 *  non-numeric value, or an absent key yields DEFAULT_SPLIT (never throws).
 *  `key` selects which panel's geometry to read (defaults to the Files tab). */
export function loadSplit(key: string = KEY): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return DEFAULT_SPLIT;
    return clampSplit(JSON.parse(raw));
  } catch {
    return DEFAULT_SPLIT;
  }
}

/** Persist the split ratio, clamped so a bad in-memory value can never be
 *  written out of range. `key` selects which panel's geometry (defaults Files). */
export function saveSplit(ratio: number, key: string = KEY): void {
  localStorage.setItem(key, JSON.stringify(clampSplit(ratio)));
}
