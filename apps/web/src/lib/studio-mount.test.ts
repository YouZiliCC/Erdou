import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Studio, type Run } from "./studio.js";
import { Vfs } from "@erdou/runtime-browser";
import type { Runtime } from "@erdou/runtime-contract";
import type { ModelGateway } from "@erdou/model-gateway";
import type { DirHandleLike, FileHandleLike, MountMtimes } from "./local-mount.js";
import { writeFolderState, readFolderState, type FolderState } from "./folder-state.js";
import { saveRuns, loadRuns, clearRuns } from "./runs-store.js";
import { DEFAULT_MODEL } from "./model-config.js";

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
  async removeEntry(name: string, _opts?: { recursive?: boolean }): Promise<void> {
    if (!this.children.delete(name)) throw new Error("ENOENT");
  }
}

// A minimal incoming-VM runtime: `subscribe` is all subscribeRuntime /
// setPreviewRuntime touch post-swap (same stub studio-switch.test.ts uses).
const stubRuntime = (): Runtime => ({ subscribe: () => () => {} }) as unknown as Runtime;

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
    const swap = studio.reselectFolder();
    // The swap ends with an awaited IndexedDB run-history write (project A's
    // chat must not resurrect into B via next session's boot); fake-indexeddb
    // settles through (mocked) setImmediate, so pump the timer queue.
    await vi.advanceTimersByTimeAsync(50);
    const ok = await swap;
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

  it("mounting on the BROWSER kernel clears a preserve-named leftover too — it never unions onto the fresh repo's disk", async () => {
    // A stale /lib in the browser VFS (an old project's dir, or pre-fix VM
    // leakage). On the browser kernel NOTHING at root is image-owned, so the
    // mount-replaces-workspace contract must clear it — keeping it would let
    // the auto-save dump it onto the freshly mounted repo.
    const studio = new Studio();
    await studio.boot();
    studio.fs.mkdir("/lib", { recursive: true });
    studio.fs.writeFile("/lib/old.rb", enc.encode("stale"));

    const repo = new MockDir("repo");
    repo.children.set("repo.txt", new MockFile(enc.encode("repo"), 1000));
    vi.useFakeTimers();
    await studio.mountFolder(repo);

    expect(studio.fs.exists("/lib")).toBe(false); // folder is the sole source of truth
    expect(await studio.readFileText("/repo.txt")).toBe("repo");
    expect(studio.systemLog.some((l) => l.text.startsWith("Replaced the in-browser workspace"))).toBe(true);

    studio.fs.writeFile("/notes.txt", enc.encode("work"));
    await vi.advanceTimersByTimeAsync(1000); // fire the debounced folder auto-save
    expect(repo.children.has("lib")).toBe(false); // the stale dir never reached the repo's disk
    expect(repo.children.has("notes.txt")).toBe(true);
  });
});

describe("vm→browser leak cleanup vs a mounted project's own root dirs (data safety)", () => {
  beforeEach(() => {
    vi.stubGlobal("document", { hidden: false, addEventListener: vi.fn(), visibilityState: "visible" });
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("a mounted repo's root lib/ survives browser→vm→browser, and neither the auto-save nor Push deletes it from the real disk", async () => {
    // The probe scenario from the leak-fix review: a Rails/Ruby-style repo
    // whose root legitimately carries a VM_PRESERVE_DIRS name.
    const repo = new MockDir("rails-repo");
    const lib = new MockDir("lib");
    lib.children.set("util.rb", new MockFile(enc.encode("module Util; end"), 1000));
    repo.children.set("lib", lib);
    repo.children.set("README.md", new MockFile(enc.encode("# repo"), 1000));

    const studio = new Studio();
    await studio.boot();
    await studio.mountFolder(repo);
    expect(await studio.readFileText("/lib/util.rb")).toBe("module Util; end");

    vi.useFakeTimers();
    const fakeVm = { kind: "vm" as const, runtime: stubRuntime(), fs: new Vfs(), openShell: () => studio.shell };
    await studio.switchKernel("vm", { makeKernel: async () => fakeVm });
    await studio.switchKernel("browser");

    // Disk-backed project data is discriminated from VM leakage: /lib is
    // untouched (not deleted, not renamed) and no cleanup line is logged.
    expect(await studio.readFileText("/lib/util.rb")).toBe("module Util; end");
    expect(studio.fs.exists("/lib.vm-leaked")).toBe(false);
    expect(studio.systemLog.some((l) => l.text.includes("leaked into the browser workspace"))).toBe(false);

    // The disk-deletion cascade is closed end-to-end: the debounced auto-save
    // and then an explicit Push leave the repo's lib/ on disk.
    await vi.advanceTimersByTimeAsync(1000);
    expect((repo.children.get("lib") as MockDir).children.has("util.rb")).toBe(true);
    const result = await studio.pushFolderNow();
    expect(result!.deleted).toEqual([]);
    expect((repo.children.get("lib") as MockDir).children.has("util.rb")).toBe(true);
    expect(await studio.readFileText("/lib/util.rb")).toBe("module Util; end");
  });
});

// ---- shared helpers for the mount-count and hydration-race suites below ----

/** Minimal in-memory localStorage — this (node) test environment has none, and
 *  `currentState()` (folder-state saves) reads theme/approval/model from it. */
function makeLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  } as Storage;
}

