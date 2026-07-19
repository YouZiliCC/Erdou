// Unit tests for the delegate tool (spike 4 parts a-c as vitest tests): real
// BrowserRuntimes for parent + children, a scripted fake gateway routed by the
// transcript's task text (deterministic under Promise.all interleaving).
import { describe, it, expect } from "vitest";
import { BrowserRuntime } from "@erdou/runtime-browser";
import type { ModelGateway, ModelConfig, ChatMessage } from "@erdou/model-gateway";
import {
  createDelegateTool,
  parseSubagentDetail,
  validateDelegateArgs,
  conflictPaths,
  computeChildChanges,
  type SubagentDetail,
} from "./delegate.js";

const model: ModelConfig = { provider: "openai-compatible", baseUrl: "https://x", apiKey: "k", model: "m" };
const dec = new TextDecoder();

interface Turn {
  content: string;
  toolCalls: { id: string; name: string; arguments: string }[];
}
const turnTool = (id: string, name: string, args: unknown): Turn => ({
  content: "",
  toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
});
const turnFinal = (content: string): Turn => ({ content, toolCalls: [] });

/**
 * A scripted gateway ROUTED BY TASK: each chat call is answered from the
 * script keyed by the transcript's first user message (the child's task, or
 * the parent's). Robust to Promise.all interleaving — no shared call counter.
 */
function routedGateway(
  scripts: Record<string, Turn[]>,
  opts: { latencyMs?: number; onCall?: (task: string, index: number) => void } = {},
): ModelGateway {
  const idx = new Map<string, number>();
  const chat = async (_model: unknown, messages: ChatMessage[]): Promise<Turn> => {
    const task = messages.find((m) => m.role === "user")?.content ?? "";
    const i = idx.get(task) ?? 0;
    idx.set(task, i + 1);
    opts.onCall?.(task, i);
    if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
    const turns = scripts[task];
    if (!turns) throw new Error(`routedGateway: no script for task "${task}"`);
    return turns[i] ?? turnFinal("done");
  };
  return { chat } as unknown as ModelGateway;
}

async function parentWith(seed: Record<string, string | Uint8Array>): Promise<BrowserRuntime> {
  const rt = new BrowserRuntime();
  await rt.boot();
  for (const [path, content] of Object.entries(seed)) {
    const dir = path.slice(0, path.lastIndexOf("/")) || "/";
    if (dir !== "/") rt.fs.mkdir(dir, { recursive: true });
    rt.fs.writeFile(path, content);
  }
  return rt;
}

interface Update {
  key: string;
  detail: SubagentDetail;
}
function harness(parent: BrowserRuntime, gateway: ModelGateway, signal?: AbortSignal) {
  const updates: Update[] = [];
  const tool = createDelegateTool({
    runtime: parent,
    gateway,
    model,
    signal: signal ?? new AbortController().signal,
    onChildUpdate: (key, detail) => updates.push({ key, detail }),
  });
  return { tool, updates };
}
const lastFor = (updates: Update[], role: string): SubagentDetail => {
  const mine = updates.filter((u) => u.detail.role === role);
  const last = mine[mine.length - 1];
  if (!last) throw new Error(`no updates for role ${role}`);
  return last.detail;
};

