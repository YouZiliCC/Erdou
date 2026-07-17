import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Studio } from "./studio.js";
import type { DirHandleLike, FileHandleLike, MountMtimes } from "./local-mount.js";

// Studio persists the mount handle to IndexedDB, which isn't polyfilled in this
// package's (node) test environment. Keep the real load/save/rescan behavior
// from local-mount.ts, but stub out the IndexedDB-backed handle persistence —
// that plumbing is exercised elsewhere (it's untouched by this task).
vi.mock("./local-mount.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./local-mount.js")>();
  return {
    ...actual,
    persistHandle: vi.fn(async () => {}),
    loadPersistedHandle: vi.fn(async () => null),
    clearPersistedHandle: vi.fn(async () => {}),
  };
});

const enc = new TextEncoder();

class MockFile implements FileHandleLike {
  kind = "file" as const;
  constructor(
    public data: Uint8Array,
    public lastModified = 0,
  ) {}
  async getFile() {
    const d = this.data;
    const lastModified = this.lastModified;
    return { arrayBuffer: async () => d.slice().buffer, lastModified };
  }
  async createWritable() {
    const self = this;
    return {
      async write(d: BufferSource) {
        self.data = new Uint8Array(d as Uint8Array);
      },
      async close() {},
    };
  }
}

class MockDir implements DirHandleLike {
  kind = "directory" as const;
  children = new Map<string, MockFile | MockDir>();
  constructor(public name: string) {}
  async *entries(): AsyncIterableIterator<[string, FileHandleLike | DirHandleLike]> {
    for (const [k, v] of this.children) yield [k, v];
  }
  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandleLike> {
    let d = this.children.get(name);
    if (!d) {
      if (!opts?.create) throw new Error("ENOENT");
      d = new MockDir(name);
      this.children.set(name, d);
    }
    return d as MockDir;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandleLike> {
    let f = this.children.get(name);
    if (!f) {
      if (!opts?.create) throw new Error("ENOENT");
      f = new MockFile(new Uint8Array());
      this.children.set(name, f);
    }
    return f as MockFile;
  }
}

type Internals = {
  mountMtimes: MountMtimes;
  mountWatch?: { interval: ReturnType<typeof setInterval>; onFocus: () => void };
};

describe("Studio mount watcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { hidden: false });
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("mountFolder threads mountMtimes through load, and starts the watcher", async () => {
    const root = new MockDir("project");
    root.children.set("a.txt", new MockFile(enc.encode("v1"), 1000));

    const studio = new Studio();
    await studio.mountFolder(root);

    expect(studio.mount).toBe(root);
    expect(await studio.readFileText("/a.txt")).toBe("v1");
    // mtime recorded from the load, keyed by the vfs path (Step 2).
    expect((studio as unknown as Internals).mountMtimes.get("/a.txt")).toBe(1000);
    // Watcher registered a focus listener and an interval (Step 3).
    expect(window.addEventListener).toHaveBeenCalledWith("focus", expect.any(Function));
    expect((studio as unknown as Internals).mountWatch).toBeDefined();
  });

  it("polls on a 5s interval and pulls external disk edits into the VFS", async () => {
    const root = new MockDir("project");
    root.children.set("a.txt", new MockFile(enc.encode("v1"), 1000));

    const studio = new Studio();
    await studio.mountFolder(root);
    const versionAfterMount = studio.fsVersion;

    // No external change yet: a tick should be a no-op.
    await vi.advanceTimersByTimeAsync(5000);
    expect(studio.fsVersion).toBe(versionAfterMount);
    expect(await studio.readFileText("/a.txt")).toBe("v1");

    // Simulate an external edit on disk (same handle, newer mtime).
    root.children.set("a.txt", new MockFile(enc.encode("v2"), 2000));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await studio.readFileText("/a.txt")).toBe("v2");
    expect(studio.fsVersion).toBeGreaterThan(versionAfterMount);
  });

  it("does not poll while the tab is hidden, and unmount stops the watcher cleanly", async () => {
    const root = new MockDir("project");
    root.children.set("a.txt", new MockFile(enc.encode("v1"), 1000));

    const studio = new Studio();
    await studio.mountFolder(root);

    (document as unknown as { hidden: boolean }).hidden = true;
    root.children.set("a.txt", new MockFile(enc.encode("v2"), 2000));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await studio.readFileText("/a.txt")).toBe("v1"); // not pulled while hidden

    (document as unknown as { hidden: boolean }).hidden = false;
    await studio.unmount();
    expect((studio as unknown as Internals).mountWatch).toBeUndefined();
    expect(window.removeEventListener).toHaveBeenCalledWith("focus", expect.any(Function));

    // Further ticks (interval already cleared) must not resurrect the pull.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await studio.readFileText("/a.txt")).toBe("v1");
  });
});

