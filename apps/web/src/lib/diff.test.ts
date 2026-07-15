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
});
