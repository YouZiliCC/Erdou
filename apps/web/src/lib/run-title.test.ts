import { describe, it, expect } from "vitest";
import { runTitle, cleanTitle } from "./run-title.js";

describe("runTitle (instant placeholder)", () => {
  it("uses the first non-empty line", () => {
    expect(runTitle("Build a todo app\n\nwith drag and drop")).toBe("Build a todo app");
  });

  it("falls back to the whole task when the first line is blank", () => {
    expect(runTitle("\n\n  Fix the login bug  ")).toBe("Fix the login bug");
  });

  it("caps at ~48 chars with an ellipsis", () => {
    const long = "Please build me a very elaborate dashboard with many charts and filters";
    const t = runTitle(long);
    expect(t.length).toBeLessThanOrEqual(48);
    expect(t.endsWith("…")).toBe(true);
  });
});

describe("cleanTitle (model-summarized title)", () => {
  it("passes a tidy title through unchanged", () => {
    expect(cleanTitle("Todo app with drag-and-drop")).toBe("Todo app with drag-and-drop");
  });

  it("strips wrapping quotes (straight and curly)", () => {
    expect(cleanTitle('"Fix the login bug"')).toBe("Fix the login bug");
    expect(cleanTitle("“登录问题修复”")).toBe("登录问题修复");
    expect(cleanTitle("`erdou serve setup`")).toBe("erdou serve setup");
  });

  it("takes only the first non-empty line of a chatty reply", () => {
    expect(cleanTitle("\n\nExpense Tracker\n\nHere is a concise title for the task.")).toBe("Expense Tracker");
  });

  it("strips trailing sentence punctuation (ASCII + CJK)", () => {
    expect(cleanTitle("Refactor the auth module.")).toBe("Refactor the auth module");
    expect(cleanTitle("生成对话标题。")).toBe("生成对话标题");
  });

  it("collapses internal whitespace and caps overly long output", () => {
    const t = cleanTitle("A    ridiculously    long    title    that    the    model    should    not    have    made");
    expect(t.length).toBeLessThanOrEqual(48);
    expect(t).not.toContain("  ");
  });

  it("returns '' for an empty/whitespace-only reply so the placeholder is kept", () => {
    expect(cleanTitle("")).toBe("");
    expect(cleanTitle("   \n  \n ")).toBe("");
  });
});
