// Append-time done dedupe (studio.onAgentEvent "done"): on a clean finish
// agent-core emits the model's final text TWICE — an `assistant` event and
// then `done` with the same string as the summary. The trace must carry that
// reply once, as the final "thought" line; a done line is appended only when
// the summary ADDS information ("Stopped by the user.", the step-limit
// notice, "Done." after a tool-only turn). Lifecycle-test idiom: real Studio
// over fake-indexeddb, a chat-mock gateway for the end-to-end case, and
// direct onAgentEvent injection for the edge cases.
import "fake-indexeddb/auto";
import { describe, it, expect, vi } from "vitest";
import { Studio, type Run } from "./studio.js";
import { ModelGateway } from "@erdou/model-gateway";
import { DEFAULT_MODEL } from "./model-config.js";
import type { AgentEvent } from "@erdou/agent-core";

const mkRun = (id: string): Run => ({
  id,
  title: id,
  task: id,
  status: "running",
  trace: [],
  changes: [],
  messages: [],
  createdAt: 1,
});

function emit(studio: Studio, run: Run, e: AgentEvent): void {
  (studio as unknown as { onAgentEvent(r: Run, e: AgentEvent): void }).onAgentEvent(run, e);
}

async function bootedStudioWithRun(): Promise<{ studio: Studio; run: Run }> {
  const studio = new Studio();
  await studio.boot();
  const run = mkRun("dedupe");
  studio.runs = [run, ...studio.runs];
  return { studio, run };
}

describe("Studio done-line dedupe (append time)", () => {
  it("a clean finish appends the reply once — no done echo of the final assistant text", async () => {
    const studio = new Studio();
    await studio.boot();
    const reply = "Hello! How can I help?";
    const chat = vi.fn().mockResolvedValue({ content: reply, toolCalls: [] });
    (studio as unknown as { gateway: ModelGateway }).gateway = { chat } as unknown as ModelGateway;

    await studio.startRun("say hi", DEFAULT_MODEL, "auto");

    const run = studio.runs.find((r) => r.task === "say hi");
    expect(run).toBeDefined();
    const hits = run!.trace.filter((l) => l.text === reply);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.kind).toBe("thought");
    expect(run!.trace.some((l) => l.kind === "done")).toBe(false);
  });

  it("a summary that adds information still lands as a done line", async () => {
    const { studio, run } = await bootedStudioWithRun();
    emit(studio, run, { type: "assistant", content: "Working on it." });
    emit(studio, run, { type: "done", reason: "aborted", summary: "Stopped by the user." });
    expect(run.trace.map((l) => l.kind)).toEqual(["thought", "done"]);
    expect(run.trace[1]!.text).toBe("Stopped by the user.");
    await studio.flushRunsSave();
  });

  it("the dedupe is trim-tolerant", async () => {
    const { studio, run } = await bootedStudioWithRun();
    emit(studio, run, { type: "assistant", content: "All wired up." });
    emit(studio, run, { type: "done", reason: "done", summary: " All wired up.\n" });
    expect(run.trace.filter((l) => l.kind === "done")).toHaveLength(0);
    await studio.flushRunsSave();
  });

  it("an empty summary falls back to 'Done.' and lands on an empty trace (no crash, adds info)", async () => {
    const { studio, run } = await bootedStudioWithRun();
    emit(studio, run, { type: "done", reason: "done", summary: "" });
    expect(run.trace.map((l) => [l.kind, l.text])).toEqual([["done", "Done."]]);
    await studio.flushRunsSave();
  });

  it("an empty max_steps summary falls back to the step-limit notice", async () => {
    const { studio, run } = await bootedStudioWithRun();
    emit(studio, run, { type: "assistant", content: "Still going…" });
    emit(studio, run, { type: "done", reason: "max_steps", summary: "" });
    expect(run.trace.at(-1)!.text).toBe("Stopped at the step limit.");
    expect(run.trace.at(-1)!.kind).toBe("done");
    await studio.flushRunsSave();
  });
});
