// Markup-level regression tests for the task sidebar (fix-pass, run-manage
// wave). Node environment, no jsdom: static-markup rendering only — effects
// and event handlers aren't exercised, which is fine for these guarantees:
//   R1 — status CHIPS are gone from the sidebar; the only status affordance is
//        the pulsing .run-dot on the thread whose turn is in flight.
//   R2 — a RUNNING row's delete button is disabled (with the stop-first
//        explanation as its title), so Studio.deleteRun's running-run refusal
//        is an unreachable backstop rather than a silent no-op the user hits.
//   R3 — idle rows expose enabled rename/delete row-actions.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskSidebar } from "./TaskSidebar";
import type { Run, Studio } from "../lib/studio";

function makeRun(id: string, status: Run["status"]): Run {
  return { id, title: `title-${id}`, task: `task-${id}`, status, trace: [], changes: [], messages: [], createdAt: 0 };
}

function render(runs: Run[], activeRunId: string | null = null): string {
  const studio = {
    runs,
    activeRunId,
    mount: null,
    pendingMount: null,
    mountName: null,
  } as unknown as Studio;
  return renderToStaticMarkup(
    createElement(TaskSidebar, { studio, onNew: () => {}, onOpenFolder: () => {}, onCollapse: () => {} }),
  );
}

describe("TaskSidebar status affordance (R1)", () => {
  it("renders the pulsing run-dot ONLY on the running thread — and no status chips at all", () => {
    const html = render([makeRun("a", "running"), makeRun("b", "review"), makeRun("c", "done")]);
    expect(html.match(/run-dot/g)).toHaveLength(1);
    expect(html).not.toContain("chip");
    // Status words never appear as row text (titles/tasks are prefixed above).
    for (const status of ["running", "review", "done", "error"]) {
      expect(html).not.toContain(`>${status}<`);
    }
  });

  it("renders no run-dot when nothing is in flight", () => {
    const html = render([makeRun("a", "review"), makeRun("b", "error")]);
    expect(html).not.toContain("run-dot");
  });
});

describe("TaskSidebar delete guard (R2)", () => {
  it("disables the running row's delete button and explains the two-step path in its title", () => {
    const html = render([makeRun("a", "running")]);
    expect(html).toContain("disabled");
    expect(html).toContain("Stop the task first, then delete it");
    expect(html).not.toContain('title="Delete task"'); // the enabled variant is absent
  });

  it("keeps idle rows' delete buttons enabled", () => {
    const html = render([makeRun("a", "done"), makeRun("b", "review")]);
    expect(html).not.toContain("disabled");
    expect(html).toContain('title="Delete task"');
  });
});

describe("TaskSidebar row actions (R3)", () => {
  it("every row carries the hover-revealed rename and delete actions", () => {
    const html = render([makeRun("a", "done"), makeRun("b", "error")]);
    expect(html.match(/row-actions/g)).toHaveLength(2);
    expect(html.match(/title="Rename task"/g)).toHaveLength(2);
    expect(html.match(/title="Delete task"/g)).toHaveLength(2);
  });
});
