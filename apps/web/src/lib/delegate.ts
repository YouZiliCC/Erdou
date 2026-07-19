import { BrowserRuntime } from "@erdou/runtime-browser";
import { CodingAgent, type AgentEvent } from "@erdou/agent-core";
import type { ModelGateway, ModelConfig } from "@erdou/model-gateway";
import type { Runtime, Snapshot, SnapshotFsNode, RuntimeEvent, FileSystemApi } from "@erdou/runtime-contract";
import type { ToolDef } from "@erdou/agent-tools";
import { registerLanguages, AGENT_LANGUAGES, AGENT_COMMANDS } from "./languages.js";
import type { FileChange, TraceLine } from "./studio.js";

/**
 * The `delegate` tool — v1 multi-agent orchestration (spike 4).
 *
 * One BATCH call fans out 1..3 sub-agents. Batching is load-bearing, not
 * ergonomics: CodingAgent executes the tool calls of one assistant turn
 * strictly sequentially, so per-child calls could never overlap — only a batch
 * inside a single execute() can run children under Promise.all (their model
 * calls overlap; tool work still shares the one JS thread).
 *
 * Isolation: the parent workspace is snapshotted ONCE per call; every child
 * runs against its own throwaway BrowserRuntime restored from that snapshot
 * (browser-kernel scratch even when the parent is on the VM kernel — stated
 * honestly in the tool description). Children get createTools() only: no
 * delegate (depth cap 1 by construction), no open_preview / package_project /
 * switch_environment, and no approve callback — safe because nothing touches
 * the real workspace until the (approval-gated) delegate call applies diffs.
 *
 * Merge: children are applied in array order, only those that finished "done".
 * A child whose diff touches a path an earlier child already applied is
 * rejected WHOLESALE (fail fast, nothing partial) with the conflicting paths
 * named — the parent model decides what to do next. Applies go through the
 * parent runtime's CONTRACT calls so file.changed fires and the run-scoped
 * diff subscription / Review tab pick the merged changes up with no extra
 * plumbing. Unlike the run diff (display), this diff is the TRANSPORT of the
 * child's work, so it is byte-exact (binary — git objects, images — survives)
 * and directory-path events are expanded per-file (`rm -rf dir/`, `mv a/ b/`
 * and `cp -r` of whole directories merge) — see computeChildChanges.
 */

/** Hard cap on sub-agents per delegate call (bounds memory: each child is a
 *  full in-memory VFS copy + its own lazy language runtimes). */
export const MAX_DELEGATE_AGENTS = 3;
/** Child step budget — deliberately below the parent's 25. */
export const CHILD_MAX_STEPS = 12;
/** Per-line cap on nested child trace detail (persisted via runs-store —
 *  uncapped tool outputs would bloat IndexedDB / .erdou). */
const CHILD_DETAIL_CAP = 4000;
/** Cap on a child's report text inside the tool output. */
const REPORT_CAP = 2000;

export interface DelegateAgentSpec {
  /** Display label, defaulted to "agent N" when the model omits it. */
  role: string;
  task: string;
}

/** A scratch child runtime: the contract plus the host-side sync fs view
 *  (BrowserRuntime satisfies this; tests may fake it). */
export interface ScratchRuntime extends Runtime {
  readonly fs: FileSystemApi;
}

export interface DelegateDeps {
  /** The PARENT runtime (Studio's delegating facade): snapshot source and
   *  apply-back target. */
  runtime: Runtime;
  /** Same gateway + model as the parent turn. */
  gateway: ModelGateway;
  model: ModelConfig;
  /** The parent run's abort signal — propagated to every child, so Stop exits
   *  children at their next checkpoint (stoppedReason "aborted"). */
  signal: AbortSignal;
  /** Child lifecycle reporting: called with a per-child key (unique across
   *  delegate calls) and the full detail payload on start, on every child
   *  agent event, and on final status — the Studio renders/persists it as a
   *  kind:"subagent" trace line. */
  onChildUpdate?: (key: string, detail: SubagentDetail) => void;
  /** Test seam — production children are BrowserRuntime + registerLanguages. */
  makeScratch?: (base: Snapshot) => Promise<ScratchRuntime>;
}

