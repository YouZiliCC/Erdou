import "fake-indexeddb/auto";
import { describe, it, expect, vi, afterEach } from "vitest";
import { Studio, type Run, type TraceKind } from "./studio.js";
import type { DirHandleLike } from "./local-mount.js";

const mkRun = (id: string, createdAt = 1): Run => ({
  id,
  title: id,
  task: id,
  status: "done",
  trace: [],
  changes: [],
  messages: [],
  createdAt,
});

describe("Studio.save — snapshot-save failures are surfaced (B2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("first failure logs once + sets lastSaveFailed; repeats stay quiet; recovery clears the flag AND retires the stale error line", async () => {
    const studio = new Studio();
    await studio.boot();
    const store = (studio as unknown as { store: { save(id: string, snap: unknown): Promise<void> } }).store;
    const storeSave = vi.spyOn(store, "save").mockRejectedValue(new Error("QuotaExceededError: storage full"));

    const failLines = () =>
      studio.systemLog.filter((l) => l.kind === "error" && l.text.startsWith("Couldn't save your project"));
    const recoveryLines = () => studio.systemLog.filter((l) => l.text.startsWith("Project saving recovered"));

    expect(studio.lastSaveFailed).toBe(false);
    // save() never rejects — the debounced caller discards the promise, so a
    // rejection would be an unhandled error AND an unreported data loss.
    await expect(studio.save()).resolves.toBeUndefined();
    expect(studio.lastSaveFailed).toBe(true);
    expect(failLines()).toHaveLength(1);
    expect(failLines()[0]!.detail).toContain("QuotaExceededError");

    // Still failing: no log spam — the transition already happened.
    await studio.save();
    expect(failLines()).toHaveLength(1);
    expect(studio.lastSaveFailed).toBe(true);

    // Recovery: one note, flag cleared, and the pinned failure line is REMOVED —
    // Conversation's .sysbar strip renders every error with no dismissal, so a
    // surviving line would keep asserting data loss after saving works again (B3/B2).
    storeSave.mockResolvedValue(undefined);
    await studio.save();
    expect(studio.lastSaveFailed).toBe(false);
    expect(recoveryLines()).toHaveLength(1);
    expect(failLines()).toHaveLength(0);

    // Steady-state success stays quiet.
    await studio.save();
    expect(recoveryLines()).toHaveLength(1);
    expect(failLines()).toHaveLength(0);

    // A NEW failure after recovery is a fresh transition: it logs again.
    storeSave.mockRejectedValue(new Error("full again"));
    await studio.save();
    expect(studio.lastSaveFailed).toBe(true);
    expect(failLines()).toHaveLength(1);
    expect(failLines()[0]!.detail).toContain("full again");
  });
});

describe("Studio.boot — a dead persistence layer is visible, not silent (D5)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("surfaces the run-history failure in the systemLog and still wires runtime events", async () => {
    // Firefox private browsing: runs-store.open() deliberately throws when
    // IndexedDB is unavailable. use-studio.ts discards boot()'s promise, so the
    // rejection left the app looking normal with an EMPTY log and no file panel
    // refresh (subscribeRuntime never ran).
    vi.stubGlobal("indexedDB", undefined);
    const studio = new Studio();
    await expect(studio.boot()).resolves.toBeUndefined();

    const err = studio.systemLog.find((l) => l.kind === "error" && l.text.startsWith("Could not load your run history"));
    expect(err).toBeDefined();
    expect(err!.detail).toContain("IndexedDB");
    expect(studio.runs).toEqual([]);

    // The runtime is still wired: a file change bumps fsVersion (the file panel's
    // refresh signal) even though persistence is dead.
    const before = studio.fsVersion;
    await studio.runtime.writeFile("/wired.txt", "x");
    await new Promise((r) => setTimeout(r, 0));
    expect(studio.fsVersion).toBeGreaterThan(before);
  });
});

describe("Studio.resetProject — every armed timer dies with the workspace (D2)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("cancels the snapshot/folder/state debounces and empties runs, so nothing re-writes what it just deleted", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { reload, origin: "http://localhost:5173" });
    const studio = new Studio();
    await studio.boot();
    studio.runs = [mkRun("history")];
    studio.mount = { name: "proj" } as unknown as DirHandleLike;
    const saveSpy = vi.spyOn(studio, "save").mockResolvedValue(undefined);
    const folderSpy = vi.spyOn(studio, "saveToFolder").mockResolvedValue(undefined);
    const internals = studio as unknown as {
      scheduleSave(): void;
      scheduleFolderSave(): void;
      scheduleFolderStateSave(): void;
      scheduleRunsSave(): void;
      saveTimer: unknown;
      folderSaveTimer: unknown;
      folderStateTimer: unknown;
      runsSaveTimer: unknown;
    };
    // The state the Reset click actually arrives in: window.confirm blocks the
    // main thread, so every debounce armed before it is already OVERDUE and
    // fires on the first await inside resetProject.
    internals.scheduleSave();
    internals.scheduleFolderSave();
    internals.scheduleFolderStateSave();
    internals.scheduleRunsSave();

    await studio.resetProject();

    expect(reload).toHaveBeenCalledTimes(1);
    // The folder-state flush a pagehide would kick must find no history to mirror.
    expect(studio.runs).toEqual([]);
    expect([
      internals.saveTimer,
      internals.folderSaveTimer,
      internals.folderStateTimer,
      internals.runsSaveTimer,
    ]).toEqual([undefined, undefined, undefined, undefined]);
    // All three windows (400/500/600 ms) elapse without re-writing the deleted
    // workspace — previously save() re-committed the snapshot after the delete.
    await new Promise((r) => setTimeout(r, 700));
    expect(saveSpy).not.toHaveBeenCalled();
    expect(folderSpy).not.toHaveBeenCalled();
    expect(studio.runsSavePending).toBe(false);
  });
});