describe("delegate — batch round-trip (spike part a)", () => {
  it("runs two children on isolated copies and merges both disjoint diffs back", async () => {
    const parent = await parentWith({
      "/README.md": "# Project\n",
      "/untouched.txt": "leave me\n",
      "/obsolete.txt": "delete me\n",
    });
    const gateway = routedGateway({
      "build the api": [
        turnTool("a0", "make_dir", { path: "/a" }),
        turnTool("a1", "write_file", { path: "/a/one.ts", content: "export const one = 1;\n" }),
        turnTool("a2", "run_shell", { command: "echo appended >> /README.md" }),
        turnFinal("API built."),
      ],
      "prune dead files": [turnTool("b1", "remove_path", { path: "/obsolete.txt" }), turnFinal("Pruned.")],
    });
    const { tool, updates } = harness(parent, gateway);

    const res = await tool.execute(
      { runtime: parent },
      { agents: [{ role: "api", task: "build the api" }, { role: "prune", task: "prune dead files" }] },
    );

    expect(res.ok).toBe(true);
    // Merged back through the parent: create + shell-driven modify + delete.
    expect(dec.decode(parent.fs.readFile("/a/one.ts"))).toBe("export const one = 1;\n");
    expect(dec.decode(parent.fs.readFile("/README.md"))).toBe("# Project\nappended\n");
    expect(parent.fs.exists("/obsolete.txt")).toBe(false);
    expect(dec.decode(parent.fs.readFile("/untouched.txt"))).toBe("leave me\n");
    // The report names both children with status, steps, and kind:path lists.
    expect(res.output).toContain("sub-agent 1/2 (api) — done");
    expect(res.output).toContain("files applied (2): modify:/README.md, create:/a/one.ts");
    expect(res.output).toContain("sub-agent 2/2 (prune) — done");
    expect(res.output).toContain("files applied (1): delete:/obsolete.txt");
    expect(res.output).toContain("report: API built.");
    // Lifecycle: first update per child is "running" with an empty trace;
    // the final one is "done" with a nested tool/result/done trace.
    const apiUpdates = updates.filter((u) => u.detail.role === "api");
    expect(apiUpdates[0]?.detail.status).toBe("running");
    expect(apiUpdates[0]?.detail.trace).toHaveLength(0);
    const apiFinal = lastFor(updates, "api");
    expect(apiFinal.status).toBe("done");
    expect(apiFinal.steps).toBe(4);
    expect(apiFinal.task).toBe("build the api");
    expect(apiFinal.trace.some((l) => l.kind === "tool" && l.text === "write_file")).toBe(true);
    expect(apiFinal.trace.some((l) => l.kind === "result" && l.ok === true)).toBe(true);
    expect(apiFinal.trace.some((l) => l.kind === "done" && l.text === "API built.")).toBe(true);
    // Distinct keys per child.
    expect(new Set(updates.map((u) => u.key)).size).toBe(2);
  });

  it("children cannot delegate further — depth cap by construction (createTools only)", async () => {
    const parent = await parentWith({});
    const gateway = routedGateway({
      recurse: [turnTool("r1", "delegate", { agents: [{ task: "deeper" }] }), turnFinal("gave up recursing")],
    });
    const { tool, updates } = harness(parent, gateway);

    const res = await tool.execute({ runtime: parent }, { agents: [{ role: "rec", task: "recurse" }] });

    expect(res.ok).toBe(true); // the child still finished "done"
    const final = lastFor(updates, "rec");
    expect(final.status).toBe("done");
    expect(final.trace.some((l) => l.kind === "result" && l.ok === false && l.text === "unknown tool: delegate")).toBe(
      true,
    );
  });

  it("an empty-diff child completes ok — its report is its work", async () => {
    const parent = await parentWith({ "/notes.md": "hello\n" });
    const gateway = routedGateway({ "just look around": [turnFinal("Reviewed: nothing to change.")] });
    const { tool, updates } = harness(parent, gateway);

    const res = await tool.execute({ runtime: parent }, { agents: [{ task: "just look around" }] });

    expect(res.ok).toBe(true);
    expect(res.output).toContain("files applied: none (no file changes)");
    expect(res.output).toContain("report: Reviewed: nothing to change.");
    // role defaults to "agent 1" when the model omits it.
    expect(lastFor(updates, "agent 1").status).toBe("done");
  });
});

describe("delegate — conflict semantics (spike part b)", () => {
  it("a later child touching an already-applied path is rejected WHOLESALE with the paths named", async () => {
    const parent = await parentWith({ "/shared.ts": "base\n" });
    const gateway = routedGateway({
      "task A": [turnTool("a1", "write_file", { path: "/shared.ts", content: "A version\n" }), turnFinal("A done")],
      "task B": [
        turnTool("b1", "write_file", { path: "/shared.ts", content: "B version\n" }),
        turnTool("b2", "write_file", { path: "/b-only.ts", content: "b\n" }),
        turnFinal("B done"),
      ],
    });
    const { tool, updates } = harness(parent, gateway);

    const res = await tool.execute(
      { runtime: parent },
      { agents: [{ role: "A", task: "task A" }, { role: "B", task: "task B" }] },
    );

    // A landed; NOTHING of B did (not even its non-conflicting file).
    expect(res.ok).toBe(true);
    expect(dec.decode(parent.fs.readFile("/shared.ts"))).toBe("A version\n");
    expect(parent.fs.exists("/b-only.ts")).toBe(false);
    expect(res.output).toContain("sub-agent 2/2 (B) — CONFLICT — ALL of its changes were rejected");
    expect(res.output).toContain("conflicting paths (already changed by an earlier sub-agent in this call): /shared.ts");
    expect(res.output).toContain("rejected changes (2): create:/b-only.ts, modify:/shared.ts");
    // The child's card was updated to the conflict status with a precise summary.
    const bFinal = lastFor(updates, "B");
    expect(bFinal.status).toBe("conflict");
    expect(bFinal.summary).toContain("/shared.ts");
    expect(bFinal.summary).toContain("rejected");
  });

  it("conflictPaths is a pure set intersection", () => {
    const changes = [
      { path: "/a.ts", kind: "modify" as const, before: "x", after: "y" },
      { path: "/b.ts", kind: "create" as const, before: "", after: "b" },
    ];
    expect(conflictPaths(changes, new Set(["/a.ts"]))).toEqual(["/a.ts"]);
    expect(conflictPaths(changes, new Set(["/other.ts"]))).toEqual([]);
  });
});