/** The JSON payload of a kind:"subagent" trace line's `detail` (plain JSON —
 *  persists through runs-store/.erdou like any other trace line; `trace` holds
 *  the child's own lines, rendered nested + collapsible by SubagentCard). */
export interface SubagentDetail {
  role: string;
  task: string;
  status: "running" | "done" | "max_steps" | "aborted" | "error" | "conflict";
  steps: number;
  /** Final message / error text / conflict explanation ("" while running). */
  summary: string;
  trace: TraceLine[];
}

const SUBAGENT_STATUSES: readonly SubagentDetail["status"][] = [
  "running",
  "done",
  "max_steps",
  "aborted",
  "error",
  "conflict",
];

/** Parse a subagent line's `detail` back into its payload; null when missing
 *  or the wrong shape (a truncated/hand-edited persisted trace) — the
 *  parseArtifactDetail pattern. */
export function parseSubagentDetail(detail: string | undefined): SubagentDetail | null {
  if (!detail) return null;
  try {
    const p: unknown = JSON.parse(detail);
    if (
      typeof p === "object" &&
      p !== null &&
      typeof (p as SubagentDetail).role === "string" &&
      typeof (p as SubagentDetail).task === "string" &&
      SUBAGENT_STATUSES.includes((p as SubagentDetail).status) &&
      typeof (p as SubagentDetail).steps === "number" &&
      typeof (p as SubagentDetail).summary === "string" &&
      Array.isArray((p as SubagentDetail).trace) &&
      (p as SubagentDetail).trace.every(
        (l) =>
          typeof l === "object" &&
          l !== null &&
          typeof l.id === "number" &&
          typeof l.kind === "string" &&
          typeof l.text === "string" &&
          typeof l.ts === "number",
      )
    ) {
      return p as SubagentDetail;
    }
  } catch {
    // fall through — malformed JSON reads as "not a subagent payload"
  }
  return null;
}

/**
 * Validate + normalize the model's arguments. Fail-fast with a precise message
 * (returned as the tool output) — no partial acceptance.
 */
export function validateDelegateArgs(args: Record<string, unknown>): DelegateAgentSpec[] {
  const agents = args.agents;
  if (!Array.isArray(agents)) throw new Error("delegate needs an `agents` array of {role?, task} objects.");
  if (agents.length < 1 || agents.length > MAX_DELEGATE_AGENTS) {
    throw new Error(`delegate takes 1..${MAX_DELEGATE_AGENTS} agents; got ${agents.length}.`);
  }
  return agents.map((a, i) => {
    if (typeof a !== "object" || a === null) throw new Error(`agents[${i}] must be an object with a \`task\`.`);
    const task = (a as { task?: unknown }).task;
    if (typeof task !== "string" || task.trim() === "") {
      throw new Error(`agents[${i}].task must be a non-empty string.`);
    }
    const role = (a as { role?: unknown }).role;
    if (role !== undefined && typeof role !== "string") throw new Error(`agents[${i}].role must be a string.`);
    return { role: (role ?? "").trim() || `agent ${i + 1}`, task: task.trim() };
  });
}

/** Paths of `changes` already applied by an earlier child this call. Pure. */
export function conflictPaths(changes: FileChange[], applied: ReadonlySet<string>): string[] {
  return changes.filter((c) => applied.has(c.path)).map((c) => c.path);
}

const dec = new TextDecoder();

const b64ToBytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/** Walk the snapshot tree to the node at `path`; null when absent. (Duplicates
 *  SnapshotReader's walk — that class only exposes decoded-string reads, and
 *  the merge needs node TYPES and raw BYTES.) */
function snapshotNodeAt(root: SnapshotFsNode, path: string): SnapshotFsNode | null {
  let node: SnapshotFsNode | undefined = root;
  for (const part of path.split("/").filter(Boolean)) {
    if (node === undefined || node.type !== "directory") return null;
    node = node.children[part];
  }
  return node ?? null;
}

const joinPath = (dir: string, name: string): string => (dir === "/" ? `/${name}` : `${dir}/${name}`);

/** All FILE paths under a snapshot directory node (recursive; symlinks skipped). */
function collectSnapshotFiles(node: SnapshotFsNode & { type: "directory" }, dirPath: string, out: Set<string>): void {
  for (const [name, child] of Object.entries(node.children)) {
    const p = joinPath(dirPath, name);
    if (child.type === "file") out.add(p);
    else if (child.type === "directory") collectSnapshotFiles(child, p, out);
  }
}