const mkRun = (id: string, status: Run["status"], createdAt: number, title = id): Run => ({
  id,
  title,
  task: id,
  status,
  trace: [],
  changes: [],
  messages: [],
  createdAt,
});

/** Seed `<folder>/.erdou/runs.json` with `runs`. config.json is then dropped:
 *  the config-hydration plumbing (theme/localStorage/applyTheme) is exercised
 *  in studio-config-version.test.ts — these suites take the runs-only path. */
async function seedFolderState(folder: MockDir, runs: Run[]): Promise<void> {
  await writeFolderState(folder, { runs, config: undefined as unknown as FolderState["config"] });
  (folder.children.get(".erdou") as MockDir).children.delete("config.json");
}

const gatewayWith = (chat: ReturnType<typeof vi.fn>): ModelGateway => ({ chat }) as unknown as ModelGateway;
type GatewaySlot = { gateway: ModelGateway };

/** A MockDir whose non-create `.erdou` lookup parks until released — holds
 *  mountFolder's `readFolderState` window open so a run can land inside it
 *  deterministically (the reproduction of the boot/mount hydration race). */
class GatedErdouDir extends MockDir {
  hydrationStarted = false;
  release: () => void = () => {};
  private gate = new Promise<void>((r) => (this.release = r));
  override async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandleLike> {
    if (name === ".erdou" && !opts?.create) {
      this.hydrationStarted = true;
      await this.gate;
    }
    return super.getDirectoryHandle(name, opts);
  }
}

describe("Studio.mountFolder — the file count + preserve-named dirs loading from disk (R20 verification)", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", makeLocalStorage());
    vi.stubGlobal("document", { hidden: false, addEventListener: vi.fn(), visibilityState: "visible" });
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a folder carrying preserve-named root dirs (etc/, root/) loads them ALL, and the count is exactly the files loaded", async () => {
    await clearRuns();
    const folder = new MockDir("new");
    folder.children.set("ERDOU.md", new MockFile(enc.encode("# notes"), 1));
    const etc = new MockDir("etc");
    etc.children.set("app.conf", new MockFile(enc.encode("conf"), 1));
    folder.children.set("etc", etc);
    const rootDir = new MockDir("root");
    rootDir.children.set("notes.md", new MockFile(enc.encode("n"), 1));
    folder.children.set("root", rootDir);
    await seedFolderState(folder, []); // .erdou/ is session metadata: never loaded, never counted

    const studio = new Studio();
    await studio.boot();
    // A stale preserve-named dir in the workspace (an old project's, or VM
    // leakage): on the BROWSER kernel the A2 clear must remove it — preserve
    // naming shields root dirs on the VM kernel only, never what disk loads.
    studio.fs.mkdir("/etc", { recursive: true });
    studio.fs.writeFile("/etc/old.conf", enc.encode("stale"));

    await studio.mountFolder(folder);

    expect(await studio.readFileText("/ERDOU.md")).toBe("# notes");
    expect(await studio.readFileText("/etc/app.conf")).toBe("conf"); // the folder's REAL etc/ is NOT dropped on load
    expect(await studio.readFileText("/root/notes.md")).toBe("n");
    expect(studio.fs.exists("/etc/old.conf")).toBe(false); // stale workspace copy cleared, not unioned
    expect(studio.fs.exists("/.erdou")).toBe(false); // session metadata stays out of the VFS
    const line = studio.systemLog.find((l) => l.text.startsWith("Mounted local folder"));
    expect(line?.text).toContain('"new" (3 files)');
  });

  it("'(0 files)' is truthful for a folder holding only empty dirs + .erdou/ — the dirs still load; the count counts files", async () => {
    await clearRuns();
    const folder = new MockDir("new");
    folder.children.set("etc", new MockDir("etc"));
    folder.children.set("root", new MockDir("root"));
    await seedFolderState(folder, []);

    const studio = new Studio();
    await studio.boot();
    await studio.mountFolder(folder);

    const line = studio.systemLog.find((l) => l.text.startsWith("Mounted local folder"));
    expect(line?.text).toContain("(0 files)");
    // The empty dirs DID load — the count counts files, not directory entries.
    expect(studio.fs.exists("/etc")).toBe(true);
    expect(studio.fs.exists("/root")).toBe(true);
  });
});

