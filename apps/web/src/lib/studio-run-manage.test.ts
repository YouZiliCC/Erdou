import "fake-indexeddb/auto";
import { describe, it, expect, vi } from "vitest";
import { Studio, type Run } from "./studio.js";
import { ModelGateway } from "@erdou/model-gateway";
import { DEFAULT_MODEL } from "./model-config.js";
import { saveRuns, loadRuns } from "./runs-store.js";

const mkRun = (id: string, status: Run["status"] = "done"): Run => ({
  id,
  title: id,
  task: id,
  status,
  trace: [],
  changes: [],
  messages: [],
  createdAt: 1,
});

/** A chat mock that parks until released — keeps a started run in flight
 *  while assertions run (the studio-run-lifecycle idiom). */
function parkedGateway(): { gateway: ModelGateway; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const chat = vi.fn().mockImplementation(async () => {
    await gate;
    return { content: "done", toolCalls: [] };
  });
  return { gateway: { chat } as unknown as ModelGateway, release };
}

type FolderStateInternals = { scheduleFolderStateSave(): void };

describe("Studio.deleteRun", () => {
  it("removes the run and persists to IndexedDB (awaited, not just debounced)", async () => {
    await saveRuns([mkRun("keep"), mkRun("drop")]);
    const studio = new Studio();
    await studio.boot();

    await studio.deleteRun("drop");

    expect(studio.runs.map((r) => r.id)).toEqual(["keep"]);
    const stored = await loadRuns();
    expect(stored.map((r) => r.id)).toEqual(["keep"]);
  });

  it("deleting the ACTIVE run activates the most recent remaining run; deleting the last leaves null", async () => {
    const studio = new Studio();
    await studio.boot();
    // Most-recent-first, the stored invariant (startRun unshifts).
    studio.runs = [mkRun("newest"), mkRun("older")];
    studio.activeRunId = "newest";

    await studio.deleteRun("newest");
    expect(studio.activeRunId).toBe("older");

    await studio.deleteRun("older");
    expect(studio.activeRunId).toBeNull();
    expect(studio.runs).toHaveLength(0);
  });

  it("deleting a NON-active run keeps the current selection", async () => {
    const studio = new Studio();
    await studio.boot();
    studio.runs = [mkRun("a"), mkRun("b")];
    studio.activeRunId = "a";

    await studio.deleteRun("b");
    expect(studio.activeRunId).toBe("a");
  });

  it("refuses to delete the in-flight run (system-log line, run untouched); deletable after the turn settles", async () => {
    const studio = new Studio();
    await studio.boot();
    const { gateway, release } = parkedGateway();
    (studio as unknown as { gateway: ModelGateway }).gateway = gateway;

    const turn = studio.startRun("busy task", DEFAULT_MODEL, "auto");
    await vi.waitFor(() => {
      expect(studio.running).toBe(true);
    });
    const id = studio.runs[0]!.id;

    await studio.deleteRun(id);
    expect(studio.runs.some((r) => r.id === id)).toBe(true); // NOT deleted
    expect(studio.running).toBe(true); // the turn was not disturbed
    expect(studio.systemLog.some((l) => l.text.includes("stop it first"))).toBe(true);

    release();
    await turn;
    await studio.deleteRun(id);
    expect(studio.runs.some((r) => r.id === id)).toBe(false);
  });

  it("fails fast on an unknown id", async () => {
    const studio = new Studio();
    await studio.boot();
    await expect(studio.deleteRun("nope")).rejects.toThrow('deleteRun: no run with id "nope"');
  });

  it("kicks the mounted-folder state save (the .erdou/ mirror)", async () => {
    const studio = new Studio();
    await studio.boot();
    studio.runs = [mkRun("x")];
    // The full .erdou/ write path is covered by the mount tests; here we assert
    // deleteRun routes through the same debounced folder-state persistence hook.
    const spy = vi.spyOn(studio as unknown as FolderStateInternals, "scheduleFolderStateSave");

    await studio.deleteRun("x");
    expect(spy).toHaveBeenCalled();
  });
});

describe("Studio.renameRun", () => {
  it("trims, persists, and survives a reload (a fresh Studio boots with the new title)", async () => {
    await saveRuns([mkRun("r1")]);
    const studio = new Studio();
    await studio.boot();

    await studio.renameRun("r1", "  Fancy title  ");
    expect(studio.runs[0]!.title).toBe("Fancy title");

    // Run.title is a stored plain field — a reload keeps the rename.
    const reloaded = new Studio();
    await reloaded.boot();
    expect(reloaded.runs.find((r) => r.id === "r1")?.title).toBe("Fancy title");
  });

  it("rejects an empty (post-trim) title — fail fast, no half-rename", async () => {
    await saveRuns([mkRun("r1")]);
    const studio = new Studio();
    await studio.boot();

    await expect(studio.renameRun("r1", "   ")).rejects.toThrow("renameRun: the title must not be empty");
    expect(studio.runs[0]!.title).toBe("r1"); // untouched
    const stored = await loadRuns();
    expect(stored[0]!.title).toBe("r1");
  });

  it("fails fast on an unknown id", async () => {
    const studio = new Studio();
    await studio.boot();
    await expect(studio.renameRun("nope", "t")).rejects.toThrow('renameRun: no run with id "nope"');
  });

  it("kicks the mounted-folder state save (the .erdou/ mirror)", async () => {
    const studio = new Studio();
    await studio.boot();
    studio.runs = [mkRun("x")];
    const spy = vi.spyOn(studio as unknown as FolderStateInternals, "scheduleFolderStateSave");

    await studio.renameRun("x", "renamed");
    expect(spy).toHaveBeenCalled();
  });
});