/** All FILE paths under a live scratch directory (recursive; symlinks skipped). */
function collectScratchFiles(fs: FileSystemApi, dirPath: string, out: Set<string>): void {
  for (const e of fs.readdir(dirPath)) {
    const p = joinPath(dirPath, e.name);
    if (e.type === "file") out.add(p);
    else if (e.type === "directory") collectScratchFiles(fs, p, out);
  }
}

/** A child's captured work: display-grade FileChanges (decoded text, for the
 *  report and conflict bookkeeping) plus the EXACT bytes of every
 *  create/modify — the merge writes the bytes, never the decoded strings. */
export interface ChildChanges {
  changes: FileChange[];
  bytes: Map<string, Uint8Array>;
}

/**
 * Diff a child's scratch fs against the base snapshot, from the paths its
 * file.changed events touched. Two properties the plain run-diff readers
 * (Studio.computeRunChanges) deliberately do NOT have, both load-bearing here
 * because for delegate the diff is the TRANSPORT of the child's work (a
 * dropped or mangled entry loses/corrupts real output, not just a diff view):
 *
 * - BYTE-exact: content is compared and carried as bytes. A string compare
 *   can false-drop a binary modify (any two invalid sequences decode to the
 *   same U+FFFD), and string transport corrupts every non-UTF-8 file a child
 *   produces (git index/objects, images, sqlite, zips) on merge.
 * - DIRECTORY expansion: Vfs rm/rename/copy emit ONE file.changed for a
 *   directory path — the files inside never get events. Every changed path
 *   that is a directory in the base snapshot and/or the scratch fs expands
 *   into the per-file paths beneath it (base side → deletes, scratch side →
 *   creates; a rename is thereby a delete+create pair set). A directory the
 *   child removed ENTIRELY additionally yields a delete entry for the dir
 *   itself, so the merged parent does not keep an empty husk.
 *
 * Symlinks are not diffed (mirrors SnapshotReader). A directory that nets out
 * drops, and an EMPTY directory the child created is NOT merged — directories
 * materialize through their files' mkdir-parent on apply.
 */
export function computeChildChanges(base: Snapshot, fs: FileSystemApi, changedPaths: Iterable<string>): ChildChanges {
  const paths = new Set<string>();
  const removedDirs: string[] = [];
  for (const p of changedPaths) {
    paths.add(p);
    const bNode = snapshotNodeAt(base.fs, p);
    if (bNode !== null && bNode.type === "directory") {
      collectSnapshotFiles(bNode, p, paths);
      if (!fs.exists(p)) removedDirs.push(p);
    }
    if (fs.exists(p) && fs.lstat(p).type === "directory") collectScratchFiles(fs, p, paths);
  }
  const changes: FileChange[] = [];
  const bytes = new Map<string, Uint8Array>();
  for (const p of paths) {
    const node = snapshotNodeAt(base.fs, p);
    const before = node !== null && node.type === "file" ? b64ToBytes(node.data) : null;
    const after = fs.exists(p) && fs.stat(p).type === "file" ? fs.readFile(p) : null;
    if (before === null && after === null) continue; // dirs/symlinks net out
    if (before !== null && after !== null && bytesEqual(before, after)) continue; // touched, net-unchanged
    if (after !== null) bytes.set(p, after);
    changes.push({
      path: p,
      kind: before === null ? "create" : after === null ? "delete" : "modify",
      before: before === null ? "" : dec.decode(before),
      after: after === null ? "" : dec.decode(after),
    });
  }
  for (const p of removedDirs) changes.push({ path: p, kind: "delete", before: "", after: "" });
  return { changes: changes.sort((x, y) => (x.path < y.path ? -1 : 1)), bytes };
}
const asMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const firstLine = (s: string): string => s.split("\n")[0] ?? "";
/** Hard-cap a nested detail string with an explicit truncation marker. */
const capDetail = (s: string, cap = CHILD_DETAIL_CAP): string =>
  s.length > cap ? `${s.slice(0, cap)}\n… [truncated ${s.length - cap} chars]` : s;