describe("Studio.mountFolder — .erdou hydration MERGES instead of wiping live runs (the boot-race data loss)", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", makeLocalStorage());
    vi.stubGlobal("document", { hidden: false, addEventListener: vi.fn(), visibilityState: "visible" });
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a run LIVE while hydration lands is kept (not wiped), settles into the merged list, and reaches runs.json", async () => {
    await clearRuns();
    const folder = new GatedErdouDir("new");
    folder.children.set("f.txt", new MockFile(enc.encode("x"), 1000));
    // Future-dated folder history (another machine's clock): the recency rule
    // alone would NOT rescue the live run — this pins the live-run exception.
    await seedFolderState(folder, [mkRun("future-run", "done", Date.now() + 1e9)]);

    const studio = new Studio();
    await studio.boot();
    let releaseChat!: () => void;
    const chatGate = new Promise<void>((r) => (releaseChat = r));
    const chat = vi.fn().mockImplementation(async () => {
      await chatGate;
      return { content: "done", toolCalls: [] };
    });
    (studio as unknown as GatewaySlot).gateway = gatewayWith(chat);

    const mounting = studio.mountFolder(folder);
    await vi.waitFor(() => expect(folder.hydrationStarted).toBe(true)); // parked inside readFolderState

    const turn = studio.startRun("race task", DEFAULT_MODEL, "auto");
    await vi.waitFor(() => expect(studio.running).toBe(true));
    const live = studio.runs.find((r) => r.task === "race task")!;
    expect(live).toBeDefined();

    folder.release();
    await mounting;

    // The live run survived the merge as the SAME object, alongside the
    // folder's history — before the fix it silently vanished right here.
    expect(studio.runs).toContain(live);
    expect(studio.runs.some((r) => r.id === "future-run")).toBe(true);
    expect(studio.activeRunId).toBe(live.id);

    releaseChat();
    await turn;
    // The turn settled INTO the merged list, not into a detached object...
    expect(studio.runs).toContain(live);
    expect(live.status).not.toBe("running");
    // ...and the run reached .erdou/runs.json — the user-reported loss.
    studio.flushPendingSaves();
    await vi.waitFor(async () => {
      const st = await readFolderState(folder);
      expect(st!.runs.some((r) => r.task === "race task" && r.status !== "running")).toBe(true);
      expect(st!.runs.some((r) => r.id === "future-run")).toBe(true);
    });
  });

  it("a run COMPLETED inside the hydration window is rescued by recency (memory-only + newer than the folder state)", async () => {
    await clearRuns();
    const folder = new GatedErdouDir("proj");
    folder.children.set("f.txt", new MockFile(enc.encode("x"), 1000));
    await seedFolderState(folder, [mkRun("old-folder-run", "done", 1000)]);

    const studio = new Studio();
    await studio.boot();
    (studio as unknown as GatewaySlot).gateway = gatewayWith(
      vi.fn().mockResolvedValue({ content: "done", toolCalls: [] }),
    );

    const mounting = studio.mountFolder(folder);
    await vi.waitFor(() => expect(folder.hydrationStarted).toBe(true));
    await studio.startRun("window task", DEFAULT_MODEL, "auto"); // completes fully pre-hydration
    const done = studio.runs.find((r) => r.task === "window task")!;
    expect(done.status).not.toBe("running");

    folder.release();
    await mounting;

    expect(studio.runs[0]).toBe(done); // rescued, prepended (most-recent first)
    expect(studio.runs.some((r) => r.id === "old-folder-run")).toBe(true);

    studio.flushPendingSaves();
    await vi.waitFor(async () => {
      const st = await readFolderState(folder);
      expect(st!.runs.some((r) => r.task === "window task")).toBe(true);
      expect(st!.runs.some((r) => r.id === "old-folder-run")).toBe(true);
    });
  });

  it("a reply to a FOLDER-SHARED run (same id both sides) that completes inside the hydration window survives", async () => {
    await clearRuns();
    // The shared thread: IndexedDB holds run X (boot loads it into memory —
    // the auto-remount scenario) and the folder holds the same-id stale copy.
    await saveRuns([mkRun("X", "done", 1000)]);
    const folder = new GatedErdouDir("proj");
    folder.children.set("f.txt", new MockFile(enc.encode("x"), 1000));
    await seedFolderState(folder, [mkRun("X", "done", 1000), mkRun("older", "done", 900)]);

    const studio = new Studio();
    await studio.boot(); // memory now holds X (the IndexedDB copy)
    (studio as unknown as GatewaySlot).gateway = gatewayWith(
      vi.fn().mockResolvedValue({ content: "quick answer", toolCalls: [] }),
    );

    const mounting = studio.mountFolder(folder);
    await vi.waitFor(() => expect(folder.hydrationStarted).toBe(true)); // parked inside readFolderState
    // A quick-failing/quick-answering reply that fully COMPLETES pre-hydration:
    // not live (turn over) and not memory-only (same id) — before the fix the
    // folder's stale copy silently wiped the follow-up from memory and disk.
    await studio.replyToRun("X", "follow-up question", DEFAULT_MODEL, "auto");
    const x = studio.runs.find((r) => r.id === "X")!;
    expect(x.status).not.toBe("running");
    expect(x.trace.some((l) => l.text === "follow-up question")).toBe(true);

    folder.release();
    await mounting;

    // The memory copy (with the reply) won the same-id collision, and the
    // folder's other history still merged in around it.
    expect(studio.runs.find((r) => r.id === "X")).toBe(x);
    expect(x.trace.some((l) => l.text === "follow-up question")).toBe(true);
    expect(studio.runs.some((r) => r.id === "older")).toBe(true);
    // The reply also reached the folder's runs.json (rescued ⇒ persisted).
    studio.flushPendingSaves();
    await vi.waitFor(async () => {
      const st = await readFolderState(folder);
      const savedX = st!.runs.find((r) => r.id === "X");
      expect(savedX?.trace.some((l) => l.text === "follow-up question")).toBe(true);
    });
  });

  it("normal remount: folder wins for same-id runs, stale memory-only history yields, a dangling selection resets", async () => {
    await clearRuns();
    await saveRuns([mkRun("A", "done", 500, "stale title"), mkRun("B", "done", 400)]);
    const folder = new MockDir("proj");
    folder.children.set("f.txt", new MockFile(enc.encode("x"), 1000));
    await seedFolderState(folder, [mkRun("C", "done", 900), mkRun("A", "done", 500, "fresh title")]);

    const studio = new Studio();
    await studio.boot(); // loads the browser-local history [A(stale), B]
    expect(studio.runs.map((r) => r.id)).toEqual(["A", "B"]);
    studio.selectRun("B");

    await studio.mountFolder(folder);

    expect(studio.runs.map((r) => r.id)).toEqual(["C", "A"]); // the folder's list, in the folder's order
    expect(studio.runs.find((r) => r.id === "A")!.title).toBe("fresh title"); // same-id: the folder's copy wins
    expect(studio.activeRunId).toBeNull(); // B was superseded away; the selection resets honestly
  });
});

