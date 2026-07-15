import { describe, it, expect } from "vitest";
import { capRuns } from "./runs-store.js";
import type { Run } from "./studio.js";

const mkRun = (id: string): Run => ({
  id,
  title: id,
  task: id,
  status: "done",
  trace: [],
  changes: [],
  createdAt: 0,
});

describe("capRuns", () => {
  it("keeps the most recent 20 (front of the list)", () => {
    const runs = Array.from({ length: 25 }, (_, i) => mkRun(`r${i}`));
    const capped = capRuns(runs);
    expect(capped).toHaveLength(20);
    expect(capped[0]?.id).toBe("r0");
    expect(capped[19]?.id).toBe("r19");
  });

  it("leaves shorter lists untouched", () => {
    const runs = [mkRun("a"), mkRun("b")];
    expect(capRuns(runs)).toEqual(runs);
  });
});