describe("Studio.reselectFolder — a folder swap REPLACES the workspace (data safety)", () => {
  beforeEach(() => {
    // boot() installs the A4 unload-flush handlers, so the document stub needs
    // addEventListener alongside the watcher's `hidden` read.
    vi.stubGlobal("document", { hidden: false, addEventListener: vi.fn(), visibilityState: "visible" });
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("swapping folder A→B clears A out of the VFS and the auto-save never mirrors A's files onto B's disk", async () => {
    // Folder A is the initially-mounted project.
    const folderA = new MockDir("project-A");
    folderA.children.set("a-only.txt", new MockFile(enc.encode("A"), 1000));

    const studio = new Studio();
    // boot() wires the file.changed → folder auto-save subscription — the exact
    // vector the bug rides (mount+load emits file.changed → debounced saveToFolder).
    await studio.boot();
    await studio.mountFolder(folderA);
    expect(await studio.readFileText("/a-only.txt")).toBe("A");

    // The re-select picker returns a DIFFERENT folder B (no a-only.txt).
    const folderB = new MockDir("project-B");
    folderB.children.set("b-only.txt", new MockFile(enc.encode("B"), 2000));
    (window as unknown as { showDirectoryPicker: () => Promise<DirHandleLike> }).showDirectoryPicker =
      async () => folderB;

    vi.useFakeTimers();
    const ok = await studio.reselectFolder();
    expect(ok).toBe(true);
    expect(studio.mount).toBe(folderB);

    // The workspace is now B alone — NOT A ∪ B: A's file is gone, B's is present.
    expect(studio.fs.exists("/a-only.txt")).toBe(false);
    expect(await studio.readFileText("/b-only.txt")).toBe("B");

    // Keep working in B: an edit schedules the debounced folder auto-save, which
    // mirrors the WHOLE workspace back to the mounted folder (B). This is exactly
    // when a leaked A-file would be written onto B's real disk.
    studio.fs.writeFile("/notes.txt", enc.encode("kept working in B"));
    await vi.advanceTimersByTimeAsync(1000);

    // B's on-disk contents: only B's own file + the new edit — NEVER A's file.
    expect(folderB.children.has("a-only.txt")).toBe(false);
    expect(folderB.children.has("b-only.txt")).toBe(true);
    expect(folderB.children.has("notes.txt")).toBe(true);
  });
});

describe("Studio.mountFolder — the INITIAL mount replaces a restored workspace (A2 data safety)", () => {
  beforeEach(() => {
    vi.stubGlobal("document", { hidden: false, addEventListener: vi.fn(), visibilityState: "visible" });
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("mounting into a non-empty (boot-restored) workspace clears it first — the old project never unions onto the folder's disk", async () => {
    // Session 1: a project lives in the browser and is snapshotted to IndexedDB.
    const prev = new Studio();
    await prev.boot();
    prev.fs.writeFile("/old-project.txt", enc.encode("stale"));
    await prev.save();

    // Session 2: boot restores that project into the VFS, THEN the user mounts
    // a real folder (e.g. a freshly cloned git repo).
    const studio = new Studio();
    await studio.boot();
    expect(studio.fs.exists("/old-project.txt")).toBe(true);

    const repo = new MockDir("repo");
    repo.children.set("repo.txt", new MockFile(enc.encode("repo"), 1000));
    vi.useFakeTimers();
    await studio.mountFolder(repo);

    // The workspace is the folder alone — NOT old ∪ folder.
    expect(studio.fs.exists("/old-project.txt")).toBe(false);
    expect(await studio.readFileText("/repo.txt")).toBe("repo");
    // The replacement was surfaced to the user.
    expect(studio.systemLog.some((l) => l.text.startsWith("Replaced the in-browser workspace"))).toBe(true);

    // Keep working: the debounced folder auto-save mirrors the workspace back
    // to the mounted disk — exactly when a leaked old file would corrupt the repo.
    studio.fs.writeFile("/notes.txt", enc.encode("new work"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(repo.children.has("old-project.txt")).toBe(false);
    expect(repo.children.has("repo.txt")).toBe(true);
    expect(repo.children.has("notes.txt")).toBe(true);
  });

  it("mounting into an EMPTY workspace loads additively and stays quiet (no replacement log)", async () => {
    const studio = new Studio(); // no boot → nothing restored, VFS empty
    const folder = new MockDir("fresh");
    folder.children.set("f.txt", new MockFile(enc.encode("x"), 1000));
    await studio.mountFolder(folder);
    expect(await studio.readFileText("/f.txt")).toBe("x");
    expect(studio.systemLog.some((l) => l.text.startsWith("Replaced the in-browser workspace"))).toBe(false);
  });
});
