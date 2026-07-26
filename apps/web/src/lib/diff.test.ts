import { describe, it, expect } from "vitest";
import { lineDiff, diffStats } from "./diff.js";

describe("lineDiff", () => {
  it("marks added and removed lines, keeps context", () => {
    const d = lineDiff("a\nb\nc\n", "a\nB\nc\n");
    const kinds = d.map((l) => l.kind);
    expect(kinds).toContain("del");
    expect(kinds).toContain("add");
    expect(d.find((l) => l.kind === "del")?.text).toBe("b");
    expect(d.find((l) => l.kind === "add")?.text).toBe("B");
    expect(diffStats(d)).toEqual({ added: 1, removed: 1 });
  });

  it("all-added when before is empty", () => {
    const d = lineDiff("", "x\ny\n");
    expect(diffStats(d)).toEqual({ added: 2, removed: 0 });
  });

  it("a file past the LCS cell budget degrades to one delete block + one add block instead of allocating", () => {
    // 2100×2100 = 4.41M cells — just over the budget. Nothing filters big files
    // out of run.changes, so a 15k-line lock file used to build a ~1.9 GB matrix.
    const before = Array.from({ length: 2100 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const after = before.replace("line 5\n", "line five\n");
    const d = lineDiff(before, after);

    expect(d).toHaveLength(4200);
    // No content is truncated and the line numbers still describe both sides.
    expect(diffStats(d)).toEqual({ added: 2100, removed: 2100 });
    expect(d.slice(0, 2100).every((l) => l.kind === "del")).toBe(true);
    expect(d.slice(2100).every((l) => l.kind === "add")).toBe(true);
    expect(d[0]).toEqual({ kind: "del", text: "line 0", oldNo: 1 });
    expect(d[2099]).toEqual({ kind: "del", text: "line 2099", oldNo: 2100 });
    expect(d[2100]).toEqual({ kind: "add", text: "line 0", newNo: 1 });
    expect(d[2105]).toEqual({ kind: "add", text: "line five", newNo: 6 });
  });

  it("a file within the budget keeps per-line granularity (context lines survive)", () => {
    // 1000×1000 = 1M cells — well inside the budget, so the LCS still runs.
    const before = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const after = before.replace("line 5\n", "line five\n");
    const d = lineDiff(before, after);
    expect(diffStats(d)).toEqual({ added: 1, removed: 1 });
    expect(d.filter((l) => l.kind === "ctx")).toHaveLength(999);
  });
});
