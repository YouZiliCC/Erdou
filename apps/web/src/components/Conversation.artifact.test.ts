// Markup-level tests for the kind:"artifact" download card (zip-export lane),
// in the Conversation.test.ts idiom: node environment, static markup only.
//   - live card: the exportId is in studio.exports -> a real <a download> on
//     the object URL.
//   - expired card: the id is ABSENT (reloaded browser: the trace persisted,
//     the blob did not) -> same card, disabled, with the honest expiry note.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Conversation } from "./Conversation";
import type { Run, Studio, TraceLine } from "../lib/studio";

function artifactLine(detail: string): TraceLine {
  return { id: 1, kind: "artifact", text: "Project packaged: demo.zip (3 files)", detail, ts: 0 };
}

function makeRun(trace: TraceLine[]): Run {
  return { id: "r1", title: "t", task: "export it", status: "done", trace, changes: [], messages: [], createdAt: 0 };
}

const detail = JSON.stringify({ exportId: "e1", name: "demo.zip", byteSize: 2048, fileCount: 3 });

function render(opts: { trace?: TraceLine[]; systemLog?: TraceLine[]; exports?: Studio["exports"] }) {
  const studio = {
    activeRun: opts.trace ? makeRun(opts.trace) : undefined,
    systemLog: opts.systemLog ?? [],
    exports: opts.exports ?? new Map(),
    pendingApproval: null,
  } as unknown as Studio;
  return renderToStaticMarkup(createElement(Conversation, { studio, onExample: () => {} }));
}

describe("Conversation artifact card", () => {
  it("renders a live download card when the export is registered", () => {
    const exports = new Map([["e1", { url: "blob:erdou/1", name: "demo.zip", byteSize: 2048, fileCount: 3 }]]);
    const html = render({ trace: [artifactLine(detail)], exports });
    expect(html).toContain('class="artifact"');
    expect(html).toContain("demo.zip");
    expect(html).toContain("2.0 KB");
    expect(html).toContain("3 files");
    expect(html).toContain('href="blob:erdou/1"');
    expect(html).toContain('download="demo.zip"');
    expect(html).not.toContain("expired");
  });

  it("renders the SAME card expired when the id is absent (reloaded browser lost the blob)", () => {
    const html = render({ trace: [artifactLine(detail)] });
    expect(html).toContain('class="artifact expired"');
    expect(html).toContain("demo.zip"); // facts still shown
    expect(html).toContain("download expired");
    expect(html).toContain("ask the agent to package the project again");
    expect(html).not.toContain("<a "); // no dead download link
    expect(html).not.toContain("blob:"); // and no stale URL
  });

  it("the empty state does NOT render systemLog artifacts — the Log tab owns that flow now", () => {
    // A manual export with no run lands in systemLog; its download affordance
    // lives in LogPanel (see LogPanel tests), not the decluttered first-run view.
    const html = render({ systemLog: [artifactLine(detail)] });
    expect(html).not.toContain("artifact");
    expect(html).not.toContain("demo.zip");
  });

  it("renders an explicit error, not a broken card, on an unreadable persisted payload", () => {
    const html = render({ trace: [artifactLine("not json")] });
    expect(html).not.toContain('class="artifact"');
    expect(html).toContain("Broken export card");
  });

  it("agent text interleaves with the card as a plain block, not monologue framing", () => {
    const thought: TraceLine = { id: 2, kind: "thought", text: "Packaged the project for download.", ts: 0 };
    const html = render({ trace: [thought, artifactLine(detail)] });
    expect(html).toContain("Packaged the project for download.");
    expect(html).toContain('class="msg agent"');
    expect(html).not.toContain("agent · thinking");
    expect(html).not.toContain('class="think"');
  });
});