// Fix pass: the merge is the TRANSPORT of a child's work, so it must be
// byte-exact (binary survives) and must not drop whole-directory operations
// (Vfs rm/rename/copy emit ONE event for the dir path — no per-file events).
describe("delegate — merge fidelity: bytes, not strings", () => {
  // NUL + invalid UTF-8 sequences — a decode→encode round-trip mangles this.
  const BIN = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01]);

  it("a child-produced binary file merges byte-identical", async () => {
    // Sanity: the payload is NOT UTF-8-clean, so the old string transport
    // would have merged corrupted bytes (U+FFFD replacements).
    expect(new TextEncoder().encode(dec.decode(BIN))).not.toEqual(BIN);
    const parent = await parentWith({ "/logo.png": BIN });
    const gateway = routedGateway({
      "copy the logo": [turnTool("c1", "run_shell", { command: "cp /logo.png /logo2.png" }), turnFinal("copied")],
    });
    const { tool } = harness(parent, gateway);

    const res = await tool.execute({ runtime: parent }, { agents: [{ role: "bin", task: "copy the logo" }] });

    expect(res.ok).toBe(true);
    expect(res.output).toContain("files applied (1): create:/logo2.png");
    expect(parent.fs.readFile("/logo2.png")).toEqual(BIN);
  });

  it("a binary modify is NOT dropped when both versions decode to the same replacement text", async () => {
    // 0xff and 0xfe each decode to a single U+FFFD — a STRING diff sees
    // "touched but net-unchanged" and silently loses the child's change.
    const parent = await parentWith({ "/data.bin": new Uint8Array([0xff]), "/new.bin": new Uint8Array([0xfe]) });
    const gateway = routedGateway({
      "swap the payload": [turnTool("c1", "run_shell", { command: "cp /new.bin /data.bin" }), turnFinal("swapped")],
    });
    const { tool } = harness(parent, gateway);

    const res = await tool.execute({ runtime: parent }, { agents: [{ role: "bin", task: "swap the payload" }] });

    expect(res.ok).toBe(true);
    expect(res.output).toContain("modify:/data.bin");
    expect(parent.fs.readFile("/data.bin")).toEqual(new Uint8Array([0xfe]));
  });
});

