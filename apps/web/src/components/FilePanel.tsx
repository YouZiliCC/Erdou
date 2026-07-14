import { useEffect, useState } from "react";
import type { Studio, FileNode } from "../lib/studio.js";

export function FilePanel({ studio }: { studio: Studio }) {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [content, setContent] = useState("");

  useEffect(() => {
    let alive = true;
    void (async () => {
      const t = await studio.readTree("/");
      if (!alive) return;
      setTree(t);
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

  return (
    <div className="panel">
      {tree.length === 0 ? (
        <div className="hint">The filesystem is empty. Ask the agent to create a project, or use the terminal.</div>
      ) : (
        <div className="tree">
          <TreeNodes nodes={tree} sel={sel} onOpen={setSel} depth={0} />
        </div>
      )}
      {sel && (
        <div className="viewer">
          <div className="vhead">
            <span>{sel}</span>
            <span>{content.length} chars</span>
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
  depth,
}: {
  nodes: FileNode[];
  sel: string | null;
  onOpen: (path: string) => void;
  depth: number;
}) {
  return (
    <>
      {nodes.map((n) => (
        <div key={n.path}>
          <div
            className={`node ${n.type === "directory" ? "dir" : "file"} ${sel === n.path ? "sel" : ""}`}
            style={{ paddingLeft: 10 + depth * 14 }}
            onClick={() => n.type !== "directory" && onOpen(n.path)}
          >
            <span className="ico">{n.type === "directory" ? "▾" : n.type === "symlink" ? "↳" : "·"}</span>
            {n.name}
          </div>
          {n.children && <TreeNodes nodes={n.children} sel={sel} onOpen={onOpen} depth={depth + 1} />}
        </div>
      ))}
    </>
  );
}