/** One macrotask — the events.ts bound: file.changed from a settled call is
 *  delivered no later than one macrotask after it resolves. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function formatArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("   ");
}

/** Production scratch factory: a fresh in-memory BrowserRuntime with the same
 *  language registrations as the app kernel (registration is a cheap lazy
 *  hookup; Pyodide CDN-loads only if the child actually runs python).
 *  Deliberately WITHOUT the pip-manifest persistence hooks: a throwaway
 *  child's installs must not overwrite the user's session pip manifest. */
async function defaultMakeScratch(base: Snapshot): Promise<ScratchRuntime> {
  const rt = new BrowserRuntime();
  registerLanguages(rt);
  await rt.boot();
  await rt.restoreSnapshot(base);
  return rt;
}

/** The child's environment brief additions — honest about the sandbox. */
function subAgentNotes(spec: DelegateAgentSpec): string {
  return [
    `You are a sub-agent (role: ${spec.role}), delegated one focused task by a lead agent.`,
    "You work in an ISOLATED COPY of the project workspace. Your file changes are merged back into the real workspace only after you finish — and are rejected wholesale if another sub-agent already changed the same file, so stay strictly within your task's files.",
    "Do not start servers or previews: nothing outside this sandbox can reach them, and the sandbox is discarded when you finish.",
    "End with a concise report of what you did and anything the lead agent must know.",
  ].join("\n");
}

interface ChildOutcome {
  spec: DelegateAgentSpec;
  key: string;
  status: SubagentDetail["status"];
  steps: number;
  summary: string;
  changes: FileChange[];
  /** Exact bytes for every create/modify in `changes` — what the merge writes. */
  bytes: ReadonlyMap<string, Uint8Array>;
  /** Paths that collided with an earlier child's applied set (conflict status). */
  conflicts: string[];
  applied: boolean;
  trace: TraceLine[];
}

/** Run one child against a scratch runtime; never throws (an agent failure
 *  becomes status "error" so the batch report stays complete). */
async function runChild(deps: DelegateDeps, base: Snapshot, spec: DelegateAgentSpec, key: string): Promise<ChildOutcome> {
  const trace: TraceLine[] = [];
  let nextId = 1;
  let steps = 0;
  const line = (kind: TraceLine["kind"], text: string, detail?: string, ok?: boolean): TraceLine => ({
    id: nextId++,
    kind,
    text,
    detail,
    ok,
    ts: Date.now(),
  });
  const report = (status: SubagentDetail["status"], summary: string): void =>
    deps.onChildUpdate?.(key, { role: spec.role, task: spec.task, status, steps, summary, trace: [...trace] });

  report("running", "");
  let status: SubagentDetail["status"];
  let summary: string;
  let changes: FileChange[] = [];
  let bytes: ReadonlyMap<string, Uint8Array> = new Map();
  try {
    const scratch = await (deps.makeScratch ?? defaultMakeScratch)(base);
    const changedPaths = new Set<string>();
    const unsub = scratch.subscribe((e: RuntimeEvent) => {
      if (e.type === "file.changed") changedPaths.add(e.path);
    });
    const child = new CodingAgent({
      runtime: scratch,
      gateway: deps.gateway,
      model: deps.model,
      maxSteps: CHILD_MAX_STEPS,
      signal: deps.signal,
      // No `approve`: children run ungated INSIDE the throwaway sandbox — the
      // delegate call itself was the approval gate, and per-child prompts would
      // collide in Studio's single pendingApproval slot (see the spike).
      environment: { languages: AGENT_LANGUAGES, commands: AGENT_COMMANDS, notes: subAgentNotes(spec) },
      onEvent: (e: AgentEvent) => {
        // The same event→line mapping as Studio.onAgentEvent, capped for persistence.
        switch (e.type) {
          case "step":
            steps = e.step;
            return; // no line; the header shows the count
          case "assistant":
            if (e.content.trim().length > 0) trace.push(line("thought", capDetail(e.content)));
            break;
          case "tool_call":
            trace.push(line("tool", e.name, capDetail(formatArgs(e.args))));
            break;
          case "tool_result":
            trace.push(line("result", firstLine(e.output), capDetail(e.output), e.ok));
            break;
          case "done":
            trace.push(line("done", e.summary || (e.reason === "max_steps" ? "Stopped at the step limit." : "Done.")));
            break;
        }
        report("running", "");
      },
    });
    try {
      const result = await child.run(spec.task);
      status = result.stoppedReason;
      steps = result.steps;
      summary = result.finalMessage;
    } catch (err) {
      status = "error";
      summary = asMessage(err);
      trace.push(line("error", "Sub-agent stopped", capDetail(summary)));
    }
    // Settle async file.changed delivery BEFORE reading the changed set, then
    // diff scratch-vs-base with the same helpers as the run diff. An aborted /
    // max_steps / errored child still gets its diff computed — it is REPORTED
    // (never applied), so the parent knows what work is stranded.
    await settle();
    unsub();
    const captured = computeChildChanges(base, scratch.fs, changedPaths);
    changes = captured.changes;
    bytes = captured.bytes;
    // Tear down the throwaway runtime (kills stray child background processes).
    // Best-effort: everything observable is already captured above.
    await scratch.shutdown().catch(() => undefined);
  } catch (err) {
    // Scratch construction/boot/restore failed — a real defect, reported precisely.
    status = "error";
    summary = `sub-agent sandbox failed: ${asMessage(err)}`;
    trace.push(line("error", "Sub-agent sandbox failed", capDetail(asMessage(err))));
  }
  report(status, summary);
  return { spec, key, status, steps, summary, changes, bytes, conflicts: [], applied: false, trace };
}

