import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Studio, Run } from "../lib/studio.js";
import { lineDiff, diffStats } from "../lib/diff.js";
import { DEFAULT_SPLIT, DIFFPANEL_SPLIT_KEY, loadSplit, saveSplit, splitForDrag } from "../lib/filepanel-split.js";

const MARK: Record<string, string> = { create: "＋", modify: "±", delete: "－" };

/**
 * Review pane for a run's file changes — a two-pane split that mirrors the Files
 * tab's tree/preview design: the changed-file LIST on top (its own scroll) and
 * the selected file's DIFF below (its own scroll, with a header naming the file
 * + its ± stats), divided by the same draggable `.splitter`. Geometry persists
 * under the diff's OWN key, independent of the Files tab.
 */
export function DiffPanel({ run, studio }: { run: Run; studio: Studio }) {
  const [sel, setSel] = useState<string | null>(run.changes[0]?.path ?? null);

  // Showing the review pane for a pending run accepts it (review -> done).
  useEffect(() => {
    if (run.status === "review") studio.markReviewed(run.id);
  }, [run.id, run.status, studio]);

  // Draggable list/diff split (same mechanics as FilePanel): `split` is the
  // list's fraction of the body height, clamped + persisted in filepanel-split.
  const [split, setSplit] = useState(() => loadSplit(DIFFPANEL_SPLIT_KEY));
  const splitRef = useRef(split);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  function onSplitPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.classList.add("active");
    dragging.current = true;
  }
  function onSplitPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    const body = bodyRef.current;
    if (!body) return;
    const rect = body.getBoundingClientRect();
    const ratio = splitForDrag(e.clientY - rect.top, rect.height);
    splitRef.current = ratio;
    setSplit(ratio);
  }
  function endSplitDrag(e: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    dragging.current = false;
    e.currentTarget.classList.remove("active");
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    saveSplit(splitRef.current, DIFFPANEL_SPLIT_KEY);
  }
  function resetSplit() {
    splitRef.current = DEFAULT_SPLIT;
    setSplit(DEFAULT_SPLIT);
    saveSplit(DEFAULT_SPLIT, DIFFPANEL_SPLIT_KEY);
  }

  if (run.changes.length === 0) {
    return <div className="hint">This run didn't change any files.</div>;
  }

  const selected = run.changes.find((c) => c.path === sel) ?? run.changes[0];
  if (!selected) return null; // unreachable given the length check; satisfies the type

  const lines = lineDiff(selected.before, selected.after);
  const stats = diffStats(lines);

  return (
    <div className="panel diff-panel">
      <div className="fp-body" ref={bodyRef}>
        {/* Top pane: the changed-file list (pinned to the persisted fraction). */}
        <div className="diff-files fp-tree" style={{ flex: `0 0 ${split * 100}%` }}>
          {run.changes.map((c) => {
            const { added, removed } = diffStats(lineDiff(c.before, c.after));
            return (
              <div
                key={c.path}
                className={`diff-file ${c.path === selected.path ? "sel" : ""}`}
                onClick={() => setSel(c.path)}
              >
                <span className={"mark " + c.kind}>{MARK[c.kind]}</span>
                <span className="fp">{c.path}</span>
                <span className="add">+{added}</span>
                <span className="del">−{removed}</span>
                <button
                  className="btn ghost revert"
                  onClick={(e) => {
                    e.stopPropagation();
                    void studio.revertChange(run.id, c.path);
                  }}
                >
                  Revert
                </button>
              </div>
            );
          })}
        </div>

        <div
          className="splitter fp-splitter"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the diff view"
          title="Drag to resize — double-click to reset"
          onPointerDown={onSplitPointerDown}
          onPointerMove={onSplitPointerMove}
          onPointerUp={endSplitDrag}
          onPointerCancel={endSplitDrag}
          onLostPointerCapture={endSplitDrag}
          onDoubleClick={resetSplit}
        />

        {/* Bottom pane: the selected file's diff, headed like the Files preview. */}
        <div className="viewer fp-view diff-view">
          <div className="vhead">
            <span className="vhead-path">
              <span className={"mark " + selected.kind}>{MARK[selected.kind]}</span> {selected.path}
            </span>
            <span className="vhead-stats">
              <span className="add">+{stats.added}</span> <span className="del">−{stats.removed}</span>
            </span>
          </div>
          <div className="hunk">
            {lines.map((l, i) => (
              <div key={i} className={"ln " + (l.kind === "add" ? "a" : l.kind === "del" ? "d" : "")}>
                <span className="g">{l.newNo ?? l.oldNo ?? ""}</span>
                <span className="c">{l.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
