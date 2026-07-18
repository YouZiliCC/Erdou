// Markup-level tests for the Log tab (log lane). Node environment, no jsdom:
// static-markup rendering only — effects (pinned auto-scroll) and the onScroll
// handler aren't exercised, which is fine for these guarantees:
//   L1 — every systemLog line renders (all kinds, in order — newest last),
//        error lines red-accented (.sysline.err), the rest muted (.sysline),
//        with `detail` surfaced the way Conversation's SystemLine does.
//   L2 — an empty systemLog renders the empty-state hint, not a blank panel.
//   L3 — kind:"artifact" entries (a no-run export, studio.ts logSystem path)
//        render the download card (live/expired, matching Conversation's
//        ArtifactCard semantics), never their raw JSON `detail`.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LogPanel } from "./LogPanel";
import type { Studio, TraceLine } from "../lib/studio";

let nextId = 1;
function line(kind: TraceLine["kind"], text: string, detail?: string): TraceLine {
  return { id: nextId++, kind, text, detail, ts: 0 };
}

function render(systemLog: TraceLine[], exports: Studio["exports"] = new Map()): string {
  const studio = { systemLog, exports } as unknown as Studio;
  return renderToStaticMarkup(createElement(LogPanel, { studio }));
}

describe("LogPanel lines (L1)", () => {
  it("renders system and error lines with their detail, error lines err-classed", () => {
    const html = render([
      line("system", "Mounted local folder", 'folder "demo"'),
      line("error", "Failed to sync to local folder", "NotAllowedError: write permission lost"),
    ]);
    expect(html).toContain("Mounted local folder");
    expect(html).toContain('folder &quot;demo&quot;');
    expect(html).toContain("Failed to sync to local folder");
    expect(html).toContain("NotAllowedError: write permission lost");
    expect(html).toContain('class="sysline err"');
    // The system line stays muted: exactly one err-classed line.
    expect(html.match(/sysline err/g)).toHaveLength(1);
    expect(html.match(/class="sysline\s*"/g)).toHaveLength(1);
  });

  it("keeps log order — newest at the bottom", () => {
    const html = render([line("system", "first booted"), line("system", "second synced"), line("error", "third failed")]);
    const first = html.indexOf("first booted");
    const second = html.indexOf("second synced");
    const third = html.indexOf("third failed");
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(second);
    expect(second).toBeLessThan(third);
  });

  it("renders no detail span when detail is absent or duplicates the text", () => {
    const html = render([line("system", "Runtime booted."), line("error", "Mount rescan failed", "Mount rescan failed")]);
    expect(html).not.toContain('class="detail"');
  });
});

describe("LogPanel empty state (L2)", () => {
  it("renders the empty-state hint instead of a blank panel", () => {
    const html = render([]);
    expect(html).toContain("No system messages yet.");
    expect(html).not.toContain("sysline");
  });
});

describe("LogPanel artifact card (L3)", () => {
  const detail = JSON.stringify({ exportId: "e1", name: "demo.zip", byteSize: 2048, fileCount: 3 });

  it("renders a live download card — not the raw JSON payload — when the export is registered", () => {
    const exports = new Map([["e1", { url: "blob:erdou/1", name: "demo.zip", byteSize: 2048, fileCount: 3 }]]);
    const html = render([line("artifact", "Project packaged: demo.zip (3 files)", detail)], exports);
    expect(html).toContain('class="artifact"');
    expect(html).toContain("demo.zip");
    expect(html).toContain("2.0 KB");
    expect(html).toContain("3 files");
    expect(html).toContain('href="blob:erdou/1"');
    expect(html).toContain('download="demo.zip"');
    expect(html).not.toContain("expired");
    // The JSON detail feeds the card; it must never leak as sysline text.
    expect(html).not.toContain("exportId");
    expect(html).not.toContain("sysline");
  });

  it("renders the SAME card expired when the id is absent (reloaded browser lost the blob)", () => {
    const html = render([line("artifact", "Project packaged: demo.zip (3 files)", detail)]);
    expect(html).toContain('class="artifact expired"');
    expect(html).toContain("demo.zip"); // facts still shown
    expect(html).toContain("download expired");
    expect(html).not.toContain("<a "); // no dead download link
    expect(html).not.toContain("blob:"); // and no stale URL
  });

  it("renders an explicit error, not a broken card or raw text, on an unreadable payload", () => {
    const html = render([line("artifact", "Project packaged: demo.zip (3 files)", "not json")]);
    expect(html).not.toContain('class="artifact"');
    expect(html).toContain("Broken export card");
  });

  it("mixes cards and syslines in log order", () => {
    const exports = new Map([["e1", { url: "blob:erdou/1", name: "demo.zip", byteSize: 2048, fileCount: 3 }]]);
    const html = render(
      [line("system", "Runtime booted."), line("artifact", "Project packaged", detail), line("error", "later failure")],
      exports,
    );
    const booted = html.indexOf("Runtime booted.");
    const card = html.indexOf('class="artifact"');
    const failure = html.indexOf("later failure");
    expect(booted).toBeGreaterThan(-1);
    expect(booted).toBeLessThan(card);
    expect(card).toBeLessThan(failure);
  });
});
