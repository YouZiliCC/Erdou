// Regression tests for conversation surfacing (audit B1/B3/C4). Node
// environment, no jsdom: static-markup rendering only — effects (auto-scroll)
// don't run and event handlers aren't exercised, which is fine for these
// markup-level guarantees:
//   B1 — an "error" trace line must surface `detail` (the gateway's real
//        failure, e.g. "…401 {invalid_api_key}"), not just "Agent stopped".
//   B3 — systemLog error lines (folder-sync/mount/kernel failures) must stay
//        visible in the active-run view via the .sysbar strip, not only in the
//        first-run empty state.
//   C4 — the empty-state example chips are real <button>s (not dead spans) and
//        every example is a genuine agent task ("Open a local folder" is a
//        sidebar UI action, not a task).
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Conversation } from "./Conversation";
import type { Run, Studio, TraceLine } from "../lib/studio";

let nextId = 1;
function line(kind: TraceLine["kind"], text: string, detail?: string): TraceLine {
  return { id: nextId++, kind, text, detail, ts: 0 };
}

function makeRun(trace: TraceLine[], status: Run["status"] = "error"): Run {
  return { id: "r1", title: "t", task: "do the thing", status, trace, changes: [], messages: [], createdAt: 0 };
}

function render(partial: { activeRun?: Run; systemLog?: TraceLine[]; pendingApproval?: unknown }) {
  const studio = {
    activeRun: partial.activeRun,
    systemLog: partial.systemLog ?? [],
    pendingApproval: partial.pendingApproval,
  } as unknown as Studio;
  return renderToStaticMarkup(createElement(Conversation, { studio, onExample: () => {} }));
}

describe("Conversation error detail (B1)", () => {
  it("renders an error line's detail beneath its text", () => {
    const detail = "openai-compatible chat failed: 401 {invalid_api_key}";
    const html = render({ activeRun: makeRun([line("error", "Agent stopped", detail)]) });
    expect(html).toContain("Agent stopped");
    expect(html).toContain("err-detail");
    expect(html).toContain("401 {invalid_api_key}");
  });

  it("renders no detail block when the error line has none", () => {
    const html = render({ activeRun: makeRun([line("error", "Agent stopped")]) });
    expect(html).toContain("Agent stopped");
    expect(html).not.toContain("err-detail");
  });
});

describe("Conversation system-error strip (B3)", () => {
  it("shows systemLog error lines (with detail) in the active-run view", () => {
    const html = render({
      activeRun: makeRun([]),
      systemLog: [
        line("system", "Mounted local folder"),
        line("error", "Failed to sync to local folder", "NotAllowedError: write permission lost"),
      ],
    });
    expect(html).toContain('class="sysbar"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Failed to sync to local folder");
    expect(html).toContain("NotAllowedError: write permission lost");
    // Non-error system chatter stays out of the strip.
    expect(html).not.toContain("Mounted local folder");
  });

  it("renders no strip when the systemLog has no error lines", () => {
    const html = render({ activeRun: makeRun([]), systemLog: [line("system", "Runtime booted.")] });
    expect(html).not.toContain("sysbar");
  });

  it("caps the strip at the 3 most recent errors", () => {
    const html = render({
      activeRun: makeRun([]),
      systemLog: [
        line("error", "oldest error"),
        line("error", "error two"),
        line("error", "error three"),
        line("error", "error four"),
      ],
    });
    expect(html).not.toContain("oldest error");
    expect(html).toContain("error two");
    expect(html).toContain("error three");
    expect(html).toContain("error four");
  });

  it("still renders the full systemLog (all kinds) in the empty state", () => {
    const html = render({
      systemLog: [line("system", "Runtime booted."), line("error", "Could not restore project.", "quota exceeded")],
    });
    expect(html).toContain("Runtime booted.");
    expect(html).toContain("Could not restore project.");
    expect(html).toContain("quota exceeded");
  });
});

describe("Conversation activity indicator", () => {
  it("shows pulsing dots with 'thinking…' on a running run whose last line is not an in-flight tool", () => {
    const html = render({ activeRun: makeRun([line("thought", "planning the change")], "running") });
    expect(html).toContain('class="activity"');
    expect(html).toContain("activity-dots");
    expect(html).toContain("thinking…");
  });

  it("names the tool when the last line is a tool call still awaiting its result", () => {
    const html = render({
      activeRun: makeRun([line("thought", "ok"), line("tool", "write_file", '{"path":"/a.py"}')], "running"),
    });
    expect(html).toContain("running write_file…");
    expect(html).not.toContain("thinking…");
  });

  it("falls back to 'thinking…' once the tool's result has landed", () => {
    const trace = [line("tool", "write_file"), line("result", "ok")];
    const html = render({ activeRun: makeRun(trace, "running") });
    expect(html).toContain("thinking…");
    expect(html).not.toContain("running write_file…");
  });

  it("shows 'thinking…' on a running run with an empty trace", () => {
    const html = render({ activeRun: makeRun([], "running") });
    expect(html).toContain("thinking…");
  });

  it.each(["done", "review", "error"] as const)("renders no indicator on a %s run", (status) => {
    const html = render({ activeRun: makeRun([line("thought", "planning")], status) });
    expect(html).not.toContain('class="activity"');
    expect(html).not.toContain("thinking…");
  });

  it("yields to the approval prompt while an approval is pending", () => {
    const html = render({
      activeRun: makeRun([line("tool", "run")], "running"),
      pendingApproval: {
        req: { tool: "run", command: "rm -rf build", args: {} },
        resolve: () => {},
        allowAlways: () => {},
      },
    });
    expect(html).toContain('class="approval"');
    expect(html).not.toContain('class="activity"');
  });
});

describe("Conversation example chips (C4)", () => {
  it("renders the examples as buttons, none of them the sidebar-only folder action", () => {
    const html = render({});
    expect(html).not.toContain("Open a local folder");
    const buttons = html.match(/<button type="button">/g) ?? [];
    expect(buttons.length).toBe(3);
    expect(html).toContain("Build a small Python HTTP server and preview it");
    expect(html).toContain("Scaffold a Vite app");
    expect(html).toContain("Write &amp; run a Python script");
  });
});
