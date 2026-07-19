// Markup-level tests for the kind:"subagent" delegate card (multi-agent lane),
// in the Conversation.test.ts idiom: node environment, static markup only —
// the card seeds collapsed (useState(false)), so these cover the header line,
// the always-visible conflict/error summary, and the broken-payload guard.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Conversation } from "./Conversation";
import type { Run, Studio, TraceLine } from "../lib/studio";
import type { SubagentDetail } from "../lib/delegate";

function subagentLine(detail: string): TraceLine {
  return { id: 1, kind: "subagent", text: "sub-agent · api", detail, ts: 0 };
}

function makeRun(trace: TraceLine[]): Run {
  return { id: "r1", title: "t", task: "fan out", status: "running", trace, changes: [], messages: [], createdAt: 0 };
}

function render(trace: TraceLine[]) {
  const studio = {
    activeRun: makeRun(trace),
    systemLog: [],
    exports: new Map(),
    pendingApproval: null,
  } as unknown as Studio;
  return renderToStaticMarkup(createElement(Conversation, { studio, onExample: () => {} }));
}

const detailOf = (over: Partial<SubagentDetail>): string =>
  JSON.stringify({
    role: "api",
    task: "build the api endpoints",
    status: "running",
    steps: 0,
    summary: "",
    trace: [],
    ...over,
  } satisfies SubagentDetail);

describe("Conversation subagent card", () => {
  it("renders a running child as a busy collapsed card (no body until expanded)", () => {
    const html = render([subagentLine(detailOf({}))]);
    expect(html).toContain('class="subagent"');
    expect(html).toContain("sub-agent · api");
    expect(html).toContain("running…");
    expect(html).toContain('class="dot busy"');
    expect(html).toContain('aria-expanded="false"');
    // Collapsed: the task brief lives in the body only.
    expect(html).not.toContain("build the api endpoints");
    expect(html).not.toContain("subagent-body");
  });

  it("renders a finished child with status + step count and an ok dot", () => {
    const html = render([subagentLine(detailOf({ status: "done", steps: 3, summary: "API built." }))]);
    expect(html).toContain('class="dot ok"');
    expect(html).toContain("done · 3 steps");
    // A clean completion pins no summary strip.
    expect(html).not.toContain("subagent-summary");
  });

  it("pins a conflict summary OUTSIDE the collapsed body — a rejected merge must be visible", () => {
    const html = render([
      subagentLine(
        detailOf({
          status: "conflict",
          steps: 4,
          summary: "conflict: /shared.ts already changed by an earlier sub-agent",
        }),
      ),
    ]);
    expect(html).toContain('class="dot fail"');
    expect(html).toContain("conflict — changes rejected");
    expect(html).toContain("subagent-summary");
    expect(html).toContain("/shared.ts already changed by an earlier sub-agent");
  });

  it("pins a failed child's error summary the same way", () => {
    const html = render([subagentLine(detailOf({ status: "error", summary: "sub-agent sandbox failed: boom" }))]);
    expect(html).toContain("failed");
    expect(html).toContain("sub-agent sandbox failed: boom");
  });

  it("renders an explicit error, not a broken card, on an unreadable persisted payload", () => {
    const html = render([subagentLine("not json")]);
    expect(html).not.toContain('class="subagent"');
    expect(html).toContain("Broken sub-agent card");
  });
});