describe("delegate — merge fidelity: whole-directory operations", () => {
  it("a child's recursive directory delete merges: every file AND the dir itself go", async () => {
    const parent = await parentWith({ "/old/a.txt": "A\n", "/old/sub/b.txt": "B\n", "/keep.txt": "k\n" });
    const gateway = routedGateway({
      "prune the old tree": [turnTool("d1", "remove_path", { path: "/old" }), turnFinal("pruned")],
    });
    const { tool } = harness(parent, gateway);

    const res = await tool.execute({ runtime: parent }, { agents: [{ role: "prune", task: "prune the old tree" }] });

    expect(res.ok).toBe(true);
    expect(parent.fs.exists("/old")).toBe(false); // no empty husk left behind
    expect(dec.decode(parent.fs.readFile("/keep.txt"))).toBe("k\n");
    expect(res.output).toContain("files applied (3): delete:/old, delete:/old/a.txt, delete:/old/sub/b.txt");
  });

  it("a child's directory rename (mv src/ lib/) merges as per-file creates + deletes", async () => {
    const parent = await parentWith({ "/src/one.ts": "1\n", "/src/sub/two.ts": "2\n" });
    const gateway = routedGateway({
      "restructure": [turnTool("m1", "run_shell", { command: "mv /src /lib" }), turnFinal("moved")],
    });
    const { tool } = harness(parent, gateway);

    const res = await tool.execute({ runtime: parent }, { agents: [{ role: "mv", task: "restructure" }] });

    expect(res.ok).toBe(true);
    expect(dec.decode(parent.fs.readFile("/lib/one.ts"))).toBe("1\n");
    expect(dec.decode(parent.fs.readFile("/lib/sub/two.ts"))).toBe("2\n");
    expect(parent.fs.exists("/src")).toBe(false);
    expect(res.output).toContain(
      "files applied (5): create:/lib/one.ts, create:/lib/sub/two.ts, delete:/src, delete:/src/one.ts, delete:/src/sub/two.ts",
    );
  });

  it("a dir-deleting child conflicts with a later child touching a file inside that dir", async () => {
    const parent = await parentWith({ "/old/a.txt": "A\n" });
    const gateway = routedGateway({
      "clear old": [turnTool("a1", "remove_path", { path: "/old" }), turnFinal("cleared")],
      "touch old": [turnTool("b1", "write_file", { path: "/old/a.txt", content: "revived\n" }), turnFinal("touched")],
    });
    const { tool, updates } = harness(parent, gateway);

    const res = await tool.execute(
      { runtime: parent },
      { agents: [{ role: "A", task: "clear old" }, { role: "B", task: "touch old" }] },
    );

    // A's delete landed (per-file expansion put /old/a.txt in its applied set);
    // B is rejected wholesale — the file is NOT revived.
    expect(res.ok).toBe(true);
    expect(parent.fs.exists("/old")).toBe(false);
    expect(res.output).toContain("sub-agent 2/2 (B) — CONFLICT");
    expect(lastFor(updates, "B").status).toBe("conflict");
    expect(lastFor(updates, "B").summary).toContain("/old/a.txt");
  });

  it("a child replacing a directory with a file merges cleanly (delete-first apply order)", async () => {
    const parent = await parentWith({ "/cfg/x.txt": "x\n" });
    const gateway = routedGateway({
      "flatten cfg": [
        turnTool("f1", "remove_path", { path: "/cfg" }),
        turnTool("f2", "write_file", { path: "/cfg", content: "flat\n" }),
        turnFinal("flattened"),
      ],
    });
    const { tool } = harness(parent, gateway);

    const res = await tool.execute({ runtime: parent }, { agents: [{ role: "flat", task: "flatten cfg" }] });

    expect(res.ok).toBe(true);
    expect(parent.fs.stat("/cfg").type).toBe("file");
    expect(dec.decode(parent.fs.readFile("/cfg"))).toBe("flat\n");
    expect(res.output).toContain("files applied (2): create:/cfg, delete:/cfg/x.txt");
  });
});

describe("computeChildChanges (pure diff capture)", () => {
  it("expands a base-side directory event into per-file deletes plus the dir delete", async () => {
    const baseRt = await parentWith({ "/gone/a.txt": "A\n", "/gone/deep/b.txt": "B\n", "/stay.txt": "s\n" });
    const base = await baseRt.createSnapshot();
    const scratch = await parentWith({ "/stay.txt": "s\n" });

    const { changes, bytes } = computeChildChanges(base, scratch.fs, new Set(["/gone"]));

    expect(changes.map((c) => `${c.kind}:${c.path}`)).toEqual([
      "delete:/gone",
      "delete:/gone/a.txt",
      "delete:/gone/deep/b.txt",
    ]);
    expect(bytes.size).toBe(0);
  });

  it("expands a scratch-side directory event into per-file creates (rename/copy destination)", async () => {
    const baseRt = await parentWith({});
    const base = await baseRt.createSnapshot();
    const scratch = await parentWith({ "/dst/a.txt": "A\n", "/dst/deep/b.txt": "B\n" });

    const { changes, bytes } = computeChildChanges(base, scratch.fs, new Set(["/dst"]));

    expect(changes.map((c) => `${c.kind}:${c.path}`)).toEqual(["create:/dst/a.txt", "create:/dst/deep/b.txt"]);
    expect(dec.decode(bytes.get("/dst/a.txt")!)).toBe("A\n");
  });

  it("compares content by BYTES: touched-but-identical drops; a same-decoding binary change survives", async () => {
    const baseRt = await parentWith({ "/same.bin": new Uint8Array([0xff, 0x00]), "/mod.bin": new Uint8Array([0xff]) });
    const base = await baseRt.createSnapshot();
    const scratch = await parentWith({ "/same.bin": new Uint8Array([0xff, 0x00]), "/mod.bin": new Uint8Array([0xfe]) });

    const { changes, bytes } = computeChildChanges(base, scratch.fs, new Set(["/same.bin", "/mod.bin"]));

    expect(changes.map((c) => `${c.kind}:${c.path}`)).toEqual(["modify:/mod.bin"]);
    expect(bytes.get("/mod.bin")).toEqual(new Uint8Array([0xfe]));
  });
});