describe("Studio run-history cap — one bound for IndexedDB, the folder mirror and memory (D4)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("currentState() caps the .erdou mirror and hydrateRuns caps what comes back into memory", () => {
    // currentState() reads theme/approval/model from localStorage, which this
    // (node) test environment has none of.
    vi.stubGlobal("localStorage", { getItem: () => null } as unknown as Storage);
    const studio = new Studio();
    const internals = studio as unknown as {
      currentState(): { runs: Run[] };
      hydrateRuns(folderRuns: Run[], mode: "merge" | "replace"): number;
    };
    // Each Run carries its whole trace plus every FileChange's full before AND
    // after text, so an uncapped mirror is unbounded pretty-printed JSON.
    studio.runs = Array.from({ length: 30 }, (_, i) => mkRun(`mem-${i}`));
    const mirrored = internals.currentState().runs;
    expect(mirrored).toHaveLength(20);
    expect(mirrored.at(-1)!.id).toBe("mem-19");

    // A folder holding a full list must not push memory past the cap on mount.
    const folderRuns = Array.from({ length: 30 }, (_, i) => mkRun(`folder-${i}`));
    studio.runs = [mkRun("mine", 2)]; // newer than every folder run → kept by the merge
    internals.hydrateRuns(folderRuns, "merge");
    expect(studio.runs).toHaveLength(20);
    expect(studio.runs.map((r) => r.id).slice(0, 2)).toEqual(["mine", "folder-0"]);

    // The explicit swap path takes the same bound.
    internals.hydrateRuns(folderRuns, "replace");
    expect(studio.runs).toHaveLength(20);
  });
});

describe("Studio.flushPendingSaves — flush-on-unload (A4)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("cancels the pending debounce timers and kicks the saves immediately", async () => {
    const studio = new Studio();
    await studio.boot();
    const saveSpy = vi.spyOn(studio, "save").mockResolvedValue(undefined);
    vi.useFakeTimers();

    // A pending snapshot debounce + a pending runs debounce, both inside their
    // debounce windows (the state a quick Cmd-R used to lose).
    (studio as unknown as { scheduleSave(): void }).scheduleSave();
    const run = mkRun("flush-me");
    studio.runs = [run, ...studio.runs];
    (studio as unknown as { appendLine(r: Run, k: TraceKind, t: string): void }).appendLine(run, "system", "pending");
    expect(saveSpy).not.toHaveBeenCalled();
    expect(studio.runsSavePending).toBe(true);

    studio.flushPendingSaves();
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(studio.runsSavePending).toBe(false);

    // The debounce timers were cancelled — nothing double-fires later.
    await vi.advanceTimersByTimeAsync(5000);
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it("boot wires pagehide + visibilitychange(hidden) to the flush", async () => {
    const winAdd = vi.fn();
    const docAdd = vi.fn();
    const doc = { addEventListener: docAdd, visibilityState: "visible", hidden: false };
    vi.stubGlobal("window", { addEventListener: winAdd, removeEventListener: vi.fn() });
    vi.stubGlobal("document", doc);

    const studio = new Studio();
    await studio.boot();
    const flushSpy = vi.spyOn(studio, "flushPendingSaves");

    const pagehide = winAdd.mock.calls.find((c) => c[0] === "pagehide")?.[1] as (() => void) | undefined;
    expect(pagehide).toBeTypeOf("function");
    pagehide!();
    expect(flushSpy).toHaveBeenCalledTimes(1);

    const onVis = docAdd.mock.calls.find((c) => c[0] === "visibilitychange")?.[1] as (() => void) | undefined;
    expect(onVis).toBeTypeOf("function");
    doc.visibilityState = "hidden";
    onVis!();
    expect(flushSpy).toHaveBeenCalledTimes(2);
    // Becoming visible again is NOT a flush.
    doc.visibilityState = "visible";
    onVis!();
    expect(flushSpy).toHaveBeenCalledTimes(2);
  });
});
