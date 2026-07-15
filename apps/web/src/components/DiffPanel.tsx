import { useEffect, useState } from "react";
import type { Studio, Run } from "../lib/studio.js";
import { lineDiff, diffStats } from "../lib/diff.js";

const MARK: Record<string, string> = { create: "＋", modify: "±", delete: "－" };

/** Review pane for a run's file changes: a change list plus the selected file's hunks. */
export function DiffPanel({ run, studio }: { run: Run; studio: Studio }) {
  const [sel, setSel] = useState<string | null>(run.changes[0]?.path ?? null);

  // Showing the review pane for a pending run accepts it (review -> done).
  useEffect(() => {
    if (run.status === "review") studio.markReviewed(run.id);
  }, [run.id, run.status, studio]);

  if (run.changes.length === 0) {
    return <div className="hint">This run didn't change any files.</div>;
  }

  const selected = run.changes.find((c) => c.path === sel) ?? run.changes[0];
  if (!selected) return null; // unreachable given the length check; satisfies the type

  const lines = lineDiff(selected.before, selected.after);

  return (
    <div className="diff-panel">
      <div className="diff-files">
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

      <div className="hunk">
        <div className="ln h">
          <span className="g" />
          <span className="c">@@ {selected.path} @@</span>
        </div>
        {lines.map((l, i) => (
          <div key={i} className={"ln " + (l.kind === "add" ? "a" : l.kind === "del" ? "d" : "")}>
            <span className="g">{l.newNo ?? l.oldNo ?? ""}</span>
            <span className="c">{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