/** True when `path` currently holds a directory on the parent. */
async function dirAt(runtime: Runtime, path: string): Promise<boolean> {
  try {
    return (await runtime.stat(path)).type === "directory";
  } catch {
    return false; // ENOENT — the normal create case
  }
}

/** Apply one child's changes to the parent via CONTRACT calls (rm / mkdir-
 *  parent + writeFile — the same path agent-tools uses, so file.changed fires
 *  on both kernels and the run diff / folder sync pick the merge up).
 *  Ordering: all DELETES first, children before parents — each per-file rm
 *  emits a real parent event (the Review tab shows every deleted file), the
 *  trailing dir rm drops the emptied dir, and a later create can then land
 *  where a deleted file/dir used to be (dir→file replacement). Writes carry
 *  the child's exact BYTES, never the decoded diff strings — a string write
 *  would corrupt every non-UTF-8 file with U+FFFD replacement sequences. */
async function applyChanges(
  runtime: Runtime,
  changes: FileChange[],
  bytes: ReadonlyMap<string, Uint8Array>,
  applied: Set<string>,
): Promise<void> {
  const deletes = changes.filter((c) => c.kind === "delete").reverse(); // ascending → descending: children first
  const writes = changes.filter((c) => c.kind !== "delete");
  for (const c of deletes) {
    await runtime.rm(c.path, { recursive: true, force: true });
    applied.add(c.path);
  }
  for (const c of writes) {
    const data = bytes.get(c.path);
    if (data === undefined) throw new Error(`delegate merge: no captured bytes for ${c.path} (invariant violation)`);
    const dir = c.path.slice(0, c.path.lastIndexOf("/")) || "/";
    if (dir !== "/") await runtime.mkdir(dir, { recursive: true });
    // A directory occupying a created file's path (the child replaced a dir
    // with a file; only its leftover empty husk remains after the deletes
    // above) would EISDIR the write — remove it first.
    if (await dirAt(runtime, c.path)) await runtime.rm(c.path, { recursive: true, force: true });
    await runtime.writeFile(c.path, data);
    applied.add(c.path);
  }
}

const STATUS_HEADLINE: Record<SubagentDetail["status"], string> = {
  running: "running", // never in a final report
  done: "done",
  max_steps: `hit its ${CHILD_MAX_STEPS}-step limit; its changes were NOT applied`,
  aborted: "stopped (the run was aborted); its changes were NOT applied",
  error: "failed; its changes were NOT applied",
  conflict: "CONFLICT — ALL of its changes were rejected",
};

