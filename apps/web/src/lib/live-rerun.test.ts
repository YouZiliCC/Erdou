import { describe, it, expect } from "vitest";
import { shouldRerun } from "./live-rerun.js";

describe("shouldRerun", () => {
  it("skips when fsVersion is unchanged since the last run finished (the run's own writes)", () => {
    // Bundle & Run wrote /dist, bumping fsVersion from 3 to 7; `doRun` recorded
    // lastRunFsVersion = 7. No further edits happened, so fsVersion is still 7.
    expect(shouldRerun(7, 7)).toBe(false);
  });

  it("skips even if fsVersion somehow regressed (defensive: never re-run on <=)", () => {
    expect(shouldRerun(5, 7)).toBe(false);
  });

  it("re-runs once a real external edit lands after the run settled", () => {
    // A terminal/agent edit after the run bumps fsVersion past what doRun recorded.
    expect(shouldRerun(8, 7)).toBe(true);
  });

  it("re-runs on the very first check when nothing has run yet (lastRunFsVersion 0) and the fs already has content", () => {
    expect(shouldRerun(1, 0)).toBe(true);
  });
});
