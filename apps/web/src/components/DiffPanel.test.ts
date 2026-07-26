// Regression test for the Diff tab's cost (web-ui audit D5): lineDiff is an
// O(n×m) LCS (2000 lines ~57 ms, 4000 ~208 ms) and the panel used to call it
// inside `run.changes.map(...)` AND again for the selected file — so a render
// diffed every changed file, plus the selected one twice, and every re-render
// (selecting a file, dragging the splitter) paid it all again. This pins the
// per-render half: one lineDiff per changed file, no duplicate for the
// selection. The across-render half is the useMemo on `run.changes`; SSR
// remounts on every render, so it can't be observed here. Node environment,
// no jsdom: static-markup rendering, matching Composer.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FileChange, Run, Studio } from "../lib/studio";

const lineDiffCalls: string[] = [];

vi.mock("../lib/diff.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/diff.js")>();
  return {
    ...real,
    lineDiff: (before: string, after: string) => {
      lineDiffCalls.push(before + "→" + after);
      return real.lineDiff(before, after);
    },
  };
});

import { DiffPanel } from "./DiffPanel";

function change(path: string, before: string, after: string): FileChange {
  return { path, kind: "modify", before, after };
}

function run(changes: FileChange[]): Run {
  return { id: "r1", title: "t", task: "t", status: "done", trace: [], changes, messages: [], createdAt: 0 };
}

// DiffPanel only touches studio in an effect (markReviewed) and a click handler
// (revertChange); neither runs under renderToStaticMarkup.
const studio = {} as Studio;

beforeEach(() => {
  lineDiffCalls.length = 0;
});

describe("DiffPanel diff computation", () => {
  it("diffs each changed file exactly once per render — including the selected one", () => {
    const changes = [
      change("a.ts", "a\n", "a\nb\n"),
      change("b.ts", "x\ny\n", "x\n"),
      change("c.ts", "1\n", "2\n"),
    ];
    renderToStaticMarkup(createElement(DiffPanel, { run: run(changes), studio }));
    expect(lineDiffCalls).toHaveLength(3);
    expect(new Set(lineDiffCalls).size).toBe(3); // no file diffed twice
  });

  it("still shows each file's own ± stats and the selected file's diff body", () => {
    const changes = [change("a.ts", "a\n", "a\nb\nc\n"), change("b.ts", "x\ny\n", "x\n")];
    const html = renderToStaticMarkup(createElement(DiffPanel, { run: run(changes), studio }));
    expect(html).toContain('<span class="add">+2</span><span class="del">−0</span>'); // a.ts
    expect(html).toContain('<span class="add">+0</span><span class="del">−1</span>'); // b.ts
    // Selection defaults to the first change: its header and hunk are rendered.
    expect(html).toContain("a.ts");
    expect(html).toContain('class="ln a"');
  });
});
