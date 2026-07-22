import "fake-indexeddb/auto";
import { describe, it, expect, vi } from "vitest";
import { Studio, type Run, type TraceKind } from "./studio.js";
import { ModelGateway } from "@erdou/model-gateway";
import { withTitleReplies } from "./test-support/title-gateway.js";
import { DEFAULT_MODEL } from "./model-config.js";
import { saveRuns, loadRuns } from "./runs-store.js";

// A chat-mock gateway (the agent.test.ts idiom, mock-object flavor so calls
// can be counted): each mockImplementation supplies one model turn.
type ChatMock = ReturnType<typeof vi.fn>;
function gatewayWith(chat: ChatMock): ModelGateway {
  return { chat: withTitleReplies(chat) } as unknown as ModelGateway;
}
const toolCallTurn = (id: string, name: string, args: unknown) => ({
  content: "",
  toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
});

const mkRun = (id: string, status: Run["status"]): Run => ({
  id,
  title: id,
  task: id,
  status,
  trace: [],
  changes: [],
  messages: [],
  createdAt: 1,
});

describe("Studio run lifecycle — stop + in-flight persistence (D1/D2)", () => {
  it("D2: startRun persists the run BEFORE the turn ends (reload mid-run keeps the thread)", async () => {
    const studio = new Studio();
    await studio.boot();
    // A model call that parks until released — the persistence check runs while
    // the turn is still in flight.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const chat = vi.fn().mockImplementation(async () => {
      await gate;
      return { content: "done", toolCalls: [] };
    });
    (studio as unknown as { gateway: ModelGateway }).gateway = gatewayWith(chat);

    const turn = studio.startRun("persist me early", DEFAULT_MODEL, "auto");
    await vi.waitFor(async () => {
      const stored = await loadRuns();
      expect(stored.some((r) => r.task === "persist me early" && r.status === "running")).toBe(true);
    });

    release();
    await turn;
  });

  it("D2: a stored 'running' run is normalized to interrupted on boot — and the normalization is persisted", async () => {
    const crashed = mkRun("crashed", "running");
    const fine = mkRun("fine", "done");
    await saveRuns([crashed, fine]);

    const studio = new Studio();
    await studio.boot();

    const run = studio.runs.find((r) => r.id === "crashed");
    expect(run?.status).toBe("error");
    expect(run?.trace.some((l) => l.kind === "error" && l.text.startsWith("Interrupted"))).toBe(true);
    // Untouched sibling stays as it was.
    const other = studio.runs.find((r) => r.id === "fine");
    expect(other?.status).toBe("done");
    expect(other?.trace).toHaveLength(0);
    // The normalization reached IndexedDB, not just memory.
    const stored = await loadRuns();
    expect(stored.find((r) => r.id === "crashed")?.status).toBe("error");
  });

  it("D2: trace appends debounce-persist; the pending save is exposed and flushable", async () => {
    const studio = new Studio();
    await studio.boot();
    const run = mkRun("dbg", "done");
    studio.runs = [run, ...studio.runs];

    expect(studio.runsSavePending).toBe(false);
    (studio as unknown as { appendLine(r: Run, k: TraceKind, t: string): void }).appendLine(
      run,
      "system",
      "debounced line",
    );
    expect(studio.runsSavePending).toBe(true);

    await studio.flushRunsSave();
    expect(studio.runsSavePending).toBe(false);
    const stored = await loadRuns();
    expect(stored.find((r) => r.id === "dbg")?.trace.some((l) => l.text === "debounced line")).toBe(true);
  });

  it("D1: stopRun mid-run settles the parked Confirm approval, ends the run as stopped (not error), and keeps its changes reviewable", async () => {
    const studio = new Studio();
    await studio.boot();
    // Turn 1 writes a file (ungated), turn 2 parks on a gated run_shell —
    // that parked approval is where stopRun() finds the run.
    const chat = vi
      .fn()
      .mockResolvedValueOnce(toolCallTurn("c1", "write_file", { path: "/made.txt", content: "hi" }))
      .mockResolvedValueOnce(toolCallTurn("c2", "run_shell", { command: "echo never" }));
    (studio as unknown as { gateway: ModelGateway }).gateway = gatewayWith(chat);

    const turn = studio.startRun("write then park", DEFAULT_MODEL, "confirm");
    await vi.waitFor(() => {
      expect(studio.pendingApproval).not.toBeNull();
    });

    studio.stopRun();
    await turn;

    const run = studio.runs.find((r) => r.task === "write then park");
    expect(run).toBeDefined();
    // Not an opaque error: a clear stop line, and the error path never ran.
    expect(run!.trace.some((l) => l.kind === "done" && l.text === "Stopped by the user.")).toBe(true);
    expect(run!.trace.some((l) => l.text === "Agent stopped")).toBe(false);
    // The pre-stop file change is captured and the run is reviewable.
    expect(run!.status).toBe("review");
    expect(run!.changes.map((c) => c.path)).toContain("/made.txt");
    // The loop exited promptly: no model call after the stop.
    expect(chat).toHaveBeenCalledTimes(2);
    // Fully settled studio state.
    expect(studio.running).toBe(false);
    expect(studio.pendingApproval).toBeNull();
  });

  it("D1 UX: stopRun during an in-flight model call sets `stopping` until the turn actually ends", async () => {
    const studio = new Studio();
    await studio.boot();
    // The model call parks (a long generation): the abort only takes effect at
    // the checkpoint AFTER the response arrives — `stopping` covers that gap so
    // the Composer can show "Stopping…" instead of an ignored-looking Stop.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const chat = vi.fn().mockImplementation(async () => {
      await gate;
      return toolCallTurn("c1", "write_file", { path: "/late.txt", content: "late" });
    });
    (studio as unknown as { gateway: ModelGateway }).gateway = gatewayWith(chat);

    const turn = studio.startRun("slow model", DEFAULT_MODEL, "auto");
    await vi.waitFor(() => {
      expect(chat).toHaveBeenCalledOnce();
    });
    expect(studio.stopping).toBe(false);

    studio.stopRun();
    // The HTTP response hasn't arrived yet: still running, but visibly stopping.
    expect(studio.stopping).toBe(true);
    expect(studio.running).toBe(true);

    release();
    await turn;
    expect(studio.stopping).toBe(false);
    expect(studio.running).toBe(false);
    // The post-response checkpoint honored the abort: the requested tool never
    // ran, no further model call was made, and the run ended with a clear stop.
    expect(studio.fs.exists("/late.txt")).toBe(false);
    expect(chat).toHaveBeenCalledTimes(1);
    const run = studio.runs.find((r) => r.task === "slow model");
    expect(run!.trace.some((l) => l.kind === "done" && l.text === "Stopped by the user.")).toBe(true);
  });

  it("D1: stopRun is a no-op when nothing is running", async () => {
    const studio = new Studio();
    await studio.boot();
    expect(() => studio.stopRun()).not.toThrow();
    expect(studio.running).toBe(false);
    expect(studio.stopping).toBe(false);
  });
});

