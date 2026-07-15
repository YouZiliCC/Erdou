# Codex-desktop UI + terminal & mount fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the terminal's `mv`/cwd bugs and folder-mount reliability, and rebuild `apps/web` into the Codex-desktop three-column shell (layout B) with a run/thread model, per-run diff review, and a global approval toggle.

**Architecture:** Bottom-up. Kernel fixes (`mv` move-into-dir, persistent `ShellSession`) land in `@erdou/runtime-browser`; an optional approval gate lands in `@erdou/agent-core`; everything else (run model, diff, mount live-sync, the full UI) lands in `apps/web`. The layering invariant (agent → contract, runtime never depends on agent) and the runtime **contract** are unchanged.

**Tech Stack:** TypeScript, Vitest, React 18 + Vite, `@erdou/*` workspace packages, esbuild-wasm bundler, isomorphic-git, File System Access API, IndexedDB.

**Spec:** `docs/superpowers/specs/2026-07-15-codex-shell-redesign-design.md`

## Global Constraints

- **Layering (CI-enforced by `pnpm lint:deps`):** agent depends on the runtime contract; runtime never imports agent. No new cross-layer edges. `apps/web` may import concrete `@erdou/runtime-browser`.
- **No contract change:** do not modify `@erdou/runtime-contract` or `@erdou/conformance`.
- **Dev principles:** no over-engineering / YAGNI; minimize fallbacks (one correct path); fail-fast with detailed errno-style errors (never swallow into a default).
- **Errors** are thrown as `ErrnoError(code, { path, syscall })` in the kernel; tools return `{ ok:false, output }` (never throw across the tool boundary).
- **Tests** run under Vitest and must stay Node-runnable. Keep the whole suite + `pnpm lint:deps` green after every task. Run a single file with `pnpm vitest run <path>`.
- **Commits:** one per task (frequent, TDD order). Branch: `feat/round8-codex-shell` (already created).
- **Deferred (do NOT build):** multi-turn conversation replies; full git staging UI; multi-tab terminal; disk-delete propagation; command sandboxing.

---

# Phase 1 — Kernel & backend (Node-testable, TDD)

## Task 1: Kernel — `mv`/rename move-into-directory

**Files:**
- Modify: `packages/runtime-browser/src/vfs/vfs.ts` (`rename`, ~lines 223-243)
- Test: `packages/runtime-browser/src/vfs/vfs.test.ts` (add cases)

**Interfaces:**
- Consumes: `resolvePath`, `join`, `normalize`, `DirInode` (all already imported in `vfs.ts`).
- Produces: `Vfs.rename(from, to)` with POSIX move-into-directory semantics. No signature change; `BrowserRuntime.rename` and the `mv` builtin already delegate here.

- [ ] **Step 1: Write the failing tests**

Add to `vfs.test.ts` (inside the existing `describe("Vfs")` or a new `describe("rename")`):

```ts
it("mv into an existing directory keeps the source name (the reported bug)", () => {
  const fs = new Vfs();
  fs.mkdir("/1", { recursive: true });
  fs.mkdir("/1/src", { recursive: true });
  fs.writeFile("/1/src/a.txt", "hi");
  // `mv /1/src /`  — destination is the root directory
  fs.rename("/1/src", "/");
  expect(fs.exists("/src")).toBe(true);
  expect(fs.exists("/src/a.txt")).toBe(true);
  expect(fs.exists("/1/src")).toBe(false);
  // no phantom entry literally named "/"
  expect(fs.readdir("/").map((e) => e.name).sort()).toEqual(["1", "src"]);
});

it("mv a file into a directory with a trailing form", () => {
  const fs = new Vfs();
  fs.mkdir("/dir", { recursive: true });
  fs.writeFile("/a.txt", "x");
  fs.rename("/a.txt", "/dir");
  expect(fs.exists("/dir/a.txt")).toBe(true);
  expect(fs.exists("/a.txt")).toBe(false);
});

it("mv a dir onto an existing dir moves it inside", () => {
  const fs = new Vfs();
  fs.mkdir("/a", { recursive: true });
  fs.mkdir("/b", { recursive: true });
  fs.rename("/a", "/b");
  expect(fs.exists("/b/a")).toBe(true);
});

it("mv rejects moving a directory into itself or a descendant", () => {
  const fs = new Vfs();
  fs.mkdir("/a", { recursive: true });
  expect(() => fs.rename("/a", "/a")).toThrow(/EINVAL/);
  fs.mkdir("/a/b", { recursive: true });
  expect(() => fs.rename("/a", "/a/b")).toThrow(/EINVAL/);
});

it("plain rename (destination absent) still works", () => {
  const fs = new Vfs();
  fs.writeFile("/a.txt", "x");
  fs.rename("/a.txt", "/b.txt");
  expect(fs.exists("/b.txt")).toBe(true);
  expect(fs.exists("/a.txt")).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/runtime-browser/src/vfs/vfs.test.ts`
Expected: the new cases FAIL (the first shows a phantom `"/"` entry / missing `/src`).

- [ ] **Step 3: Replace `rename`**

Replace the whole `rename` method in `vfs.ts` with:

```ts
rename(from: string, to: string): void {
  const now = this.clock();
  const src = resolvePath(this.root, from, { followSymlinks: false });
  if (src.node === undefined) throw new ErrnoError("ENOENT", { path: from, syscall: "rename" });

  const dst = resolvePath(this.root, to, { followSymlinks: false });

  // Move INTO an existing directory, keeping the source's basename (mirrors `copy`).
  const intoDir = dst.node !== undefined && dst.node.type === "directory";
  const targetParent = intoDir ? (dst.node as DirInode) : dst.parent;
  const targetName = intoDir ? src.name : dst.name;
  const effectivePath = intoDir ? join(normalize(to), src.name) : normalize(to);

  if (src.node.type === "directory") {
    // A directory cannot be moved into itself or one of its descendants.
    const nf = normalize(from);
    if (effectivePath === nf || effectivePath.startsWith(nf === "/" ? "/" : nf + "/")) {
      throw new ErrnoError("EINVAL", { path: effectivePath, syscall: "rename" });
    }
  }

  src.parent.children.delete(src.name);
  src.parent.mtimeMs = now;
  targetParent.children.set(targetName, src.node);
  targetParent.mtimeMs = now;
  this.emit({ type: "file.changed", path: normalize(from), kind: "delete" });
  this.emit({ type: "file.changed", path: effectivePath, kind: "create" });
}
```

