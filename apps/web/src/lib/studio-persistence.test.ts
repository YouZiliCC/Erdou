import "fake-indexeddb/auto";
import { describe, it, expect, vi, afterEach } from "vitest";
import { Studio, type Run, type TraceKind } from "./studio.js";

const mkRun = (id: string): Run => ({
  id,
  title: id,
  task: id,
  status: "done",
  trace: [],
  changes: [],
  messages: [],
  createdAt: 1,
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