describe("Studio folder swap (re-select) — project A's chat history must not contaminate project B", () => {
  const folderPair = async (): Promise<{ folderA: MockDir; folderB: MockDir }> => {
    const folderA = new MockDir("A");
    folderA.children.set("a.txt", new MockFile(enc.encode("a"), 1000));
    await seedFolderState(folderA, []);
    const folderB = new MockDir("B");
    folderB.children.set("b.txt", new MockFile(enc.encode("b"), 1000));
    await seedFolderState(folderB, [mkRun("b-run", "done", 500)]);
    return { folderA, folderB };
  };
  const stubGlobalsWithPicker = (folderB: MockDir): void => {
    vi.stubGlobal("localStorage", makeLocalStorage());
    vi.stubGlobal("document", { hidden: false, addEventListener: vi.fn(), visibilityState: "visible" });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      showDirectoryPicker: async () => folderB,
    });
  };
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("swapping A→B drops A's session runs everywhere B can see: memory, B's runs.json, and IndexedDB", async () => {
    await clearRuns();
    const { folderA, folderB } = await folderPair();
    stubGlobalsWithPicker(folderB);

    const studio = new Studio();
    await studio.boot();
    (studio as unknown as GatewaySlot).gateway = gatewayWith(
      vi.fn().mockResolvedValue({ content: "done", toolCalls: [] }),
    );
    await studio.mountFolder(folderA);
    // A run driven IN A this session: BOTH hydration rescue rules (recency +
    // the session turnRunIds mark) would keep it — the swap must beat both.
    await studio.startRun("task in A", DEFAULT_MODEL, "auto");
    expect(studio.runs.find((r) => r.task === "task in A")!.status).not.toBe("running");

    await studio.reselectFolder(); // the REAL swap flow, picker stubbed to hand back B

    // Memory shows only B's history; the dangling selection reset honestly.
    expect(studio.runs.map((r) => r.id)).toEqual(["b-run"]);
    expect(studio.activeRunId).toBeNull();
    // A kept its OWN chat: the swap flushed A's pending state save before pruning.
    const stA = await readFolderState(folderA);
    expect(stA!.runs.some((r) => r.task === "task in A")).toBe(true);
    // B's runs.json never learns about A's chat — even after every pending save fires.
    studio.flushPendingSaves();
    await vi.waitFor(async () => {
      const stB = await readFolderState(folderB);
      expect(stB!.runs.map((r) => r.id)).toEqual(["b-run"]);
    });
    // IndexedDB mirrors the swap too — otherwise the NEXT session's boot would
    // load A's (newer) runs and the auto-remount hydration would rescue them
    // straight into B's runs.json: the same contamination, one reload later.
    expect((await loadRuns()).map((r) => r.id)).toEqual(["b-run"]);
  });

  it("a turn in flight DURING the swap survives it (the one documented carry-over) and settles into B's history", async () => {
    await clearRuns();
    const { folderA, folderB } = await folderPair();
    stubGlobalsWithPicker(folderB);

    const studio = new Studio();
    await studio.boot();
    let releaseChat!: () => void;
    const chatGate = new Promise<void>((r) => (releaseChat = r));
    (studio as unknown as GatewaySlot).gateway = gatewayWith(
      vi.fn().mockImplementation(async () => {
        await chatGate;
        return { content: "done", toolCalls: [] };
      }),
    );
    await studio.mountFolder(folderA);

    const turn = studio.startRun("live through the swap", DEFAULT_MODEL, "auto");
    await vi.waitFor(() => expect(studio.running).toBe(true));
    const live = studio.runs.find((r) => r.task === "live through the swap")!;

    await studio.reselectFolder();
    // NOT dropped: pruning the live turn's object would detach the running
    // turn — its final status/trace would land on an orphan.
    expect(studio.runs).toContain(live);
    expect(studio.runs.some((r) => r.id === "b-run")).toBe(true);

    releaseChat();
    await turn;
    expect(live.status).not.toBe("running");
    studio.flushPendingSaves();
    await vi.waitFor(async () => {
      const stB = await readFolderState(folderB);
      expect(stB!.runs.some((r) => r.task === "live through the swap" && r.status !== "running")).toBe(true);
      expect(stB!.runs.some((r) => r.id === "b-run")).toBe(true);
    });
  });
});
