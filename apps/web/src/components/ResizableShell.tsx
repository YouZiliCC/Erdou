import { useRef, type ReactNode, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { clampSidebar, clampReview, CENTER_MIN, REVIEW_MIN, SIDEBAR_MIN } from "../lib/layout-state.js";

/**
 * The resizable 3-column app shell: sidebar | center | review, with two thin
 * pointer-driven vertical splitters. The center column flexes to fill; the two
 * side columns are driven by width vars set on `.shell` (see styles.css). All
 * bounds live in layout-state.ts; this component only maps pointer deltas to
 * clamped widths and reports them upward (App owns + persists the state).
 *
 * Collapsing the sidebar swaps it (and its splitter) for a slim rail with an
 * expand affordance — so there is always a way back.
 */
export function ResizableShell({
  sidebar,
  center,
  review,
  sidebarWidth,
  reviewWidth,
  collapsed,
  onSidebarWidthChange,
  onReviewWidthChange,
  onExpandSidebar,
}: {
  sidebar: ReactNode;
  center: ReactNode;
  review: ReactNode;
  sidebarWidth: number;
  reviewWidth: number;
  collapsed: boolean;
  onSidebarWidthChange: (w: number) => void;
  onReviewWidthChange: (w: number) => void;
  onExpandSidebar: () => void;
}) {
  const drag = useRef<{ kind: "sidebar" | "review"; startX: number; startW: number } | null>(null);

  function onPointerDown(kind: "sidebar" | "review", e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.classList.add("active");
    drag.current = { kind, startX: e.clientX, startW: kind === "sidebar" ? sidebarWidth : reviewWidth };
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) return;
    const vw = window.innerWidth;
    const dx = e.clientX - d.startX;
    if (d.kind === "sidebar") {
      // Dragging right widens the sidebar; keep the center at >= CENTER_MIN.
      let w = clampSidebar(d.startW + dx);
      const maxByCenter = vw - reviewWidth - CENTER_MIN;
      if (w > maxByCenter) w = Math.max(SIDEBAR_MIN, maxByCenter);
      onSidebarWidthChange(w);
    } else {
      // The review handle sits on the pane's LEFT edge: dragging left widens it.
      let w = clampReview(d.startW - dx, vw);
      const sidebarSpace = collapsed ? 0 : sidebarWidth;
      const maxByCenter = vw - sidebarSpace - CENTER_MIN;
      if (w > maxByCenter) w = Math.max(REVIEW_MIN, maxByCenter);
      onReviewWidthChange(w);
    }
  }

  function endDrag(e: ReactPointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.classList.remove("active");
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }

  const shellVars = {
    "--sidebar-w": `${sidebarWidth}px`,
    "--review-w": `${reviewWidth}px`,
  } as CSSProperties;

  return (
    <div className="shell" style={shellVars}>
      {collapsed ? (
        <div className="rail">
          <button
            className="rail-expand"
            onClick={onExpandSidebar}
            title="Expand sidebar"
            aria-label="Expand sidebar"
          >
            ›
          </button>
        </div>
      ) : (
        <>
          {sidebar}
          <div
            className="splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            onPointerDown={(e) => onPointerDown("sidebar", e)}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onLostPointerCapture={endDrag}
          />
        </>
      )}
      {center}
      <div
        className="splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize review pane"
        onPointerDown={(e) => onPointerDown("review", e)}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      />
      {review}
    </div>
  );
}
