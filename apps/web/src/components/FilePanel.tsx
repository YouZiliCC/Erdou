import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Studio, FileNode } from "../lib/studio.js";
import { DEFAULT_SPLIT, loadSplit, saveSplit, splitForDrag } from "../lib/filepanel-split.js";
import { Chevron, File, Folder, FolderOpen } from "./ui/icons.js";

export function FilePanel({ studio }: { studio: Studio }) {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [content, setContent] = useState("");
  // Folder path -> expanded. Seeded once with the top-level directories (so
  // the tree opens one level deep); nested folders start collapsed until
  // clicked. `seeded` guards that from re-running on every later tree
  // refresh (e.g. an agent run editing files bumps `fsVersion`), which would
  // otherwise stomp on whatever the user had expanded/collapsed since.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const seeded = useRef(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const t = await studio.readTree("/");
      if (!alive) return;
      setTree(t);
      if (!seeded.current && t.length > 0) {
        seeded.current = true;
        setExpanded(new Set(t.filter((n) => n.type === "directory").map((n) => n.path)));
      }
      if (sel) {
        try {
          setContent(await studio.readFileText(sel));
        } catch {
          setSel(null);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [studio, studio.fsVersion, sel]);

  function toggle(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  // Draggable tree/preview split: `split` is the tree's fraction of the body
  // height (persisted + clamped in filepanel-split.ts). The drag mirrors the
  // ResizableShell .splitter pattern — pointer capture on the handle, deltas
  // clamped through the pure helper, persisted once on release.
  const [split, setSplit] = useState(loadSplit);
  // Mirror of `split` for persist-on-release: the pointerup handler closes
  // over the render it was attached in, so reading state there could miss the
  // final pointermove's not-yet-committed update.
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
    saveSplit(splitRef.current);
  }

  function resetSplit() {
    splitRef.current = DEFAULT_SPLIT;
    setSplit(DEFAULT_SPLIT);
    saveSplit(DEFAULT_SPLIT);
  }

  // Manual export path: build the zip and trigger the browser download right
  // away via a temporary anchor (no card needed — the file lands in the
  // downloads bar). Errors (e.g. an empty workspace) surface inline here.
  const [exportError, setExportError] = useState<string | null>(null);
  function downloadZip() {
    try {
      setExportError(null);
      const e = studio.exportProject();
      const a = document.createElement("a");
      a.href = e.url;
      a.download = e.name;
      a.click();
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="panel fp">
      <div className="fhead">
        <span className="fhead-title">Workspace</span>
        <button
          type="button"
          className="btn ghost"
          onClick={downloadZip}
          title="Download the whole project as a .zip (excludes node_modules and Erdou-internal state)"
        >
          Download .zip
        </button>
      </div>
      {exportError && <div className="fhead-err">{exportError}</div>}
      <div className="fp-body" ref={bodyRef}>
        {/* With a preview open the tree is pinned to the persisted fraction of
            the body (the viewer flexes into the rest); without one it just
            fills, so the splitter and its sizing leave no trace. */}
        <div className="fp-tree" style={sel ? { flex: `0 0 ${split * 100}%` } : undefined}>
          {tree.length === 0 ? (
            <div className="hint">The filesystem is empty. Ask the agent to create a project, or use the terminal.</div>
          ) : (
            <div className="tree">
              <TreeNodes nodes={tree} sel={sel} onOpen={setSel} expanded={expanded} onToggle={toggle} depth={0} />
            </div>
          )}
        </div>
        {sel && (
          <>
            <div
              className="splitter fp-splitter"
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize file preview"
              title="Drag to resize — double-click to reset"
              onPointerDown={onSplitPointerDown}
              onPointerMove={onSplitPointerMove}
              onPointerUp={endSplitDrag}
              onPointerCancel={endSplitDrag}
              onLostPointerCapture={endSplitDrag}
              onDoubleClick={resetSplit}
            />
            <div className="viewer fp-view">
              <div className="vhead">
                <span>{sel}</span>
                <span className="chip">{content.length} chars</span>
              </div>
              <pre>{content}</pre>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function TreeNodes({
  nodes,
  sel,
  onOpen,
  expanded,
  onToggle,
  depth,
}: {
  nodes: FileNode[];
  sel: string | null;
  onOpen: (path: string) => void;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  depth: number;
}) {
  return (
    <>
      {nodes.map((n) => {
        const isDir = n.type === "directory";
        const open = isDir && expanded.has(n.path);
        return (
          <div key={n.path}>
            <div
              className={`node ${isDir ? "dir" : "file"} ${sel === n.path ? "sel" : ""}`}
              style={{ paddingLeft: 10 + depth * 14 }}
              onClick={() => (isDir ? onToggle(n.path) : onOpen(n.path))}
            >
              {isDir ? <Chevron className={`chev ${open ? "open" : ""}`} /> : <span className="chev" aria-hidden />}
              {isDir ? open ? <FolderOpen className="ico" /> : <Folder className="ico" /> : <File className="ico" />}
              {n.name}
            </div>
            {isDir && open && n.children && (
              <TreeNodes
                nodes={n.children}
                sel={sel}
                onOpen={onOpen}
                expanded={expanded}
                onToggle={onToggle}
                depth={depth + 1}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
