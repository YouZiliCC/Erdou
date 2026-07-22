// Studio-level delegate tests: the Confirm-mode gate on the delegate call
// itself, the kind:"subagent" trace-line lifecycle (append → immutable
// replace), the merged diff landing in the run's Review set, and the
// loadRuns persistence round-trip of the nested child trace.
import "fake-indexeddb/auto";
import { describe, it, expect, vi } from "vitest";
import { Studio } from "./studio.js";
import { ModelGateway, type ChatMessage } from "@erdou/model-gateway";
import { withTitleReplies } from "./test-support/title-gateway.js";
import { DEFAULT_MODEL } from "./model-config.js";
import { loadRuns } from "./runs-store.js";
import { parseSubagentDetail } from "./delegate.js";

interface Turn {
  content: string;
  toolCalls: { id: string; name: string; arguments: string }[];
}
const turnTool = (id: string, name: string, args: unknown): Turn => ({
  content: "",
  toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
});
const turnFinal = (content: string): Turn => ({ content, toolCalls: [] });

/** Task-routed scripted gateway: parent and child transcripts are told apart
 *  by their first user message, so one gateway serves both deterministically. */
function routedGateway(scripts: Record<string, Turn[]>): ModelGateway {
  const idx = new Map<string, number>();
  const chat = async (_model: unknown, messages: ChatMessage[]): Promise<Turn> => {
    const task = messages.find((m) => m.role === "user")?.content ?? "";
    const i = idx.get(task) ?? 0;
    idx.set(task, i + 1);
    const turns = scripts[task];
    if (!turns) throw new Error(`no script for task "${task}" — a child ran that should not have`);
    return turns[i] ?? turnFinal("done");
  };
  return { chat: withTitleReplies(chat) } as unknown as ModelGateway;
}

const setGateway = (studio: Studio, gateway: ModelGateway): void => {
  (studio as unknown as { gateway: ModelGateway }).gateway = gateway;
};

