import { describe, it, expect } from "vitest";
import { buildFileChanges, SnapshotReader } from "./snapshot-read.js";
import type { Snapshot } from "@erdou/runtime-contract";

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

describe("SnapshotReader", () => {
  const b64 = (s: string): string => btoa(s);
  const snap: Snapshot = {
    version: 1,
    createdAtMs: 0,
    fs: {
      type: "directory",
      mode: 0o755,
      children: {
        "a.txt": { type: "file", mode: 0o644, data: b64("hello") },
        sub: {
          type: "directory",
          mode: 0o755,
          children: { "b.txt": { type: "file", mode: 0o644, data: b64("nested") } },
        },
        link: { type: "symlink", mode: 0o777, target: "/a.txt" },
      },
    },
  };

  it("reads files at any depth straight from the tree, without a runtime", () => {
    const reader = SnapshotReader.open(snap);
    expect(reader.read("/a.txt")).toBe("hello");
    expect(reader.read("/sub/b.txt")).toBe("nested");
  });

  it("returns null for missing paths, directories, and symlinks", () => {
    const reader = SnapshotReader.open(snap);
    expect(reader.read("/missing")).toBeNull();
    expect(reader.read("/sub")).toBeNull();
    expect(reader.read("/link")).toBeNull();
  });

  it("filesUnder lists every file beneath a directory (symlinks skipped), and [] for non-directories", () => {
    const reader = SnapshotReader.open(snap);
    expect(reader.filesUnder("/").sort()).toEqual(["/a.txt", "/sub/b.txt"]);
    expect(reader.filesUnder("/sub")).toEqual(["/sub/b.txt"]);
    expect(reader.filesUnder("/a.txt")).toEqual([]); // a file
    expect(reader.filesUnder("/link")).toEqual([]); // a symlink
    expect(reader.filesUnder("/missing")).toEqual([]);
  });
});
