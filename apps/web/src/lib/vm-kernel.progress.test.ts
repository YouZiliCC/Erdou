import { describe, it, expect } from "vitest";
import { downloadPhaseReporter } from "./vm-kernel.js";

const MB = 1024 * 1024;

/** Reporter wired to a capture array + a manually-advanced clock. */
function harness(startAt = 1000) {
  const phases: string[] = [];
  let t = startAt;
  const report = downloadPhaseReporter((p) => phases.push(p), () => t);
  return { phases, report, advance: (ms: number) => { t += ms; } };
}

describe("downloadPhaseReporter", () => {
  it("formats cumulative progress as 'Downloading VM image… X / Y MB' when the total is known", () => {
    const { phases, report, advance } = harness();
    report(12 * MB, 48 * MB);
    advance(250);
    report(24 * MB, 48 * MB);
    expect(phases).toEqual([
      "Downloading VM image… 12 / 48 MB",
      "Downloading VM image… 24 / 48 MB",
    ]);
  });

  it("falls back to 'X MB' (no total) when Content-Length was absent", () => {
    const { phases, report } = harness();
    report(5 * MB, null);
    expect(phases).toEqual(["Downloading VM image… 5 MB"]);
  });

  it("throttles to at most one update per 200ms — chunk floods do not flood the UI", () => {
    const { phases, report, advance } = harness();
    for (let i = 1; i <= 100; i++) {
      report(i * MB, null);
      advance(10); // 100 chunks over 1s -> at most ~5 emitted
    }
    expect(phases.length).toBeLessThanOrEqual(6);
    expect(phases[0]).toBe("Downloading VM image… 1 MB"); // first chunk emits immediately
    // every emitted line is monotone non-decreasing in MB
    const mbs = phases.map((p) => Number(/… (\d+) MB/.exec(p)![1]));
    expect([...mbs].sort((a, b) => a - b)).toEqual(mbs);
  });

  it("always emits the final byte count (loaded === total), even inside the throttle window", () => {
    const { phases, report, advance } = harness();
    report(47 * MB, 48 * MB);
    advance(10); // well inside the throttle window
    report(48 * MB, 48 * MB);
    expect(phases).toEqual([
      "Downloading VM image… 47 / 48 MB",
      "Downloading VM image… 48 / 48 MB",
    ]);
  });

  it("rounds byte counts to whole MB", () => {
    const { phases, report } = harness();
    report(11.6 * MB, 48.4 * MB);
    expect(phases).toEqual(["Downloading VM image… 12 / 48 MB"]);
  });
});