describe("Studio delegate integration", () => {
  it("runs a delegate batch: subagent trace card lifecycle, merged run diff, loadRuns round-trip", async () => {
    const studio = new Studio();
    await studio.boot();
    studio.fs.writeFile("/README.md", "# base\n");
    setGateway(
      studio,
      routedGateway({
        "split the work": [
          turnTool("p1", "delegate", { agents: [{ role: "api", task: "child api task" }] }),
          turnFinal("All merged."),
        ],
        "child api task": [
          turnTool("c0", "make_dir", { path: "/api" }),
          turnTool("c1", "write_file", { path: "/api/server.ts", content: "export {};\n" }),
          turnFinal("API child done."),
        ],
      }),
    );

    await studio.startRun("split the work", DEFAULT_MODEL, "auto");

    const run = studio.runs.find((r) => r.task === "split the work");
    expect(run).toBeDefined();
    // The child's work was merged back and captured by the run diff → Review.
    expect(studio.fs.exists("/api/server.ts")).toBe(true);
    expect(run!.status).toBe("review");
    const change = run!.changes.find((c) => c.path === "/api/server.ts");
    expect(change?.kind).toBe("create");
    expect(change?.after).toBe("export {};\n");
    // Exactly ONE subagent line (updates replace it, never append a second).
    const subLines = run!.trace.filter((l) => l.kind === "subagent");
    expect(subLines).toHaveLength(1);
    expect(subLines[0]!.text).toBe("sub-agent · api");
    const detail = parseSubagentDetail(subLines[0]!.detail);
    expect(detail).not.toBeNull();
    expect(detail!.status).toBe("done");
    expect(detail!.task).toBe("child api task");
    expect(detail!.trace.some((l) => l.kind === "tool" && l.text === "write_file")).toBe(true);
    expect(detail!.trace.some((l) => l.kind === "done" && l.text === "API child done.")).toBe(true);
    // The delegate tool's own result line carries the per-child report.
    expect(run!.trace.some((l) => l.kind === "result" && l.detail?.includes("sub-agent 1/1 (api) — done"))).toBe(true);

    // Persistence: the stored run's subagent line parses back identically
    // (plain JSON through runs-store → loadRuns).
    const stored = await loadRuns();
    const storedRun = stored.find((r) => r.task === "split the work");
    const storedLine = storedRun?.trace.find((l) => l.kind === "subagent");
    expect(storedLine).toBeDefined();
    expect(parseSubagentDetail(storedLine!.detail)).toEqual(detail);
  });

  it("regression: a run that creates a DIRECTORY still captures its diff (EISDIR fix)", async () => {
    // mkdir emits file.changed for the directory itself; computeRunChanges used
    // to readFile it → EISDIR → the WHOLE turn's diff was voided (status error,
    // empty Review). The delegate merge mkdirs on apply-back, so this fires on
    // every nested create — but the fix covers plain runs too, proven here.
    const studio = new Studio();
    await studio.boot();
    setGateway(
      studio,
      routedGateway({
        "scaffold a dir": [
          turnTool("m1", "make_dir", { path: "/newdir" }),
          turnTool("m2", "write_file", { path: "/newdir/f.txt", content: "x" }),
          turnFinal("scaffolded"),
        ],
      }),
    );

    await studio.startRun("scaffold a dir", DEFAULT_MODEL, "auto");

    const run = studio.runs.find((r) => r.task === "scaffold a dir");
    expect(run!.status).toBe("review");
    expect(run!.trace.some((l) => l.kind === "error")).toBe(false);
    expect(run!.changes.map((c) => `${c.kind}:${c.path}`)).toEqual(["create:/newdir/f.txt"]);
  });

  it("Confirm mode gates the delegate CALL (one prompt for the whole batch); Allow runs it", async () => {
    const studio = new Studio();
    await studio.boot();
    setGateway(
      studio,
      routedGateway({
        "gated fanout": [
          turnTool("p1", "delegate", { agents: [{ role: "w", task: "gated child task" }] }),
          turnFinal("done after approval"),
        ],
        "gated child task": [
          turnTool("c1", "write_file", { path: "/gated.txt", content: "approved\n" }),
          turnFinal("child finished"),
        ],
      }),
    );

    const turn = studio.startRun("gated fanout", DEFAULT_MODEL, "confirm");
    await vi.waitFor(() => {
      expect(studio.pendingApproval).not.toBeNull();
    });
    // ONE gate, on the batch call itself — the args are visible to the user.
    expect(studio.pendingApproval!.req.tool).toBe("delegate");
    expect(studio.pendingApproval!.req.args.agents).toEqual([{ role: "w", task: "gated child task" }]);

    studio.pendingApproval!.resolve("allow");
    await turn;

    // The child ran WITHOUT any further approval prompt (write_file is ungated
    // anyway, but the child also has no approve callback by construction) and
    // its work landed.
    expect(studio.fs.exists("/gated.txt")).toBe(true);
    const run = studio.runs.find((r) => r.task === "gated fanout");
    expect(run!.trace.filter((l) => l.kind === "subagent")).toHaveLength(1);
  });

  it("Confirm mode: Deny stops the batch cold — no children run, no subagent cards appear", async () => {
    const studio = new Studio();
    await studio.boot();
    setGateway(
      studio,
      routedGateway({
        // No script for the child task: if a child ran anyway, the gateway
        // would throw and fail the run — silence proves the deny.
        "deny the fanout": [
          turnTool("p1", "delegate", { agents: [{ role: "w", task: "never-started child" }] }),
          turnFinal("ok, doing it myself"),
        ],
      }),
    );

    const turn = studio.startRun("deny the fanout", DEFAULT_MODEL, "confirm");
    await vi.waitFor(() => {
      expect(studio.pendingApproval).not.toBeNull();
    });
    studio.pendingApproval!.resolve("deny");
    await turn;

    const run = studio.runs.find((r) => r.task === "deny the fanout");
    expect(run!.trace.filter((l) => l.kind === "subagent")).toHaveLength(0);
    expect(run!.trace.some((l) => l.kind === "result" && l.detail === "Denied by the user.")).toBe(true);
    expect(run!.status).toBe("done"); // the turn itself completed cleanly
  });
});
