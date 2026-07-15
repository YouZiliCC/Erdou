import { describe, it, expect } from "vitest";
import { buildFileChanges } from "./snapshot-read.js";

describe("buildFileChanges", () => {
  it("classifies create/modify/delete, skips net-unchanged, sorts by path", () => {
    const before = new Map([
      ["/b.txt", "old"],
      ["/c.txt", "same"],
      ["/d.txt", "gone"],
    ]);
    const after = new Map([
      ["/a.txt", "new"],
      ["/b.txt", "changed"],
      ["/c.txt", "same"],
    ]);
    const touched = ["/d.txt", "/a.txt", "/b.txt", "/c.txt"]; // deliberately unsorted
    const readBefore = (p: string): string | null => before.get(p) ?? null;
    const readAfter = (p: string): string | null => after.get(p) ?? null;

    const changes = buildFileChanges(touched, readBefore, readAfter);

    // /c.txt is touched but identical -> dropped; result is sorted by path.
    expect(changes.map((c) => [c.path, c.kind])).toEqual([
      ["/a.txt", "create"],
      ["/b.txt", "modify"],
      ["/d.txt", "delete"],
    ]);
    expect(changes.find((c) => c.path === "/a.txt")).toMatchObject({ before: "", after: "new" });
    expect(changes.find((c) => c.path === "/b.txt")).toMatchObject({ before: "old", after: "changed" });
    expect(changes.find((c) => c.path === "/d.txt")).toMatchObject({ before: "gone", after: "" });
  });
});
