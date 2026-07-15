import { describe, it, expect } from "vitest";
import { truncate } from "./studio.js";

describe("truncate", () => {
  it("returns short strings unchanged", () => {
    expect(truncate("hello", 60)).toBe("hello");
  });

  it("collapses internal whitespace/newlines to single spaces", () => {
    expect(truncate("path: /a/b\ncontent: line1\nline2", 60)).toBe("path: /a/b content: line1 line2");
  });

  it("trims leading/trailing whitespace", () => {
    expect(truncate("  padded  ", 60)).toBe("padded");
  });

  it("cuts to max length and appends an ellipsis when over the limit", () => {
    const long = "a".repeat(100);
    const out = truncate(long, 60);
    expect(out).toBe("a".repeat(60) + "…");
    expect(out.length).toBe(61);
  });

  it("does not truncate a string exactly at the limit", () => {
    const exact = "a".repeat(60);
    expect(truncate(exact, 60)).toBe(exact);
  });
});