describe("Studio run turn — diff capture survives a mid-run failure (B5)", () => {
  it("a turn that throws after changing files still populates run.changes (Review/revert have content)", async () => {
    const studio = new Studio();
    await studio.boot();
    // Turn 1 writes a file; turn 2's model call blows up — previously the
    // throw skipped diff capture entirely and Review/Diff showed nothing.
    const chat = vi
      .fn()
      .mockResolvedValueOnce(toolCallTurn("c1", "write_file", { path: "/built.txt", content: "step 1" }))
      .mockRejectedValueOnce(new Error("model exploded at step 2"));
    (studio as unknown as { gateway: ModelGateway }).gateway = gatewayWith(chat);

    await studio.startRun("fail mid-run", DEFAULT_MODEL, "auto");

    const run = studio.runs.find((r) => r.task === "fail mid-run");
    expect(run).toBeDefined();
    // The failure is still an error, with the cause surfaced…
    expect(run!.status).toBe("error");
    expect(
      run!.trace.some((l) => l.kind === "error" && l.text === "Agent stopped" && l.detail?.includes("model exploded")),
    ).toBe(true);
    // …but the pre-failure change is captured, with real content to revert.
    const change = run!.changes.find((c) => c.path === "/built.txt");
    expect(change).toBeDefined();
    expect(change!.kind).toBe("create");
    expect(change!.after).toBe("step 1");
    // Fully settled studio state, and the diff was persisted with the error run.
    expect(studio.running).toBe(false);
    const stored = await loadRuns();
    expect(stored.find((r) => r.task === "fail mid-run")?.changes.map((c) => c.path)).toContain("/built.txt");
  });
});
