import { useEffect, useRef, useState } from "react";
import type { Studio, FileNode } from "../lib/studio.js";
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
    <div className="panel">
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
      {tree.length === 0 ? (
        <div className="hint">The filesystem is empty. Ask the agent to create a project, or use the terminal.</div>
      ) : (
        <div className="tree">
          <TreeNodes nodes={tree} sel={sel} onOpen={setSel} expanded={expanded} onToggle={toggle} depth={0} />
        </div>
      )}
      {sel && (
        <div className="viewer">
          <div className="vhead">
            <span>{sel}</span>
            <span className="chip">{content.length} chars</span>
          </div>
          <pre>{content}</pre>
        </div>
      )}
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
