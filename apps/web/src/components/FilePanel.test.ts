// Regression pin for the file viewer's stale-read race. Node environment, no
// jsdom: static-markup rendering never runs effects, so the effect's await
// ordering is pinned at source level (the SettingsDialog.test.ts /
// PreviewPanel.test.ts precedent).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("FilePanel: a stale readFileText completion must not win", () => {
  // studio.readFileText is a real RPC on the VM kernel (variable latency), so
  // completions can invert: click large file A (slow read in flight), then
  // click small file B — B's effect run resolves first, then A's read lands
  // and, with an unguarded setContent, overwrites B's content while the viewer
  // header still shows B's path. The cleanup already flips `alive`; the read
  // just has to re-check it AFTER its own await, as the readTree above it does.
  const src = readFileSync(new URL("./FilePanel.tsx", import.meta.url), "utf8");

  it("re-checks `alive` between the readFileText await and setContent", () => {
    expect(src).not.toContain("setContent(await");
    expect(src).toMatch(
      /const text = await studio\.readFileText\(sel\);\s*\n\s*if \(!alive\) return;\s*\n\s*setContent\(text\);/,
    );
  });

  it("a stale read FAILURE cannot clear the newer selection either", () => {
    expect(src).toMatch(/catch\s*\{\s*\n\s*if \(alive\) setSel\(null\);/);
  });
});