function formatReport(outcomes: ChildOutcome[]): string {
  const blocks = outcomes.map((oc, i) => {
    const kindPaths = oc.changes.map((c) => `${c.kind}:${c.path}`).join(", ");
    const lines = [`sub-agent ${i + 1}/${outcomes.length} (${oc.spec.role}) — ${STATUS_HEADLINE[oc.status]} [${oc.steps} steps]`];
    if (oc.status === "conflict") {
      lines.push(`conflicting paths (already changed by an earlier sub-agent in this call): ${oc.conflicts.join(", ")}`);
      lines.push(`rejected changes (${oc.changes.length}): ${kindPaths}`);
    } else if (oc.applied) {
      lines.push(oc.changes.length > 0 ? `files applied (${oc.changes.length}): ${kindPaths}` : "files applied: none (no file changes)");
    } else if (oc.changes.length > 0) {
      lines.push(`unapplied changes left in its discarded sandbox (${oc.changes.length}): ${kindPaths}`);
    }
    if (oc.summary) lines.push(`report: ${capDetail(oc.summary, REPORT_CAP)}`);
    return lines.join("\n");
  });
  return blocks.join("\n\n");
}

/** Monotonic per-page counter so child keys stay unique across delegate calls
 *  (a run may delegate more than once; the Studio maps key → trace line). */
let delegateSeq = 0;

/** Build the `delegate` ToolDef for one agent turn. */
export function createDelegateTool(deps: DelegateDeps): ToolDef {
  return {
    name: "delegate",
    description:
      `Fan out 1..${MAX_DELEGATE_AGENTS} sub-agents IN PARALLEL, each working on one self-contained subtask in an ` +
      "isolated copy of the current workspace (a fast in-browser sandbox: file tools, shell, python/wasi/git — " +
      "no Linux VM, no npm, no preview, and sub-agents cannot delegate further). Their model calls overlap, so " +
      "use ONE call with several agents for independent subtasks that touch DIFFERENT files. When a sub-agent " +
      "finishes, its file changes are merged back in array order; a sub-agent that touches a file an earlier one " +
      "already changed has ALL its changes rejected (reported to you — split tasks by file ownership). Each " +
      `sub-agent has ${CHILD_MAX_STEPS} steps and reports back. Sub-agents run WITHOUT per-command approval inside ` +
      "their sandboxes; this delegate call itself is the approval gate — nothing touches the real workspace until " +
      "the merge.",
    parameters: {
      type: "object",
      properties: {
        agents: {
          type: "array",
          minItems: 1,
          maxItems: MAX_DELEGATE_AGENTS,
          description: `The sub-agents to run concurrently (1..${MAX_DELEGATE_AGENTS}).`,
          items: {
            type: "object",
            properties: {
              role: { type: "string", description: 'Short display label, e.g. "tests" or "docs".' },
              task: {
                type: "string",
                description:
                  "A fully self-contained task brief: the sub-agent sees ONLY this text plus the workspace copy — no conversation history.",
              },
            },
            required: ["task"],
          },
        },
      },
      required: ["agents"],
    },
    execute: async (_ctx, args) => {
      let specs: DelegateAgentSpec[];
      try {
        specs = validateDelegateArgs(args);
      } catch (err) {
        return { ok: false, output: asMessage(err) };
      }
      // ONE snapshot per call — the parent loop is parked inside this tool, so
      // the main runtime is agent-idle by construction (works on both kernels).
      const base = await deps.runtime.createSnapshot();
      const callId = ++delegateSeq;
      const outcomes = await Promise.all(specs.map((spec, i) => runChild(deps, base, spec, `${callId}:${i}`)));
      // Sequential merge in array order; "done" children only.
      const applied = new Set<string>();
      for (const oc of outcomes) {
        if (oc.status !== "done") continue;
        const conflicts = conflictPaths(oc.changes, applied);
        if (conflicts.length > 0) {
          oc.status = "conflict";
          oc.conflicts = conflicts;
          oc.summary = `conflict: ${conflicts.join(", ")} already changed by an earlier sub-agent in this delegate call — ALL of this sub-agent's changes were rejected. Its report was: ${capDetail(oc.summary, REPORT_CAP)}`;
        } else {
          await applyChanges(deps.runtime, oc.changes, oc.bytes, applied);
          oc.applied = true;
        }
        deps.onChildUpdate?.(oc.key, {
          role: oc.spec.role,
          task: oc.spec.task,
          status: oc.status,
          steps: oc.steps,
          summary: oc.summary,
          trace: oc.trace,
        });
      }
      // ok ⇔ at least one child's work landed (a clean empty-diff completion
      // counts: its report IS its work). All conflicted/failed/aborted → false.
      const ok = outcomes.some((o) => o.status === "done");
      return { ok, output: formatReport(outcomes) };
    },
  };
}
