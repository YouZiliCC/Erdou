import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDbSnapshotStore } from "./indexeddb-store.js";
import type { Snapshot } from "@erdou/runtime-contract";

const snap: Snapshot = {
  version: 1,
  createdAtMs: 0,
  fs: { type: "directory", mode: 0o755, children: { "a.txt": { type: "file", mode: 0o644, data: "aGk=" } } },
};

describe("IndexedDbSnapshotStore", () => {
  beforeEach(() => {
    // Fresh in-memory IndexedDB per test.
    globalThis.indexedDB = new IDBFactory();
  });

  it("saves, loads, lists and deletes snapshots", async () => {
    const store = new IndexedDbSnapshotStore();
    await store.save("proj", snap);
    expect(await store.list()).toEqual(["proj"]);
    expect(await store.load("proj")).toEqual(snap);
    await store.delete("proj");
    expect(await store.load("proj")).toBeNull();
  });

  it("returns null for an unknown id", async () => {
    const store = new IndexedDbSnapshotStore();
    expect(await store.load("nope")).toBeNull();
  });
});