describe("delegate — abort propagation (spike part c)", () => {
  it("the parent's signal aborts children mid-flight; nothing is applied and the report is honest", async () => {
    const parent = await parentWith({ "/f.txt": "x\n" });
    const abort = new AbortController();
    const gateway = routedGateway(
      {
        "long task": [
          turnTool("c1", "write_file", { path: "/c1.txt", content: "1" }),
          turnTool("c2", "write_file", { path: "/c2.txt", content: "2" }),
          turnFinal("never reached"),
        ],
      },
      {
        latencyMs: 30,
        // Abort while the child's SECOND model call is in flight.
        onCall: (_task, i) => {
          if (i === 1) setTimeout(() => abort.abort(), 5);
        },
      },
    );
    const { tool, updates } = harness(parent, gateway, abort.signal);

    const res = await tool.execute({ runtime: parent }, { agents: [{ role: "worker", task: "long task" }] });

    expect(res.ok).toBe(false); // no child's work landed
    expect(lastFor(updates, "worker").status).toBe("aborted");
    // The partial diff is REPORTED (parent decides), never applied.
    expect(parent.fs.exists("/c1.txt")).toBe(false);
    expect(parent.fs.exists("/c2.txt")).toBe(false);
    expect(res.output).toContain("stopped (the run was aborted); its changes were NOT applied");
    expect(res.output).toContain("unapplied changes left in its discarded sandbox (1): create:/c1.txt");
  });
});

describe("delegate — argument validation (fail fast, precise)", () => {
  it.each([
    [{}, "delegate needs an `agents` array"],
    [{ agents: "x" }, "delegate needs an `agents` array"],
    [{ agents: [] }, "delegate takes 1..3 agents; got 0."],
    [{ agents: [{ task: "a" }, { task: "b" }, { task: "c" }, { task: "d" }] }, "delegate takes 1..3 agents; got 4."],
    [{ agents: [{ task: "" }] }, "agents[0].task must be a non-empty string."],
    [{ agents: [{ task: "ok" }, { role: 5, task: "x" }] }, "agents[1].role must be a string."],
  ] as const)("rejects %j", async (args, message) => {
    const parent = await parentWith({});
    const { tool } = harness(parent, routedGateway({}));
    const res = await tool.execute({ runtime: parent }, args as Record<string, unknown>);
    expect(res.ok).toBe(false);
    expect(res.output).toContain(message);
  });

  it("validateDelegateArgs normalizes roles and trims tasks", () => {
    const specs = validateDelegateArgs({ agents: [{ task: "  do it  " }, { role: " docs ", task: "write" }] });
    expect(specs).toEqual([
      { role: "agent 1", task: "do it" },
      { role: "docs", task: "write" },
    ]);
  });
});

describe("parseSubagentDetail (persistence round-trip)", () => {
  const detail: SubagentDetail = {
    role: "api",
    task: "build the api",
    status: "done",
    steps: 3,
    summary: "API built.",
    trace: [{ id: 1, kind: "tool", text: "write_file", detail: "path: /a.ts", ts: 42 }],
  };

  it("round-trips its own JSON (what runs-store persists)", () => {
    expect(parseSubagentDetail(JSON.stringify(detail))).toEqual(detail);
  });

  it.each([
    [undefined],
    ["not json"],
    [JSON.stringify({ ...detail, status: "weird" })],
    [JSON.stringify({ ...detail, trace: [{ id: "1", kind: "tool", text: "x", ts: 0 }] })],
    [JSON.stringify({ ...detail, steps: "3" })],
  ])("rejects a malformed payload: %s", (raw) => {
    expect(parseSubagentDetail(raw as string | undefined)).toBeNull();
  });
});
