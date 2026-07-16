import { describe, it, expect } from "vitest";
import { eventsSettled } from "./studio.js";

describe("eventsSettled", () => {
  it("lets an event delivered on a later macrotask land before reads", async () => {
    const changed = new Set<string>();
    // The async-runtime case: the mutation resolved, but its file.changed is
    // still in flight on the macrotask queue.
    setTimeout(() => changed.add("/late.txt"), 0);
    expect(changed.has("/late.txt")).toBe(false);
    await eventsSettled();
    expect(changed.has("/late.txt")).toBe(true);
  });
});