(`DirInode` is already imported from `./inode.js`; `join`, `normalize` from `./path.js`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/runtime-browser/src/vfs/vfs.test.ts`
Expected: PASS. Then `pnpm vitest run packages/runtime-browser` to confirm no regressions.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime-browser/src/vfs/vfs.ts packages/runtime-browser/src/vfs/vfs.test.ts
git commit -m "fix(runtime): mv/rename moves into an existing directory (no phantom /)"
```

---

## Task 2: Kernel — persistent `ShellSession`

**Files:**
- Create: `packages/runtime-browser/src/shell/session.ts`
- Modify: `packages/runtime-browser/src/browser-runtime.ts` (add `openShell`)
- Modify: `packages/runtime-browser/src/index.ts` (export `ShellSession`, `createShellSession`)
- Test: `packages/runtime-browser/src/shell/session.test.ts`

**Interfaces:**
- Consumes: `Shell` (`./interpreter.js`, already persists cwd/env across `execute`), `ProcessTable`, `Vfs`.
- Produces:
  ```ts
  export interface ShellSession {
    readonly cwd: string;
    exec(commandLine: string): Promise<{ code: number; stdout: string; stderr: string }>;
  }
  export function createShellSession(deps: { table: ProcessTable; vfs: Vfs; cwd?: string; env?: Record<string,string> }): ShellSession;
  // on BrowserRuntime:
  openShell(opts?: { cwd?: string; env?: Record<string, string> }): ShellSession;
  ```

- [ ] **Step 1: Write the failing test**

Create `session.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { BrowserRuntime } from "../browser-runtime.js";

describe("ShellSession", () => {
  it("persists cwd across exec calls", async () => {
    const rt = new BrowserRuntime();
    await rt.boot();
    const sh = rt.openShell();
    await sh.exec("mkdir /a");
    await sh.exec("cd /a");
    expect(sh.cwd).toBe("/a");
    const r = await sh.exec("pwd");
    expect(r.stdout.trim()).toBe("/a");
    expect(r.code).toBe(0);
  });

  it("persists env across exec calls", async () => {
    const rt = new BrowserRuntime();
    await rt.boot();
    const sh = rt.openShell();
    await sh.exec("export X=hi");
    const r = await sh.exec("echo $X");
    expect(r.stdout.trim()).toBe("hi");
  });

  it("reports non-zero exit codes and stderr", async () => {
    const rt = new BrowserRuntime();
    await rt.boot();
    const sh = rt.openShell();
    const r = await sh.exec("cat /nope.txt");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/ENOENT/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/runtime-browser/src/shell/session.test.ts`
Expected: FAIL — `rt.openShell is not a function`.

- [ ] **Step 3: Implement `session.ts`**

```ts
import type { Vfs } from "../vfs/vfs.js";
import type { ProcessTable } from "../process/process-table.js";
import { Shell } from "./interpreter.js";

export interface ShellSession {
  /** Live working directory — reads back after every command (for the prompt). */
  readonly cwd: string;
  exec(commandLine: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

export function createShellSession(deps: {
  table: ProcessTable;
  vfs: Vfs;
  cwd?: string;
  env?: Record<string, string>;
}): ShellSession {
  const shell = new Shell({ table: deps.table, vfs: deps.vfs, cwd: deps.cwd ?? "/", env: deps.env ?? {} });
  return {
    get cwd() {
      return shell.cwd;
    },
    async exec(commandLine: string) {
      const result = shell.execute(commandLine);
      const [code, stdout, stderr] = await Promise.all([
        result.wait(),
        result.stdout.text(),
        result.stderr.text(),
      ]);
      return { code, stdout, stderr };
    },
  };
}
```

(`PipeStream` implements the contract `ByteStream`, which has `.text()` — the same call `studio.exec` already makes on `p.stdout`.)

- [ ] **Step 4: Add `openShell` to `BrowserRuntime`**

In `browser-runtime.ts`, add the import and method:

```ts
// near the other imports:
import { createShellSession, type ShellSession } from "./shell/session.js";

// as a public method on BrowserRuntime (e.g. after exec()):
/** Open a persistent interactive shell whose cwd/env survive across commands. */
openShell(opts?: { cwd?: string; env?: Record<string, string> }): ShellSession {
  return createShellSession({ table: this.table, vfs: this.vfs, cwd: opts?.cwd, env: opts?.env });
}
```

In `packages/runtime-browser/src/index.ts` add:

```ts
export { createShellSession, type ShellSession } from "./shell/session.js";
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run packages/runtime-browser/src/shell/session.test.ts && pnpm vitest run packages/runtime-browser`
Expected: PASS, no regressions.

- [ ] **Step 6: Commit**

```bash
git add packages/runtime-browser/src/shell/session.ts packages/runtime-browser/src/shell/session.test.ts packages/runtime-browser/src/browser-runtime.ts packages/runtime-browser/src/index.ts
git commit -m "feat(runtime): openShell() — a persistent interactive shell session (cwd/env survive)"
```

---

## Task 3: Agent — optional approval gate

**Files:**
- Modify: `packages/agent-core/src/types.ts` (add `ApprovalRequest`, `ApprovalDecision`, `AgentOptions.approve`)
- Modify: `packages/agent-core/src/agent.ts` (parse-args-once loop + gate)
- Modify: `packages/agent-core/src/index.ts` (export the new types)
- Test: `packages/agent-core/src/agent.test.ts` (add cases; create the file if absent)

**Interfaces:**
- Consumes: existing `AgentOptions`, `runTool`, tool names `run_shell`/`remove_path`.
- Produces:
  ```ts
  export interface ApprovalRequest { tool: string; command?: string; args: Record<string, unknown>; }
  export type ApprovalDecision = "allow" | "deny";
  // AgentOptions gains: approve?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  ```

- [ ] **Step 1: Write the failing test**

Add to `agent.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { BrowserRuntime } from "@erdou/runtime-browser";
import type { ModelConfig, ModelGateway } from "@erdou/model-gateway";
import { CodingAgent } from "./agent.js";

function fakeGateway(): ModelGateway {
  const chat = vi
    .fn()
    .mockResolvedValueOnce({
      content: "",
      toolCalls: [{ id: "1", name: "run_shell", arguments: JSON.stringify({ command: "echo hi > /x.txt" }) }],
    })
    .mockResolvedValueOnce({ content: "done", toolCalls: [] });
  return { chat } as unknown as ModelGateway;
}

describe("approval gate", () => {
  it("does not run a gated command when denied", async () => {
    const runtime = new BrowserRuntime();
    await runtime.boot();
    const agent = new CodingAgent({
      runtime,
      gateway: fakeGateway(),
      model: {} as ModelConfig,
      maxSteps: 3,
      approve: async () => "deny",
    });
    await agent.run("make x");
    expect(runtime.fs.exists("/x.txt")).toBe(false);
  });

  it("runs the gated command when allowed", async () => {
    const runtime = new BrowserRuntime();
    await runtime.boot();
    const agent = new CodingAgent({
      runtime,
      gateway: fakeGateway(),
      model: {} as ModelConfig,
      maxSteps: 3,
      approve: async () => "allow",
    });
    await agent.run("make x");
    expect(runtime.fs.exists("/x.txt")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/agent-core/src/agent.test.ts`
Expected: FAIL (denied case still creates `/x.txt`).

- [ ] **Step 3: Extend `types.ts`**

```ts
export interface ApprovalRequest {
  tool: string;
  /** The shell command line, when tool === "run_shell". */
  command?: string;
  args: Record<string, unknown>;
}
export type ApprovalDecision = "allow" | "deny";
```

In `AgentOptions`, add:

```ts
  /** When set, gated tools (run_shell, remove_path) must be approved before running. */
  approve?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
```

Export from `index.ts`: `export type { ApprovalRequest, ApprovalDecision } from "./types.js";` (extend the existing type export line).

- [ ] **Step 4: Rework the tool loop in `agent.ts`**

Add near the top of the file:

```ts
const GATED_TOOLS = new Set(["run_shell", "remove_path"]);
```

Replace the `for (const call of result.toolCalls) { ... }` block in `run()` with (parses args once, emits `tool_call` **before** executing, gates when needed):

```ts
for (const call of result.toolCalls) {
  let args: Record<string, unknown> = {};
  let parseError: string | null = null;
  try {
    args = call.arguments.trim().length > 0 ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
  } catch {
    parseError = `invalid JSON arguments for ${call.name}: ${call.arguments}`;
  }
  this.emit({ type: "tool_call", name: call.name, args });

  if (parseError) {
    this.emit({ type: "tool_result", name: call.name, ok: false, output: parseError });
    messages.push({ role: "tool", toolCallId: call.id, content: parseError });
    continue;
  }

  if (this.opts.approve && GATED_TOOLS.has(call.name)) {
    const decision = await this.opts.approve({
      tool: call.name,
      command: typeof args.command === "string" ? args.command : undefined,
      args,
    });
    if (decision === "deny") {
      const output = "Denied by the user.";
      this.emit({ type: "tool_result", name: call.name, ok: false, output });
      messages.push({ role: "tool", toolCallId: call.id, content: output });
      continue;
    }
  }

  const { output, ok } = await this.executeTool(call.name, args);
  this.emit({ type: "tool_result", name: call.name, ok, output });
  messages.push({ role: "tool", toolCallId: call.id, content: output });
}
```

Replace the private `runTool` (which re-parsed args) with `executeTool` that takes already-parsed args:

```ts
private async executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ output: string; ok: boolean }> {
  const tool = this.toolByName.get(name);
  if (!tool) return { ok: false, output: `unknown tool: ${name}` };
  const result = await tool.execute({ runtime: this.opts.runtime }, args);
  return { ok: result.ok, output: result.output };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run packages/agent-core` — both new cases PASS, existing agent tests still green.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-core/src/types.ts packages/agent-core/src/agent.ts packages/agent-core/src/index.ts packages/agent-core/src/agent.test.ts
git commit -m "feat(agent): optional approval gate for run_shell/remove_path (default off)"
```

---

## Task 4: Mount library — mtime tracking for live pull

**Files:**
- Modify: `apps/web/src/lib/local-mount.ts` (`FileHandleLike.getFile` type; `loadFolderIntoVfs`, `saveVfsToFolder` record mtimes; new `rescanFolder`)
- Test: `apps/web/src/lib/local-mount.test.ts` (add cases)

**Interfaces:**
- Consumes: `FileSystemApi`, `DirHandleLike`, `FileHandleLike`.
- Produces:
  ```ts
  type MountMtimes = Map<string, number>; // vfsPath -> lastModified
  loadFolderIntoVfs(dir, fs, mountPath, mtimes?: MountMtimes): Promise<number>;
  saveVfsToFolder(fs, dir, vfsPath, mtimes?: MountMtimes): Promise<void>;
  rescanFolder(dir, fs, mtimes, mountPath?: string): Promise<string[]>; // returns pulled paths
  ```

- [ ] **Step 1: Write the failing test**

Add a mock-handle helper + cases to `local-mount.test.ts` (follow the existing mock style in that file; extend the file mock to carry `lastModified`):

```ts
it("rescanFolder pulls a file whose disk mtime changed", async () => {
  const fs = makeVfs();               // existing test helper / new BrowserRuntime().fs
  const mtimes = new Map<string, number>();
  const dir = mockDir({ "a.txt": mockFile("v1", 1000) });
  await loadFolderIntoVfs(dir as any, fs, "/", mtimes);
  expect(fs.readFileText("/a.txt")).toBe("v1");

  // simulate an external edit: same handle, newer content + mtime
  (dir as any)._files["a.txt"] = mockFile("v2", 2000);
  const pulled = await rescanFolder(dir as any, fs, mtimes, "/");
  expect(pulled).toContain("/a.txt");
  expect(fs.readFileText("/a.txt")).toBe("v2");
});

it("rescanFolder does not re-pull a file the browser just wrote back", async () => {
  const fs = makeVfs();
  const mtimes = new Map<string, number>();
  const dir = mockDir({ "a.txt": mockFile("v1", 1000) });
  await loadFolderIntoVfs(dir as any, fs, "/", mtimes);
  fs.writeFile("/a.txt", "local-edit");
  await saveVfsToFolder(fs, dir as any, "/", mtimes); // records the written mtime
  const pulled = await rescanFolder(dir as any, fs, mtimes, "/");
  expect(pulled).toEqual([]);        // our own write is not seen as external
});
```

Add mock helpers if not already present: `mockFile(text, lastModified)` returns `{ kind:"file", getFile: async () => ({ arrayBuffer: async () => new TextEncoder().encode(text).buffer, lastModified }), createWritable: ... }`, and `mockDir(files)` exposing `entries()`, `getFileHandle`, `getDirectoryHandle`, and a mutable `_files`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run apps/web/src/lib/local-mount.test.ts`
Expected: FAIL — `rescanFolder` undefined; `getFile` lacks `lastModified`.

- [ ] **Step 3: Implement**

Update the interface:

```ts
export interface FileHandleLike {
  kind: "file";
  getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; lastModified: number }>;
  createWritable(): Promise<{ write(data: BufferSource): Promise<void>; close(): Promise<void> }>;
}
export type MountMtimes = Map<string, number>;
```

`loadFolderIntoVfs` — record mtime when provided:

```ts
export async function loadFolderIntoVfs(
  dir: DirHandleLike, fs: FileSystemApi, mountPath: string, mtimes?: MountMtimes,
): Promise<number> {
  fs.mkdir(mountPath, { recursive: true });
  let count = 0;
  for await (const [name, handle] of dir.entries()) {
    if (SKIP.has(name)) continue;
    const child = joinP(mountPath, name);
    if (handle.kind === "directory") {
      count += await loadFolderIntoVfs(handle, fs, child, mtimes);
    } else {
      const file = await handle.getFile();
      fs.writeFile(child, new Uint8Array(await file.arrayBuffer()));
      mtimes?.set(child, file.lastModified);
      count++;
    }
  }
  return count;
}
```

`saveVfsToFolder` — after writing a file, record its fresh mtime so the next rescan won't treat it as external:

```ts
export async function saveVfsToFolder(
  fs: FileSystemApi, dir: DirHandleLike, vfsPath: string, mtimes?: MountMtimes,
): Promise<void> {
  for (const entry of fs.readdir(vfsPath)) {
    if (SKIP.has(entry.name)) continue;
    const child = joinP(vfsPath, entry.name);
    if (entry.type === "directory") {
      const sub = await dir.getDirectoryHandle(entry.name, { create: true });
      await saveVfsToFolder(fs, sub, child, mtimes);
    } else if (entry.type === "file") {
      const fh = await dir.getFileHandle(entry.name, { create: true });
      const writable = await fh.createWritable();
      await writable.write(fs.readFile(child));
      await writable.close();
      if (mtimes) mtimes.set(child, (await fh.getFile()).lastModified);
    }
  }
}
```

New `rescanFolder` — pull genuine external changes (additive; never deletes VFS files):

```ts
/** Pull disk files that changed externally into the VFS. Returns the pulled vfs paths. */
export async function rescanFolder(
  dir: DirHandleLike, fs: FileSystemApi, mtimes: MountMtimes, mountPath = "/",
): Promise<string[]> {
  const pulled: string[] = [];
  for await (const [name, handle] of dir.entries()) {
    if (SKIP.has(name)) continue;
    const child = joinP(mountPath, name);
    if (handle.kind === "directory") {
      pulled.push(...(await rescanFolder(handle, fs, mtimes, child)));
    } else {
      const file = await handle.getFile();
      if (mtimes.get(child) !== file.lastModified) {
        fs.writeFile(child, new Uint8Array(await file.arrayBuffer()));
        mtimes.set(child, file.lastModified);
        pulled.push(child);
      }
    }
  }
  return pulled;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run apps/web/src/lib/local-mount.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/local-mount.ts apps/web/src/lib/local-mount.test.ts
git commit -m "feat(web/mount): mtime tracking + rescanFolder for live disk->VFS pull"
```

---

## Task 5: Diff engine — `diff.ts`

**Files:**
- Create: `apps/web/src/lib/diff.ts`
- Test: `apps/web/src/lib/diff.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type DiffLine = { kind: "ctx" | "add" | "del"; text: string; oldNo?: number; newNo?: number };
  export function lineDiff(before: string, after: string): DiffLine[];
  export function diffStats(lines: DiffLine[]): { added: number; removed: number };
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { lineDiff, diffStats } from "./diff.js";

describe("lineDiff", () => {
  it("marks added and removed lines, keeps context", () => {
    const d = lineDiff("a\nb\nc\n", "a\nB\nc\n");
    const kinds = d.map((l) => l.kind);
    expect(kinds).toContain("del");
    expect(kinds).toContain("add");
    expect(d.find((l) => l.kind === "del")?.text).toBe("b");
    expect(d.find((l) => l.kind === "add")?.text).toBe("B");
    expect(diffStats(d)).toEqual({ added: 1, removed: 1 });
  });

  it("all-added when before is empty", () => {
    const d = lineDiff("", "x\ny\n");
    expect(diffStats(d)).toEqual({ added: 2, removed: 0 });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm vitest run apps/web/src/lib/diff.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `diff.ts`** (LCS-based line diff, no dependency):

```ts
export type DiffLine = { kind: "ctx" | "add" | "del"; text: string; oldNo?: number; newNo?: number };

function splitLines(s: string): string[] {
  if (s.length === 0) return [];
  const lines = s.split("\n");
  if (lines[lines.length - 1] === "") lines.pop(); // ignore trailing newline
  return lines;
}

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const n = a.length, m = b.length;
  // LCS table
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);

  const out: DiffLine[] = [];
  let i = 0, j = 0, oldNo = 1, newNo = 1;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: "ctx", text: a[i], oldNo: oldNo++, newNo: newNo++ }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ kind: "del", text: a[i], oldNo: oldNo++ }); i++; }
    else { out.push({ kind: "add", text: b[j], newNo: newNo++ }); j++; }
  }
  while (i < n) out.push({ kind: "del", text: a[i++], oldNo: oldNo++ });
  while (j < m) out.push({ kind: "add", text: b[j++], newNo: newNo++ });
  return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const l of lines) { if (l.kind === "add") added++; else if (l.kind === "del") removed++; }
  return { added, removed };
}
```

- [ ] **Step 4: Run to verify it passes** — `pnpm vitest run apps/web/src/lib/diff.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/diff.ts apps/web/src/lib/diff.test.ts
git commit -m "feat(web): LCS line-diff util for the review pane"
```

---

# Phase 2 — Codex frontend (`apps/web`)

> Phase-2 tasks are React/CSS-heavy and verified by **running the app** (see Task 13 / the `verify` skill), plus the unit tests already written for their logic (diff, mount, run store). Each task ends by confirming `pnpm --filter @erdou/web build` (typecheck+bundle) and the Vitest suite stay green.

## Task 6: Design tokens, theme, and app-shell scaffold

**Files:**
- Rewrite: `apps/web/src/styles.css` (Codex tokens + layout classes; delete amber-phosphor rules)
- Create: `apps/web/src/lib/theme.ts` (persisted light/dark)
- Create: `apps/web/src/components/TitleBar.tsx`
- Modify: `apps/web/src/App.tsx` (new three-column skeleton; keep existing panels imported but placed in the new regions — full wiring comes in later tasks)

**Interfaces:**
- Produces: CSS custom properties on `:root` (dark default) and `:root[data-theme="light"]`; `getTheme()/setTheme()/toggleTheme()`; `<TitleBar>` with workspace name, runtime/model chips, theme toggle, settings button.

- [ ] **Step 1: Write `theme.ts`**

```ts
export type Theme = "dark" | "light";
const KEY = "erdou.theme";
export function getTheme(): Theme {
  return (localStorage.getItem(KEY) as Theme) || "dark";
}
export function applyTheme(t: Theme): void {
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem(KEY, t);
}
export function toggleTheme(): Theme {
  const next: Theme = getTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  return next;
}
```

Call `applyTheme(getTheme())` once in `main.tsx` before render.

- [ ] **Step 2: Rewrite `styles.css` tokens + shell**

Replace the file's `:root`/theme section and app-frame rules with (keep/adjust panel rules referenced by later tasks):

```css
:root {
  --bg:#0d0d0d; --panel:#141414; --side:#0f0f0f; --elev:#1c1c1c; --elev2:#232323;
  --border:rgba(255,255,255,.08); --border2:rgba(255,255,255,.05);
  --ink:#ededed; --muted:#8b8b8b; --faint:#5c5c5c;
  --accent:#58a6ff; --green:#3fb950; --red:#f85149; --purple:#c695c6; --amber:#d29922;
  --sans:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  --radius:8px;
  color-scheme: dark;
}
:root[data-theme="light"] {
  --bg:#ffffff; --panel:#f7f7f8; --side:#f2f2f3; --elev:#ffffff; --elev2:#eeeef0;
  --border:#e5e5e5; --border2:#ececec; --ink:#0d0d0d; --muted:#6e6e80; --faint:#9a9aa5;
  color-scheme: light;
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font-family:var(--sans); font-size:13px; }
.app { height:100vh; display:flex; flex-direction:column; }
.shell { flex:1; display:flex; min-height:0; }
.sidebar { width:238px; flex:0 0 238px; background:var(--side); border-right:1px solid var(--border); display:flex; flex-direction:column; min-height:0; }
.center { flex:1; display:flex; flex-direction:column; min-width:0; background:var(--bg); }
.review { width:40%; min-width:320px; flex:0 0 40%; background:var(--panel); border-left:1px solid var(--border); display:flex; flex-direction:column; min-height:0; }
/* generic chips / buttons used across panels */
.chip { font-size:10px; padding:1.5px 8px; border-radius:20px; border:1px solid var(--border); color:var(--muted); display:inline-flex; align-items:center; gap:5px; }
.chip.run{color:var(--accent);border-color:rgba(88,166,255,.35);}
.chip.review{color:var(--purple);border-color:rgba(198,149,198,.35);}
.chip.done{color:var(--green);border-color:rgba(63,185,80,.3);}
.chip.error{color:var(--red);border-color:rgba(248,81,73,.3);}
.btn { font-size:12px; border:1px solid var(--border); background:var(--elev); color:var(--ink); border-radius:6px; padding:5px 11px; cursor:pointer; }
.btn.primary { background:var(--accent); color:#00121f; border-color:transparent; font-weight:600; }
.btn.ghost { background:transparent; color:var(--muted); }
```

(Reuse the token names in every later component — do not hard-code hex.) Keep the file's existing panel-specific rules but swap their colors to the tokens as you touch each panel.

- [ ] **Step 3: `TitleBar.tsx`**

```tsx
import { useState } from "react";
import { toggleTheme } from "../lib/theme.js";

export function TitleBar({
  workspace, model, running, onSettings,
}: { workspace: string; model: string; running: boolean; onSettings: () => void }) {
  const [, force] = useState(0);
  return (
    <header className="titlebar">
      <span className="wm">Er<b>dou</b></span>
      <span className="ws">— {workspace}</span>
      <span className="sp" />
      <span className="chip"><span className={"dot " + (running ? "busy" : "on")} /> runtime · js·py·wasi</span>
      <span className="chip">{model}</span>
      <button className="btn ghost" onClick={() => { toggleTheme(); force((n) => n + 1); }}>◐</button>
      <button className="btn ghost" onClick={onSettings}>Settings</button>
    </header>
  );
}
```

Add `.titlebar`, `.wm`, `.ws`, `.sp`, `.dot` rules to `styles.css` (height 38px, `border-bottom:1px solid var(--border)`, flex row, gap 10px; `.dot` 6px circle: `.on{background:var(--green)} .busy{background:var(--accent)}`).

- [ ] **Step 4: Rewrite `App.tsx` skeleton** into `<div class="app"><TitleBar/><div class="shell"><TaskSidebar/><section class="center">…</section><ReviewPane/></div></div>`. For this task, place **stub** `<aside class="sidebar">`, `<section class="center">`, `<section class="review">` (real content lands in Tasks 7–12). Keep `SettingsDialog` mounted. Ensure `pnpm --filter @erdou/web build` passes.

- [ ] **Step 5: Verify + commit**

Run: `pnpm --filter @erdou/web build` (typecheck + bundle) → success.

```bash
git add apps/web/src/styles.css apps/web/src/lib/theme.ts apps/web/src/components/TitleBar.tsx apps/web/src/App.tsx apps/web/src/main.tsx
git commit -m "feat(web): Codex design tokens, light/dark theme, title bar + three-column shell"
```

---

## Task 7: Run/thread model + persistence + TaskSidebar

**Files:**
- Create: `apps/web/src/lib/runs-store.ts` (IndexedDB, last 20 runs)
- Modify: `apps/web/src/lib/studio.ts` (replace single `trace` with `runs`/`activeRunId`; run lifecycle; status transitions)
- Create: `apps/web/src/components/TaskSidebar.tsx`
- Modify: `apps/web/src/App.tsx` (mount `TaskSidebar`, wire New-task/compose target)

**Interfaces:**
- Produces (in `studio.ts`):
  ```ts
  type RunStatus = "running" | "review" | "done" | "error";
  interface FileChange { path: string; kind: "create"|"modify"|"delete"; before: string; after: string; }
  interface Run { id: string; title: string; task: string; status: RunStatus; trace: TraceLine[]; changes: FileChange[]; createdAt: number; }
  // Studio: runs: Run[]; activeRunId: string | null;
  //         startRun(task, model): Promise<void>;  selectRun(id): void;  markReviewed(id): void;
  ```
- Consumes: existing `CodingAgent`, `TraceLine`, the run's `changes` are filled by Task 9 (leave `changes: []` here; Task 9 wires capture).

- [ ] **Step 1: `runs-store.ts`** — a small IndexedDB store mirroring `IndexedDbSnapshotStore`'s pattern (open db `erdou-runs`, store `runs`): `saveRuns(runs: Run[])` (persist the array under a single key, or one record per id — single key is simplest, cap to 20 before saving) and `loadRuns(): Promise<Run[]>`. Serialize `Run` as plain JSON (TraceLine + FileChange are JSON-safe).

- [ ] **Step 2: Rework `Studio`** — replace `trace: TraceLine[]` with `runs: Run[] = []` and `activeRunId: string | null = null`. Add:
  - `get activeRun(): Run | undefined`.
  - `startRun(task, model)`: create `{ id: crypto.randomUUID(), title: title(task), task, status:"running", trace:[], changes:[], createdAt: Date.now() }`, unshift into `runs`, set `activeRunId`, `notify()`, then drive the agent (Task 9 adds snapshot capture around this). Agent `onEvent` appends `TraceLine`s to **this run's** `trace`. On finish: `status = run.changes.length > 0 ? "review" : "done"`; on error: `"error"`. Persist via `saveRuns`. Keep `title(task)` = first line, trimmed to ~48 chars.
  - `selectRun(id)`, `markReviewed(id)` (`review`→`done`).
  - In `boot()`, `this.runs = await loadRuns()` (most-recent first).
  - Terminal/mount system messages: keep a small `systemLog: TraceLine[]` on the Studio (not tied to a run) for the empty state + sidebar footer.

- [ ] **Step 3: `TaskSidebar.tsx`**

```tsx
import type { Studio } from "../lib/studio.js";

export function TaskSidebar({ studio, onNew }: { studio: Studio; onNew: () => void }) {
  return (
    <aside className="sidebar">
      <button className="btn newtask" onClick={onNew}>＋ New task</button>
      <div className="sbh">Tasks</div>
      <div className="threads">
        {studio.runs.length === 0 && <div className="hint sm">No tasks yet.</div>}
        {studio.runs.map((r) => (
          <div key={r.id} className={"thread " + (studio.activeRunId === r.id ? "sel" : "")}
               onClick={() => studio.selectRun(r.id)}>
            <div className="row"><span className="ttl">{r.title}</span><span className={"chip " + r.status}>{r.status}</span></div>
            <div className="prev">{previewOf(r)}</div>
          </div>
        ))}
      </div>
      <div className="sbf">
        {studio.mount ? <div>📁 {studio.mountName} · synced</div> : <div className="muted">no folder mounted</div>}
        <div><span className="dot on" /> runtime live</div>
      </div>
    </aside>
  );
}
function previewOf(r): string {
  const last = r.trace[r.trace.length - 1];
  return last ? last.text.slice(0, 60) : r.task.slice(0, 60);
}
```

Add `.newtask`, `.sbh`, `.threads`, `.thread`, `.thread.sel`, `.ttl`, `.prev`, `.sbf` rules (per the approved mockup: 8-9px padding, `.thread.sel{background:var(--elev)}`, ellipsized title, faint preview).

- [ ] **Step 4: Wire in `App.tsx`** — replace the sidebar stub with `<TaskSidebar studio={studio} onNew={() => setComposerFocus()} />`. "New task" clears the composer draft and deselects (`studio.activeRunId = null` via a `studio.newDraft()` helper).

- [ ] **Step 5: Verify + commit** — `pnpm --filter @erdou/web build` passes; `pnpm vitest run` green.

```bash
git add apps/web/src/lib/runs-store.ts apps/web/src/lib/studio.ts apps/web/src/components/TaskSidebar.tsx apps/web/src/App.tsx
git commit -m "feat(web): run/thread model + IndexedDB history + task sidebar"
```

---

## Task 8: Conversation transcript + Composer

**Files:**
- Create: `apps/web/src/components/Conversation.tsx` (replaces `TraceTape` in the center; you may delete `TraceTape.tsx` or keep its row-rendering helpers)
- Create: `apps/web/src/components/Composer.tsx`
- Modify: `apps/web/src/App.tsx` (center region)

**Interfaces:**
- Consumes: `studio.activeRun`, `studio.systemLog`, `TraceLine` kinds (`system|user|thought|tool|result|done|error`), `studio.startRun`, `approvalMode` (Task 11 adds the selector value; render it now, default `"auto"`).
- Produces: center-column render — thread head + transcript + `<Composer>`.

- [ ] **Step 1: `Conversation.tsx`** — render the active run's `trace` as Codex blocks:
  - `user` → `.msg .you` bubble.
  - `thought` → `.think` (accent left-border, muted).
  - `tool` → `.tool` mono row with a status dot; `result` folds under the preceding tool call (ok=green dot, fail=red).
  - `done` → `.done` line. `error` → `.err`.
  - Empty state (no active run): center the first-run hint + example chips (from the approved mockup) — "Describe a task to begin".
  - Auto-scroll to bottom on new lines (reuse the `outRef.scrollTo` pattern from the old `TerminalPanel`).

- [ ] **Step 2: `Composer.tsx`**

```tsx
import { useState } from "react";
export function Composer({
  running, mode, onModeChange, onRun,
}: { running: boolean; mode: "auto"|"confirm"; onModeChange: (m:"auto"|"confirm")=>void; onRun: (task:string)=>void }) {
  const [text, setText] = useState("");
  function submit() { const t = text.trim(); if (!t || running) return; setText(""); onRun(t); }
  return (
    <div className="composer">
      <textarea value={text} placeholder="Describe a task…  @ files"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }} />
      <div className="composer-bar">
        <select className="mode" value={mode} onChange={(e) => onModeChange(e.target.value as "auto"|"confirm")}>
          <option value="auto">Auto</option>
          <option value="confirm">Confirm</option>
        </select>
        <button className="btn primary run" disabled={running || text.trim().length===0} onClick={submit}>
          {running ? "Working…" : "Run ⌘⏎"}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Wire center in `App.tsx`** — `<section className="center"><div className="thread-head">…</div><Conversation studio={studio}/><Composer running={studio.running} mode={mode} onModeChange={setMode} onRun={(t)=>studio.startRun(t, model)} /></section>`. Thread-head shows `studio.activeRun?.title` + status chip.

- [ ] **Step 4: Styles** — `.composer` (margin, `border:1px solid var(--border)`, `background:var(--elev)`, radius 11), textarea (transparent, no border, resize none, min-height 40px, color ink), `.composer-bar` flex, `.mode` small select, `.run` pushed right. `.msg/.you/.think/.tool/.done/.err` per mockup.

- [ ] **Step 5: Verify + commit** — build passes; visually the transcript + composer render.

```bash
git add apps/web/src/components/Conversation.tsx apps/web/src/components/Composer.tsx apps/web/src/App.tsx apps/web/src/styles.css
git commit -m "feat(web): Codex conversation transcript + composer with mode selector"
```

---

## Task 9: Per-run diff capture + DiffPanel

**Files:**
- Modify: `apps/web/src/lib/studio.ts` (snapshot at run start; collect changed paths; compute `FileChange[]` at run end; `revertChange`)
- Create: `apps/web/src/components/DiffPanel.tsx`

**Interfaces:**
- Consumes: `runtime.createSnapshot()`, `file.changed` events, `lineDiff/diffStats` (Task 5), the `Run.changes` field (Task 7).
- Produces: `studio.computeRunChanges(run, startSnapshot)`, `studio.revertChange(runId, path)`; `<DiffPanel run={run} studio={studio}/>`.

- [ ] **Step 1: Capture in `startRun`** — before running the agent: `const snap = await this.runtime.createSnapshot();` and start collecting `changedPaths = new Set<string>()` from a temporary `file.changed` subscription (add path on each event) for the duration of the run. After the agent finishes, unsubscribe and compute:

```ts
// snapshotText(snap, path): read a file's text out of the Snapshot (use the snapshot's serialized form / restore into a scratch Vfs, or read via the serialize module's helpers). Absent -> null.
const changes: FileChange[] = [];
for (const path of changedPaths) {
  const before = snapshotText(snap, path);           // string | null
  const after = this.runtime.fs.exists(path) ? this.runtime.fs.readFileText(path) : null;
  if (before === after) continue;
  changes.push({
    path,
    kind: before === null ? "create" : after === null ? "delete" : "modify",
    before: before ?? "", after: after ?? "",
  });
}
run.changes = changes.sort((a,b) => a.path < b.path ? -1 : 1);
```

Implement `snapshotText(snap, path)` using the existing snapshot serialization (`packages/runtime-browser/src/snapshot/serialize.ts`) — restore the snapshot into a throwaway `Vfs` once per run and read files from it, or read the serialized tree directly. Keep it in a small `apps/web/src/lib/snapshot-read.ts` helper if it clarifies.

- [ ] **Step 2: `revertChange(runId, path)`** — find the change; if `kind==="create"` → `runtime.rm(path,{force:true})`; else `runtime.writeFile(path, change.before)`. `notify()`.

- [ ] **Step 3: `DiffPanel.tsx`** — list `run.changes` (`path` + `+added/−removed` from `diffStats(lineDiff(before,after))`); on select, render hunks with a line-number gutter and add/del tinting (mockup styling); a **Revert** button per file. Rendering the panel for a `review` run calls `studio.markReviewed(run.id)`.

- [ ] **Step 4: Styles** — `.diff-file`, `.hunk`, `.hunk .ln/.g/.c`, `.a/.d/.h` per the approved mockup (green `rgba(63,185,80,.12)`, red `rgba(248,81,73,.12)`, mono, gutter `var(--faint)`).

- [ ] **Step 5: Verify + commit** — build + Vitest green.

```bash
git add apps/web/src/lib/studio.ts apps/web/src/lib/snapshot-read.ts apps/web/src/components/DiffPanel.tsx apps/web/src/styles.css
git commit -m "feat(web): per-run change capture + diff review pane with revert"
```

---

## Task 10: ReviewPane tabs + persistent terminal + panel restyle

**Files:**
- Create: `apps/web/src/components/ReviewPane.tsx` (tab host: Diff · Files · Terminal · Preview · Processes)
- Rewrite: `apps/web/src/components/TerminalPanel.tsx` (persistent `ShellSession`, prompt, history, no exit-0 spam)
- Modify: `apps/web/src/lib/studio.ts` (`openShell()` accessor), `FilePanel.tsx` / `PreviewPanel.tsx` / `ProcessPanel.tsx` (token restyle only)
- Modify: `apps/web/src/App.tsx` (mount `ReviewPane`)

**Interfaces:**
- Consumes: `runtime.openShell()` (Task 2), `studio.fsVersion`, `DiffPanel` (Task 9).
- Produces: `studio.shell: ShellSession` (lazily `this.runtime.openShell()`), `<ReviewPane studio={studio} run={activeRun} />`.

- [ ] **Step 1: Rewrite `TerminalPanel`** — hold `const shell = studio.shell`. State: `blocks: {cmd; stdout; stderr; code}[]`, `history: string[]`, `histIndex`. On Enter: `const r = await shell.exec(cmd)`, push a block; render:
  - prompt line: `<span class="ws">{workspace}</span> <span class="cwd">{shell.cwd}</span> <span class="p">$</span> {cmd}` where `workspace = studio.mountName ?? "erdou"` and `shell.cwd` is read **after** the command.
  - stdout (if any); stderr in red (if any); **only show `exit N` when `r.code !== 0`**.
  - ↑/↓ walk `history`. Keep the auto-scroll effect.
  Empty-state hint mirrors the current one but restyled.

- [ ] **Step 2: `studio.shell`** — add a lazy getter: `get shell(): ShellSession { return (this._shell ??= this.runtime.openShell()); }`.

- [ ] **Step 3: `ReviewPane.tsx`** — a tabbed container `["Diff","Files","Terminal","Preview","Processes"]` (Processes visually de-emphasized). Diff → `<DiffPanel>`; Files → `<FilePanel>`; Terminal → `<TerminalPanel>`; Preview → `<PreviewPanel>`; Processes → `<ProcessPanel>`. Default tab: `Diff` when the active run has changes, else `Terminal`.

- [ ] **Step 4: Restyle** `FilePanel`, `PreviewPanel`, `ProcessPanel` — swap hard-coded colors for tokens, adopt `.tabs`/`.chip`/`.btn` classes. No behavior change (FilePanel already re-reads on `studio.fsVersion`).

- [ ] **Step 5: Verify + commit** — build passes; the terminal reproduction (below) works when run.

```bash
git add apps/web/src/components/ReviewPane.tsx apps/web/src/components/TerminalPanel.tsx apps/web/src/components/FilePanel.tsx apps/web/src/components/PreviewPanel.tsx apps/web/src/components/ProcessPanel.tsx apps/web/src/lib/studio.ts apps/web/src/App.tsx
git commit -m "feat(web): review pane tabs + persistent terminal (cwd prompt, history, no exit-0 spam)"
```

---

## Task 11: Approval UI (Confirm mode) + Settings

**Files:**
- Create: `apps/web/src/components/ApprovalPrompt.tsx`
- Modify: `apps/web/src/lib/studio.ts` (wire `approve` callback when mode==="confirm"; pending-approval state on the active run)
- Modify: `apps/web/src/lib/model-config.ts` + `SettingsDialog.tsx` (persist `approvalMode`)
- Modify: `Conversation.tsx` (render a pending `ApprovalPrompt` inline)

**Interfaces:**
- Consumes: `AgentOptions.approve` (Task 3), the composer's `mode` (Task 8).
- Produces: `studio.startRun` passes `approve` only when mode is `confirm`; the callback stores a pending request + resolver on the run and `notify()`s; the UI resolves it on click.

- [ ] **Step 1: Pending-approval plumbing in `Studio`** — when starting a run in `confirm` mode, pass:

```ts
approve: (req) => new Promise<"allow"|"deny">((resolve) => {
  this.pendingApproval = { req, resolve, allowAlways: () => { this.autoAllow.add(req.tool); resolve("allow"); } };
  // if this tool was "always allowed" earlier this run, resolve immediately:
  if (this.autoAllow.has(req.tool)) { this.pendingApproval = null; resolve("allow"); return; }
  this.notify();
}),
```

Reset `this.autoAllow = new Set()` at the start of each run; clear `pendingApproval` after resolve.

- [ ] **Step 2: `ApprovalPrompt.tsx`** — render `pendingApproval.req` (the command in mono, amber-bordered per mockup) with **Allow** (`resolve("allow")`), **Always allow** (`allowAlways()`), **Deny** (`resolve("deny")`); each clears `pendingApproval` and `notify()`s.

- [ ] **Step 3: Render inline** — in `Conversation.tsx`, if `studio.pendingApproval` and this is the active run, show `<ApprovalPrompt studio={studio} />` at the bottom of the transcript.

- [ ] **Step 4: Persist mode** — extend `ModelConfig`/`model-config.ts` (or a sibling `approvalMode` key in `localStorage`) and add a control in `SettingsDialog` mirroring the composer selector; the composer and settings read/write the same value.

- [ ] **Step 5: Verify + commit** — with mode=Confirm, a task that runs a shell command pauses on the prompt; Allow proceeds, Deny surfaces "Denied by the user."

```bash
git add apps/web/src/components/ApprovalPrompt.tsx apps/web/src/components/Conversation.tsx apps/web/src/lib/studio.ts apps/web/src/lib/model-config.ts apps/web/src/components/SettingsDialog.tsx
git commit -m "feat(web): command-approval UI + Auto/Confirm toggle (default Auto)"
```

---

## Task 12: Wire mount fail-fast + live pull into the app

**Files:**
- Modify: `apps/web/src/App.tsx` (`openFolder`: only swallow `AbortError`)
- Modify: `apps/web/src/lib/studio.ts` (own `mountMtimes`; pass to load/save; `startMountWatcher()` on mount, stop on unmount)

**Interfaces:**
- Consumes: `loadFolderIntoVfs/saveVfsToFolder/rescanFolder` + `MountMtimes` (Task 4).

- [ ] **Step 1: `openFolder` fail-fast** — in `App.tsx`:

```ts
try {
  const handle = await picker({ mode: "readwrite" });
  await studio.mountFolder(handle as never);
} catch (err) {
  if (err instanceof DOMException && err.name === "AbortError") return; // real user-cancel
  studio.logSystem("error", "Failed to mount folder", err instanceof Error ? err.message : String(err));
  throw err;
}
```

- [ ] **Step 2: Studio mount state** — add `private mountMtimes: MountMtimes = new Map();` Pass it into `loadFolderIntoVfs(handle, fs, "/", this.mountMtimes)` in `mountFolder`, and into `saveVfsToFolder(fs, mount, "/", this.mountMtimes)` in `saveToFolder`.

- [ ] **Step 3: Live-pull watcher** — after a successful mount, `startMountWatcher()`:

```ts
private mountWatch?: { interval: ReturnType<typeof setInterval>; onFocus: () => void };
private startMountWatcher(): void {
  this.stopMountWatcher();
  const tick = async () => {
    if (!this.mount || document.hidden) return;
    try {
      const pulled = await rescanFolder(this.mount, this.runtime.fs, this.mountMtimes, "/");
      if (pulled.length) { this.fsVersion++; this.notify(); }   // file.changed already fired per write
    } catch (err) { this.logSystem("error", "Mount rescan failed", String(err)); }
  };
  const onFocus = () => void tick();
  window.addEventListener("focus", onFocus);
  const interval = setInterval(() => void tick(), 5000);
  this.mountWatch = { interval, onFocus };
}
private stopMountWatcher(): void {
  if (!this.mountWatch) return;
  clearInterval(this.mountWatch.interval);
  window.removeEventListener("focus", this.mountWatch.onFocus);
  this.mountWatch = undefined;
}
```

Call `startMountWatcher()` at the end of `mountFolder`; `stopMountWatcher()` in `unmount()`. Add a `logSystem(kind, text, detail?)` helper writing to `systemLog` (Task 7).

- [ ] **Step 4: Verify + commit** — mount a folder; edit a file on disk; within ~5s or on tab focus it updates in the file panel. A genuine load error shows in the system log (not swallowed).

```bash
git add apps/web/src/App.tsx apps/web/src/lib/studio.ts
git commit -m "feat(web/mount): fail-fast load errors + live disk->VFS pull (focus + 5s poll)"
```

---

## Task 13: End-to-end verification

**Files:** none (verification only). Use the `verify` / `run` skill to drive the app in headless Chromium.

- [ ] **Step 1: Full suite** — `pnpm vitest run` (all packages) → green; `pnpm lint:deps` → green (no new cross-layer edges); `pnpm --filter @erdou/web build` → success.

- [ ] **Step 2: Terminal reproduction** (the original bug) — in the app terminal:
  - `mkdir -p /1/src && touch /1/src/a.txt`
  - `cd /1` → prompt shows `/1`; `ls` shows `src`; `mv src ../src`; `cd .. && ls` shows `src` at root and **no** phantom `/`.
  - `cat /nope` → inline `ENOENT …` in red; a successful command prints **no** `exit 0`.
- [ ] **Step 3: Mount** — mount a mock/real folder: files appear immediately; edit a file on disk → appears within 5s / on focus.
- [ ] **Step 4: Run + review** — run a task (with a key configured, e.g. against the yunwu endpoint via env) → a thread appears with a live status chip; its Diff tab lists the changed files with hunks; Revert restores a file.
- [ ] **Step 5: Approval** — set Confirm; a task that runs a shell command pauses; Deny yields "Denied by the user.", Allow proceeds.
- [ ] **Step 6: Commit any verification fixups**, then hand back for review.

---

## Self-review notes (author)

- **Spec coverage:** A→T1, B→T2, C→T4+T12, D→T7, E→T5+T9, F→T3+T11, G→T6+T8+T10 (+restyles). Non-goals honored (no multi-turn, no staging UI, no multi-tab terminal, no disk-delete).
- **Type consistency:** `ShellSession`, `Run`/`FileChange`/`RunStatus`, `ApprovalRequest`/`ApprovalDecision`, `MountMtimes`, `DiffLine` are defined once (T2/T7/T3/T4/T5) and consumed by name thereafter.
- **Open detail for the implementer:** `snapshotText` (T9) reads a file out of a `Snapshot` — restore into a throwaway `Vfs` via `restoreVfs` (already in `snapshot/serialize.ts`) and read; keep it in `snapshot-read.ts`.
