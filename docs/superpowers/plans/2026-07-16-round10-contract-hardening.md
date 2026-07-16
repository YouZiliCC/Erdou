# Round 10 — Contract Hardening + apps/web Seams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden `runtime-contract` and cut apps/web's concrete-`BrowserRuntime` couplings so a second Runtime (Round 11's VM kernel) can slot in behind the same contract with zero upper-layer changes.

**Architecture:** Six contract gaps get fixed while `BrowserRuntime` is still the only implementation (spec: `docs/superpowers/specs/2026-07-16-dual-kernel-vm-runtime-design.md`, §8): `closePort` enters the contract, `exec` gets a real pid, events are officially async-deliverable, snapshots are officially workspace-scoped, `RuntimeCapabilities` grows the fields two different kernels need, and conformance tests all of it. apps/web then goes behind a `Kernel` seam (factory + shell session + sync-fs accessor), `SnapshotReader` stops newing a runtime, the Preview panel becomes event-driven, and the agent brief derives from capabilities instead of hardcoding "simulated browser OS".

**Tech Stack:** TypeScript strict, pnpm workspaces, Vitest (`vitest.workspace.ts` at repo root), dependency-cruiser layering CI. No new dependencies.

## Global Constraints

- Node ≥ 22, pnpm ≥ 11 (repo requirement).
- **Zero behavior regression on the browser kernel:** the pre-existing 249 tests must stay green after every task (`pnpm test` from the repo root; a task may *update* a test only where this plan explicitly says so).
- Layering invariant (`notice.md`): agent → contract; runtime never imports agent; language packs depend on contract only. `pnpm lint:deps` must pass after every task.
- Fail fast, no silent fallbacks (`README.md` design principles): errors are typed `ErrnoError`s or explicit throws with context.
- TDD per task: write the failing test first, watch it fail, implement, watch it pass, commit.
- All commits on branch `feat/round10-dual-kernel`.
- Run tests from the repo root: `pnpm vitest run <path>` for one file, `pnpm test` for everything, `pnpm typecheck`, `pnpm lint:deps`, `pnpm build` for gates.

---

### Task 1: Enriched `RuntimeCapabilities`

Six booleans can't describe two kernels. Add the fields the spec (§8) names: `realOs`, `interpreters`, `packageManagers`, `networkEgress`, `memoryLimitMB`, `snapshotCost`. `BrowserRuntime` reports its registered program names as `interpreters`.

**Files:**
- Modify: `packages/runtime-contract/src/capabilities.ts`
- Modify: `packages/runtime-browser/src/browser-runtime.ts` (getCapabilities + track registered names)
- Modify: `packages/conformance/src/suites/capabilities.ts`
- Modify: `packages/runtime-contract/src/contract.test.ts` (capabilities fixture)
- Modify: `packages/agent-core/src/prompt.test.ts` (capabilities fixture only — narrative tests change in Task 6)

**Interfaces:**
- Consumes: nothing new.
- Produces: `RuntimeCapabilities` with `realOs: boolean`, `interpreters: string[]`, `packageManagers: string[]`, `networkEgress: NetworkEgress`, `memoryLimitMB: number | null`, `snapshotCost: SnapshotCost`; exported types `NetworkEgress = "none" | "cors-only" | "full"` and `SnapshotCost = "cheap" | "expensive"`. Tasks 6 (prompt) and 7 (kernel test) rely on these exact names.

- [ ] **Step 1: Write the failing conformance test**

Replace `packages/conformance/src/suites/capabilities.ts` with:

```ts
import { describe, it, expect } from "vitest";
import { type MakeRuntime, booted } from "../types.js";

const BOOLEAN_KEYS = [
  "nativeProcesses",
  "virtualPorts",
  "persistentStorage",
  "network",
  "threads",
  "nativeAddons",
  "realOs",
] as const;

export function capabilitiesSuite(make: MakeRuntime): void {
  describe("capabilities", () => {
    it("reports every boolean capability flag as a boolean", async () => {
      const rt = await booted(make);
      const caps = await rt.getCapabilities();
      for (const key of BOOLEAN_KEYS) {
        expect(typeof caps[key], key).toBe("boolean");
      }
    });

    it("describes its environment: interpreters, package managers, network egress, memory, snapshot cost", async () => {
      const rt = await booted(make);
      const caps = await rt.getCapabilities();
      expect(Array.isArray(caps.interpreters)).toBe(true);
      expect(caps.interpreters.every((s) => typeof s === "string")).toBe(true);
      expect(Array.isArray(caps.packageManagers)).toBe(true);
      expect(caps.packageManagers.every((s) => typeof s === "string")).toBe(true);
      expect(["none", "cors-only", "full"]).toContain(caps.networkEgress);
      expect(caps.memoryLimitMB === null || typeof caps.memoryLimitMB === "number").toBe(true);
      expect(["cheap", "expensive"]).toContain(caps.snapshotCost);
    });
  });
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/conformance`
Expected: FAIL — TypeScript/type errors (`realOs` etc. not on `RuntimeCapabilities`) or undefined-key assertion failures.

- [ ] **Step 3: Extend the contract type**

Replace `packages/runtime-contract/src/capabilities.ts` with:

```ts
/** What outbound network reach a runtime's processes have. */
export type NetworkEgress = "none" | "cors-only" | "full";

/** Whether createSnapshot is cheap enough to call per-change or only per-session. */
export type SnapshotCost = "cheap" | "expensive";

/**
 * What a given Runtime implementation can do. Agents negotiate behavior
 * against these flags instead of type-checking the concrete Runtime.
 */
export interface RuntimeCapabilities {
  nativeProcesses: boolean;
  virtualPorts: boolean;
  persistentStorage: boolean;
  network: boolean;
  threads: boolean;
  nativeAddons: boolean;
  /** True when this runtime is a real OS (kernel + userland); false for simulated environments. */
  realOs: boolean;
  /** Command names of registered language/tool runtimes (e.g. "python", "wasi", "git"). */
  interpreters: string[];
  /** Package managers usable inside the runtime (e.g. "apk", "npm", "pip"); empty when none. */
  packageManagers: string[];
  networkEgress: NetworkEgress;
  /** Approximate memory ceiling in MB; null when not meaningfully bounded. */
  memoryLimitMB: number | null;
  snapshotCost: SnapshotCost;
}
```

- [ ] **Step 4: Implement in `BrowserRuntime`**

In `packages/runtime-browser/src/browser-runtime.ts`:

Add a field next to `registry` (line ~46):

```ts
  /** Names registered via registerProgram — reported as capabilities.interpreters. */
  private readonly programNames = new Set<string>();
```

Extend `registerProgram` (line ~127):

```ts
  registerProgram(name: string, executor: Executor): void {
    this.table.register(name, executor);
    this.programNames.add(name);
  }
```

Replace `getCapabilities` (line ~190):

```ts
  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      nativeProcesses: true,
      virtualPorts: true,
      persistentStorage: true,
      network: true,
      threads: false,
      nativeAddons: false,
      realOs: false,
      interpreters: [...this.programNames],
      packageManagers: [],
      networkEgress: "cors-only",
      memoryLimitMB: null,
      snapshotCost: "cheap",
    };
  }
```

- [ ] **Step 5: Fix the two capability fixtures**

`packages/runtime-contract/src/contract.test.ts` — extend the `getCapabilities` literal in "allows a structurally-typed Runtime and event to compile":

```ts
    const partial: Pick<Runtime, "getCapabilities"> = {
      getCapabilities: async () => ({
        nativeProcesses: true,
        virtualPorts: true,
        persistentStorage: true,
        network: true,
        threads: false,
        nativeAddons: false,
        realOs: false,
        interpreters: [],
        packageManagers: [],
        networkEgress: "cors-only",
        memoryLimitMB: null,
        snapshotCost: "cheap",
      }),
    };
```

`packages/agent-core/src/prompt.test.ts` — extend the `caps` fixture (narrative assertions stay untouched until Task 6):

```ts
const caps: RuntimeCapabilities = {
  nativeProcesses: true,
  virtualPorts: true,
  persistentStorage: true,
  network: false,
  threads: false,
  nativeAddons: false,
  realOs: false,
  interpreters: [],
  packageManagers: [],
  networkEgress: "none",
  memoryLimitMB: null,
  snapshotCost: "cheap",
};
```

- [ ] **Step 6: Run tests + typecheck to verify pass**

Run: `pnpm vitest run packages/conformance packages/runtime-contract packages/agent-core && pnpm typecheck`
Expected: PASS (everything).

- [ ] **Step 7: Full-suite gate + commit**

Run: `pnpm test && pnpm lint:deps`
Expected: 0 failures.

```bash
git add packages/runtime-contract packages/runtime-browser packages/conformance packages/agent-core
git commit -m "feat(contract): enrich RuntimeCapabilities (realOs, interpreters, packageManagers, networkEgress, memoryLimitMB, snapshotCost)"
```

---

### Task 2: `closePort` enters the contract

PreviewPanel's close-then-serve cycle depends on a concrete-only method today, and the conformance harness reaches into `rt.ports` to test closing. Promote `closePort` to the `Runtime` interface (idempotent semantics), make `BrowserRuntime`'s async, and clean up both call sites.

**Files:**
- Modify: `packages/runtime-contract/src/runtime.ts`
- Modify: `packages/runtime-browser/src/browser-runtime.ts:184-188`
- Modify: `packages/conformance/src/suites/port.ts`
- Modify: `packages/conformance/src/browser-runtime.conformance.test.ts` (drop the `rt.ports` reach-in)
- Modify: `apps/web/src/lib/studio.ts:609-614`
- Modify: `apps/web/src/components/PreviewPanel.tsx:185` (stop button call becomes `void`-ed)

**Interfaces:**
- Consumes: nothing new.
- Produces: `Runtime.closePort(port: number): Promise<void>` — idempotent; emits `port.closed` when something actually closed. `Studio.closePort(port: number): Promise<void>` (was `void`). Task 9's `doRun` awaits `studio.closePort`.

- [ ] **Step 1: Write the failing tests**

Append to the `describe("port", ...)` block in `packages/conformance/src/suites/port.ts`:

```ts
    it("closePort is contract surface and idempotent — closing an unserved port resolves as a no-op", async () => {
      const rt = await booted(make);
      await expect(rt.closePort(59998)).resolves.toBeUndefined();
    });
```

In `packages/conformance/src/browser-runtime.conformance.test.ts`, replace the reach-in block (lines 49-54):

```ts
    // `closePort` is contract surface as of round 10 — close through the
    // public Runtime API and verify the port.closed event + 502 afterwards.
    await rt.closePort(8090);
```

and change the import on line 3 to drop the now-unused type:

```ts
import { BrowserRuntime } from "@erdou/runtime-browser";
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/conformance`
Expected: FAIL — `rt.closePort` is not on the `Runtime` type / typecheck error.

- [ ] **Step 3: Add to the contract**

In `packages/runtime-contract/src/runtime.ts`, after the `dispatch` line (line 57), add:

```ts
  /** Stop serving `port`, freeing it for a future serve. Idempotent — closing
   *  a port nothing serves is a no-op. Emits `port.closed` when something was
   *  actually closed (delivery may be asynchronous — see events.ts). */
  closePort(port: number): Promise<void>;
```

- [ ] **Step 4: Make `BrowserRuntime.closePort` async**

Replace lines 184-188 of `packages/runtime-browser/src/browser-runtime.ts`:

```ts
  /** Stop serving `port` (emits `port.closed`). Idempotent — see the contract. */
  async closePort(port: number): Promise<void> {
    this.ports.close(port);
  }
```

- [ ] **Step 5: Update the two apps/web call sites**

`apps/web/src/lib/studio.ts` (lines 609-614) — replace:

```ts
  /** Stop serving a port (the Preview panel's × button). `openPorts` updates
   *  when the runtime's `port.closed` event arrives — which the contract
   *  allows to be asynchronous — via the boot-time subscription. */
  closePort(port: number): Promise<void> {
    return this.runtime.closePort(port);
  }
```

`apps/web/src/components/PreviewPanel.tsx` — the two `studio.closePort(...)` calls now return promises. Line 130 (inside `doRun`) becomes awaited; line 185 (`stop`) becomes `void`-ed:

```ts
      for (const p of openedPorts.current) await studio.closePort(p);
```

```ts
  function stop(port: number): void {
    void studio.closePort(port);
    if (selectedPort === port) setSelectedPort(null);
  }
```

(`doRun` is already `async`; the `for` loop is inside its `try`.)

- [ ] **Step 6: Run tests to verify pass**

Run: `pnpm vitest run packages/conformance apps/web && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Full-suite gate + commit**

Run: `pnpm test && pnpm lint:deps`
Expected: 0 failures.

```bash
git add packages/runtime-contract packages/runtime-browser packages/conformance apps/web
git commit -m "feat(contract): closePort joins the Runtime contract (idempotent); drop the conformance rt.ports reach-in"
```

---

### Task 3: `exec` returns a real pid

`BrowserRuntime.exec` returns `pid: 0` today, so an exec'd command is invisible to `getProcesses()` and not waitable via `wait(pid)` — while a VM kernel naturally has real pids. Pin the contract semantics ("exec handles carry a real pid") and implement via a new `ProcessTable.adopt` that allocates a table entry for an externally-driven composite process.

**Files:**
- Modify: `packages/runtime-contract/src/runtime.ts` (exec doc)
- Modify: `packages/runtime-browser/src/process/process-table.ts`
- Modify: `packages/runtime-browser/src/browser-runtime.ts:81-103`
- Modify: `packages/conformance/src/suites/process.ts`
- Test: `packages/runtime-browser/src/process/process-table.test.ts` (append adopt tests)

**Interfaces:**
- Consumes: existing `ProcessRecord`, `ExitStatus`, `Signal`, `EventBus`.
- Produces: `ProcessTable.adopt(opts: { cmd: string; args?: string[]; cwd?: string; env?: Record<string, string> }): AdoptedProcess` where `AdoptedProcess = { record: ProcessRecord; exited(code: number): void; onKill(cb: (signal: Signal) => void): void }`. `Runtime.exec(...)` handles now have `pid > 0`, appear in `getProcesses()`, and settle via `wait(pid)`.

- [ ] **Step 1: Write the failing tests**

Append to the `describe("process", ...)` block in `packages/conformance/src/suites/process.ts`:

```ts
    it("exec's handle carries a real pid — visible to getProcesses and waitable via the runtime", async () => {
      const rt = await booted(make);
      const p = await rt.exec("echo pid-check");
      expect(p.pid).toBeGreaterThan(0);
      expect((await rt.wait(p.pid)).code).toBe(0);
      expect(await p.stdout.text()).toBe("pid-check\n");
      const info = (await rt.getProcesses()).find((x) => x.pid === p.pid);
      expect(info?.state).toBe("exited");
    });
```

Append to `packages/runtime-browser/src/process/process-table.test.ts` (inside the existing top-level `describe`, using its existing `bus`/`table` setup helpers — mirror how neighboring tests construct a table):

```ts
  it("adopt allocates a real pid, tracks state, and settles via exited()", async () => {
    const { table, events } = makeTable(); // reuse this file's existing setup helper; adapt the name to what the file uses
    const adopted = table.adopt({ cmd: "sh", args: ["-c", "echo hi"] });
    expect(adopted.record.pid).toBeGreaterThan(0);
    expect(table.list().find((p) => p.pid === adopted.record.pid)?.state).toBe("running");
    adopted.exited(0);
    expect((await table.wait(adopted.record.pid)).code).toBe(0);
    expect(events).toContainEqual({ type: "process.exited", pid: adopted.record.pid, code: 0, signal: null });
  });

  it("adopt: killing the pid fires onKill and settles as killed", async () => {
    const { table } = makeTable();
    const adopted = table.adopt({ cmd: "sh" });
    let killed: string | null = null;
    adopted.onKill((sig) => (killed = sig));
    table.kill(adopted.record.pid, "SIGTERM");
    expect(killed).toBe("SIGTERM");
    expect((await table.wait(adopted.record.pid)).signal).toBe("SIGTERM");
    adopted.exited(0); // late exit after kill is a no-op
    expect(table.list().find((p) => p.pid === adopted.record.pid)?.state).toBe("killed");
  });
```

> Note: `process-table.test.ts` already constructs tables with a bus and event capture — reuse its exact local helper/pattern rather than inventing `makeTable` if the file names it differently. The assertions above are the requirement.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/runtime-browser/src/process/process-table.test.ts packages/conformance`
Expected: FAIL — `table.adopt is not a function`; conformance pid is 0.

- [ ] **Step 3: Implement `ProcessTable.adopt`**

In `packages/runtime-browser/src/process/process-table.ts`, add after the `InternalSpawnOptions` interface:

```ts
/** Controls for an externally-driven table entry (see {@link ProcessTable.adopt}). */
export interface AdoptedProcess {
  record: ProcessRecord;
  /** Settle as a normal exit with `code` (no-op if already settled). */
  exited(code: number): void;
  /** Invoked when someone kills the pid, before the record settles — the
   *  caller stops whatever is actually running (e.g. the shell pipeline). */
  onKill(cb: (signal: Signal) => void): void;
}
```

Add the method to `ProcessTable` (after `spawnPiped`):

```ts
  /**
   * Allocate a real pid for an externally-driven composite process — e.g. the
   * shell command line behind `Runtime.exec`, whose streams and lifecycle the
   * caller owns. The table tracks it for getProcesses/wait/kill; the caller
   * settles it via the returned controls. The record's own stdio streams are
   * closed placeholders (the composite's real streams live on its handle).
   */
  adopt(opts: { cmd: string; args?: string[]; cwd?: string; env?: Record<string, string> }): AdoptedProcess {
    const pid = this.nextPid++;
    const stdin = new PipeStream();
    const stdout = new PipeStream();
    const stderr = new PipeStream();
    stdin.end();
    stdout.end();
    stderr.end();

    let resolveWait!: (status: ExitStatus) => void;
    const waitPromise = new Promise<ExitStatus>((resolve) => {
      resolveWait = resolve;
    });
    let settled = false;
    let killCb: ((signal: Signal) => void) | undefined;

    const finish = (state: "exited" | "killed", code: number, signal: Signal | null): void => {
      if (settled) return;
      settled = true;
      record.state = state;
      record.exitCode = code;
      record.signal = signal;
      resolveWait({ code, signal });
      this.deps.bus.emit({ type: "process.exited", pid, code, signal });
    };

    const record: ProcessRecord = {
      pid,
      ppid: 0,
      cmd: opts.cmd,
      args: opts.args ?? [],
      cwd: opts.cwd ?? "/",
      env: opts.env ? { ...opts.env } : {},
      state: "running",
      exitCode: null,
      signal: null,
      startTimeMs: this.deps.clock(),
      stdin,
      stdout,
      stderr,
      wait: () => waitPromise,
      kill: (signal: Signal = "SIGTERM") => {
        killCb?.(signal);
        finish("killed", 128 + SIGNAL_NUMBERS[signal], signal);
      },
    };

    this.procs.set(pid, record);
    this.deps.bus.emit({ type: "process.started", pid, cmd: opts.cmd });

    return {
      record,
      exited: (code: number) => finish("exited", code, null),
      onKill: (cb) => {
        killCb = cb;
      },
    };
  }
```

- [ ] **Step 4: Wire `BrowserRuntime.exec` through it**

Replace the `exec` method body in `packages/runtime-browser/src/browser-runtime.ts` (lines 81-103):

```ts
  async exec(
    commandLine: string,
    options?: Omit<SpawnOptions, "cmd" | "args">,
  ): Promise<ProcessHandle> {
    // A fresh, isolated shell per call: cwd/env never leak between exec calls.
    const shell = new Shell({
      table: this.table,
      vfs: this.vfs,
      cwd: options?.cwd ?? "/",
      env: options?.env ? { ...options.env } : {},
    });
    const result = shell.execute(commandLine);
    // The command line gets a real pid: visible in getProcesses(), waitable
    // and killable through the runtime — the contract's exec semantics.
    const proc = this.table.adopt({
      cmd: "sh",
      args: ["-c", commandLine],
      cwd: options?.cwd ?? "/",
      env: options?.env,
    });
    proc.onKill((signal) => result.kill(signal));
    void result.wait().then((code) => proc.exited(code));
    const stdin = new PipeStream();
    stdin.end();
    return {
      pid: proc.record.pid,
      stdout: result.stdout,
      stderr: result.stderr,
      stdin,
      wait: () => proc.record.wait(),
      kill: async (signal?: Signal) => proc.record.kill(signal),
    };
  }
```

Also update the `exec` doc in `packages/runtime-contract/src/runtime.ts` (replace the bare `exec(...)` signature lines 31-34):

```ts
  /** Run a shell command line. The handle carries a REAL pid: the command
   *  appears in getProcesses() and can be awaited/killed via wait()/kill(). */
  exec(
    commandLine: string,
    options?: Omit<SpawnOptions, "cmd" | "args">,
  ): Promise<ProcessHandle>;
```

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm vitest run packages/runtime-browser packages/conformance`
Expected: PASS. (The ProcessPanel now also lists exec'd `sh -c` lines — that is intended, truthful behavior; no test asserts otherwise.)

- [ ] **Step 6: Full-suite gate + commit**

Run: `pnpm test && pnpm typecheck && pnpm lint:deps`
Expected: 0 failures.

```bash
git add packages/runtime-contract packages/runtime-browser packages/conformance
git commit -m "feat(runtime): exec allocates a real pid via ProcessTable.adopt — exec'd commands are ps-visible, waitable, killable"
```

---

### Task 4: Event/snapshot/detached semantics + `file.changed` conformance

Officially allow asynchronous event delivery, scope snapshots to the workspace, define the background-serve idiom on `detached`, give conformance an `until` polling helper, make the port suite async-tolerant, and add the missing `file.changed` conformance test (the event apps/web depends on most is currently untested).

**Files:**
- Modify: `packages/runtime-contract/src/events.ts` (doc)
- Modify: `packages/runtime-contract/src/snapshot.ts` (doc)
- Modify: `packages/runtime-contract/src/process.ts` (detached doc)
- Modify: `packages/conformance/src/types.ts` (add `until`)
- Modify: `packages/conformance/src/suites/port.ts` (async-tolerant)
- Modify: `packages/conformance/src/suites/filesystem.ts` (file.changed test)

**Interfaces:**
- Consumes: nothing new.
- Produces: `until(cond: () => boolean, timeoutMs?: number): Promise<void>` exported from `packages/conformance/src/types.ts` — later suites (Round 11's VM) rely on it.

- [ ] **Step 1: Write the failing test**

Append to the `describe("filesystem", ...)` block in `packages/conformance/src/suites/filesystem.ts` (add `until` to the existing `../types.js` import):

```ts
    it("emits file.changed (create/modify/delete) for fs mutations — delivery may be async", async () => {
      const rt = await booted(make);
      const seen: { path: string; kind: string }[] = [];
      rt.subscribe((e) => {
        if (e.type === "file.changed") seen.push({ path: e.path, kind: e.kind });
      });
      await rt.writeFile("/ev.txt", "a");
      await until(() => seen.some((e) => e.path === "/ev.txt" && e.kind === "create"));
      await rt.writeFile("/ev.txt", "b");
      await until(() => seen.some((e) => e.path === "/ev.txt" && e.kind === "modify"));
      await rt.rm("/ev.txt");
      await until(() => seen.some((e) => e.path === "/ev.txt" && e.kind === "delete"));
    });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/conformance`
Expected: FAIL — `until` is not exported.

- [ ] **Step 3: Add `until` + async-tolerant port suite + contract wording**

Append to `packages/conformance/src/types.ts`:

```ts
/** Poll until `cond` holds. The contract allows asynchronous event delivery,
 *  so suites wait for events instead of asserting same-tick arrival. */
export async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`condition not met within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}
```

In `packages/conformance/src/suites/port.ts`, make the first test async-tolerant (add `until` to the `../types.js` import; replace the synchronous `events.some` assertion):

```ts
    it("exposes a port as a URL and emits port.opened", async () => {
      const rt = await booted(make);
      const events: RuntimeEvent[] = [];
      rt.subscribe((e) => events.push(e));
      const url = await rt.exposePort(4321);
      expect(url).toContain("4321");
      await until(() => events.some((e) => e.type === "port.opened" && e.port === 4321));
    });
```

In `packages/runtime-contract/src/events.ts`, extend the module doc (replace lines 1-5):

```ts
/**
 * Generic runtime events. These carry facts about the execution environment
 * only — never agent-business meaning. The Runtime reports "process 4 exited
 * with code 1"; deciding what that means is the Agent layer's job.
 *
 * Delivery timing is NOT guaranteed to be synchronous with the operation that
 * caused an event: a runtime may deliver on a later tick (e.g. a VM-backed
 * runtime forwarding guest activity). Consumers must not assume an event has
 * landed by the time the triggering call resolves — subscribe and wait.
 */
```

In `packages/runtime-contract/src/snapshot.ts`, replace the header comment (lines 1-2):

```ts
/** A snapshot captures the WORKSPACE filesystem — the user-visible project
 *  tree the Runtime exposes through its fs methods — never machine state. A
 *  runtime whose OS lives elsewhere (e.g. a VM guest's system dirs) excludes
 *  that from snapshots; restoring affects the workspace only. File bytes are
 *  base64-encoded so the whole snapshot is JSON/structured-clone-safe. */
```

In `packages/runtime-contract/src/process.ts`, replace the `detached` doc (lines 16-17):

```ts
  /** Run in the background — the caller does not block on it. A serving
   *  program (a real server blocks forever) is spawned detached; its
   *  readiness is observed via the `port.opened` event, never by waiting
   *  for the process to exit. */
  detached?: boolean;
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm vitest run packages/conformance`
Expected: PASS (BrowserRuntime's synchronous bus satisfies the polling immediately).

- [ ] **Step 5: Full-suite gate + commit**

Run: `pnpm test && pnpm typecheck && pnpm lint:deps`
Expected: 0 failures.

```bash
git add packages/runtime-contract packages/conformance
git commit -m "feat(contract): async event delivery + workspace-scoped snapshots + detached-serve idiom; conformance until() + file.changed suite"
```

---

### Task 5: Generic `run_shell` tool description

The tool description hardcodes the browser kernel's built-ins list — wrong on any other runtime, and duplicated with the system prompt. Single source of truth: the environment brief (Task 6) carries the command list; the tool description goes generic.

**Files:**
- Modify: `packages/agent-tools/src/tools.ts:99-100`
- Test: `packages/agent-tools/src/tools.test.ts` (append one assertion)

**Interfaces:**
- Consumes/Produces: no signature changes — `createTools(): ToolDef[]` stays as-is.

- [ ] **Step 1: Write the failing test**

Append to the top-level `describe` in `packages/agent-tools/src/tools.test.ts` (match the file's existing `byName` helper usage):

```ts
  it("run_shell's description names no concrete command list — the environment brief owns that", () => {
    const desc = byName("run_shell").description;
    expect(desc).not.toMatch(/ls cat grep/);
    expect(desc).toMatch(/environment brief/i);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/agent-tools`
Expected: FAIL — description still lists `ls cat grep …`.

- [ ] **Step 3: Implement**

In `packages/agent-tools/src/tools.ts`, replace the `runShell` description (lines 99-100):

```ts
  description:
    "Run a shell command line (supports pipes, redirection, && and $VARS). Returns stdout, stderr and the exit code. The commands available in this environment are listed in your environment brief.",
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/agent-tools`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-tools
git commit -m "refactor(agent-tools): run_shell description defers the command list to the environment brief"
```

---

### Task 6: Capability-driven agent brief

`buildSystemPrompt` hardcodes "a simulated, browser-native OS … no node/npm" — flatly wrong on a real-OS runtime. Branch on `caps.realOs`; derive languages from `caps.interpreters` when the caller doesn't override; phrase network from `caps.networkEgress`; list `caps.packageManagers` when present.

**Files:**
- Modify: `packages/agent-core/src/prompt.ts` (full rewrite)
- Modify: `packages/agent-core/src/prompt.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1's `RuntimeCapabilities` fields (`realOs`, `interpreters`, `packageManagers`, `networkEgress`, `memoryLimitMB`).
- Produces: `buildSystemPrompt(env: EnvironmentInfo, caps: RuntimeCapabilities): string` — signature unchanged; `EnvironmentInfo` unchanged (its `languages` now *overrides* `caps.interpreters` instead of being the only source).

- [ ] **Step 1: Write the failing tests**

Replace the `describe("buildSystemPrompt", ...)` body in `packages/agent-core/src/prompt.test.ts` with (keep the Task-1 `caps` fixture at the top of the file):

```ts
describe("buildSystemPrompt (simulated kernel)", () => {
  it("frames the environment as a simulated browser OS and lists real constraints", () => {
    const p = buildSystemPrompt({ languages: ["python", "wasi"] }, caps);
    expect(p).toMatch(/simulated.*browser-native/i);
    expect(p).toContain("python, wasi");
    expect(p).toMatch(/wasi \/path\/to\/prog\.wasm/); // wasm note present
    expect(p).toMatch(/Node\.js and npm/); // node explicitly unavailable
    expect(p).toMatch(/apt, yum, brew/); // no package managers
    expect(p).toMatch(/offline/); // networkEgress "none" reflected
  });

  it("omits the wasm note when wasi is not registered and reflects cors-only network", () => {
    const p = buildSystemPrompt({ languages: [] }, { ...caps, networkEgress: "cors-only" });
    expect(p).toContain("none beyond the shell built-ins");
    expect(p).not.toMatch(/wasi \/path/);
    expect(p).toMatch(/network is limited/i);
  });

  it("falls back to capabilities.interpreters when the caller supplies no languages", () => {
    const p = buildSystemPrompt({}, { ...caps, interpreters: ["python", "git"] });
    expect(p).toContain("python, git");
  });
});

describe("buildSystemPrompt (real OS)", () => {
  const realCaps = {
    ...caps,
    realOs: true,
    interpreters: ["python3", "node", "gcc", "git"],
    packageManagers: ["apk", "npm", "pip"],
    networkEgress: "cors-only" as const,
    memoryLimitMB: 2048,
    snapshotCost: "cheap" as const,
  };

  it("frames a REAL Linux machine, /workspace, package managers and the speed warning", () => {
    const p = buildSystemPrompt({}, realCaps);
    expect(p).toMatch(/REAL Linux/);
    expect(p).not.toMatch(/simulated/i);
    expect(p).toContain("/workspace");
    expect(p).toContain("apk, npm, pip");
    expect(p).toMatch(/slower than native/i);
    expect(p).toMatch(/2048MB/);
  });

  it("phrases full egress and no package managers correctly", () => {
    const p = buildSystemPrompt({}, { ...realCaps, packageManagers: [], networkEgress: "full" as const });
    expect(p).toMatch(/No package manager/);
    expect(p).toMatch(/Outbound network is available/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/agent-core/src/prompt.test.ts`
Expected: FAIL — realOs branch missing; interpreters fallback missing.

- [ ] **Step 3: Rewrite `prompt.ts`**

Replace `packages/agent-core/src/prompt.ts` with:

```ts
import type { RuntimeCapabilities } from "@erdou/runtime-contract";
import type { EnvironmentInfo } from "./types.js";

const SHELL_BUILTINS =
  "ls cat grep find head tail mkdir rm cp mv touch echo pwd env which ps kill true false";

const HOW_TO_WORK = [
  "HOW TO WORK",
  "- Use the tools: file tools to read/write, run_shell for commands. Create parent dirs with make_dir before writing.",
  "- After making changes, verify them (run_shell, read_file, or list_dir).",
  "- Make reasonable decisions and proceed. When the task is fully complete, reply with a short plain-text summary and DO NOT call any tool.",
];

/**
 * Build the agent's system prompt from the runtime's real capabilities and the
 * caller's environment specifics. The brief is capability-driven: a simulated
 * kernel warns the agent away from tools that don't exist there, while a
 * real-OS runtime (caps.realOs) explains its actual toolchain, speed and
 * network reach instead. Precise framing keeps the model from wasting steps.
 */
export function buildSystemPrompt(env: EnvironmentInfo, caps: RuntimeCapabilities): string {
  return caps.realOs ? realOsPrompt(env, caps) : simulatedPrompt(env, caps);
}

/** Caller-supplied languages override the runtime's own interpreter list. */
function languagesOf(env: EnvironmentInfo, caps: RuntimeCapabilities): string[] {
  return env.languages ?? caps.interpreters;
}

function simulatedPrompt(env: EnvironmentInfo, caps: RuntimeCapabilities): string {
  const languages = languagesOf(env, caps);
  const extraCommands = env.commands ?? [];

  const canRun = languages.length > 0 ? languages.join(", ") : "none beyond the shell built-ins";
  const wasiNote = languages.includes("wasi")
    ? "\n- Run precompiled wasm32-wasi programs (Rust/C/C++/Zig/TinyGo) with: wasi /path/to/prog.wasm [args]."
    : "";

  const notAvailable: string[] = [];
  if (caps.packageManagers.length === 0) {
    notAvailable.push("Package managers (apt, yum, brew, apk) and system packages.");
  }
  notAvailable.push("Docker, systemd, sudo/root, cron, and background daemons.");
  if (!languages.includes("node")) {
    notAvailable.push("Node.js and npm — you cannot run .js/.ts files directly (no `node`).");
  }
  notAvailable.push(
    caps.networkEgress === "none"
      ? "Network access — the runtime is offline."
      : "Raw sockets — network is limited to what the host browser can fetch (CORS applies).",
  );
  if (!caps.nativeAddons) {
    notAvailable.push("Native addons / native binaries — only the above runtimes execute code.");
  }

  return [
    "You are Erdou — an autonomous coding agent operating a *simulated, browser-native* operating environment. It is NOT a real Linux machine; know your environment precisely so you don't waste steps.",
    "",
    "ENVIRONMENT",
    "- A virtual OS inside a web browser tab: an in-memory POSIX-ish filesystem, processes, and a shell. Paths are absolute and start with '/'. The filesystem starts empty.",
    `- Shell: pipes (|), redirection (> >> <), and && || ; . Built-in commands: ${SHELL_BUILTINS}. cd and export change the shell state.`,
    extraCommands.length > 0 ? `- Extra commands: ${extraCommands.join(", ")}.` : "",
    `- Languages you can run: ${canRun}.${wasiNote}`,
    caps.virtualPorts ? "- You can open virtual ports for previews." : "",
    "",
    "NOT AVAILABLE (do not attempt these — they will fail and waste steps):",
    ...notAvailable.map((n) => `- ${n}`),
    "- Interactive prompts: you cannot ask the user anything mid-task.",
    "",
    ...HOW_TO_WORK,
    env.notes ? `\nNOTES\n${env.notes}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function realOsPrompt(env: EnvironmentInfo, caps: RuntimeCapabilities): string {
  const languages = languagesOf(env, caps);
  const extraCommands = env.commands ?? [];

  const pkg =
    caps.packageManagers.length > 0
      ? `Package managers: ${caps.packageManagers.join(", ")}. Installs work but are SLOW here — prefer preinstalled tools.`
      : "No package manager is available — use the preinstalled tools.";
  const network =
    caps.networkEgress === "full"
      ? "Outbound network is available (relayed)."
      : caps.networkEgress === "cors-only"
        ? "Outbound network is limited: package-registry access (npm/pip) works through a gateway; arbitrary hosts are NOT reachable."
        : "The machine is offline — no outbound network.";
  const mem = caps.memoryLimitMB !== null ? ` RAM is capped around ${caps.memoryLimitMB}MB.` : "";

  return [
    `You are Erdou — an autonomous coding agent operating a REAL Linux machine running inside a browser tab (an emulated 32-bit x86 PC). The kernel, shell, filesystem and tools are real — but the CPU is roughly 10-100x slower than native, so prefer small targeted commands over heavy builds.${mem}`,
    "",
    "ENVIRONMENT",
    "- Your project lives in /workspace — do all project work there (it is shared live with the host page).",
    `- A real POSIX shell with the usual coreutils.${extraCommands.length > 0 ? ` Extra commands: ${extraCommands.join(", ")}.` : ""}`,
    languages.length > 0 ? `- Languages/tools installed: ${languages.join(", ")}.` : "",
    `- ${pkg}`,
    `- ${network}`,
    caps.virtualPorts ? "- Services listening on ports become previewable by the user." : "",
    "",
    ...HOW_TO_WORK,
    "- Remember the slow CPU: verify with the cheapest command that proves the change.",
    env.notes ? `\nNOTES\n${env.notes}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/agent-core`
Expected: PASS (including agent.test.ts, which uses real BrowserRuntime capabilities — now with the Task 1 fields).

- [ ] **Step 5: Full-suite gate + commit**

Run: `pnpm test && pnpm typecheck && pnpm lint:deps`
Expected: 0 failures.

```bash
git add packages/agent-core
git commit -m "feat(agent-core): capability-driven system prompt — simulated vs real-OS narratives from RuntimeCapabilities"
```

---

### Task 7: apps/web `Kernel` seam

`Studio` news `BrowserRuntime` directly and reaches concrete surface (`openShell`, sync `fs`, `registerLanguages`) in six places. Put a `Kernel` interface between the app and the concrete runtime — the single seam where Round 11's VM kernel will plug in.

**Files:**
- Create: `apps/web/src/lib/kernel.ts`
- Test: `apps/web/src/lib/kernel.test.ts`
- Modify: `apps/web/src/lib/studio.ts` (construction, shell, fs accessor, boot)
- Modify: `apps/web/src/components/PreviewPanel.tsx:27,61,103` (`studio.runtime.fs` → `studio.fs`)

**Interfaces:**
- Consumes: `BrowserRuntime`, `registerLanguages` (unchanged), contract types.
- Produces:
  - `interface RpcShellSession { readonly cwd: string; exec(commandLine: string): Promise<{ code: number; stdout: string; stderr: string }> }`
  - `interface Kernel { readonly kind: "browser"; readonly runtime: Runtime; readonly fs: FileSystemApi; openShell(): RpcShellSession }`
  - `createBrowserKernel(): Kernel`
  - `Studio.kernel: Kernel`, `Studio.fs: FileSystemApi` (getter), `Studio.runtime: Runtime` (getter, contract-typed). Tasks 9-10 and Round 11 build on these.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/kernel.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createBrowserKernel } from "./kernel.js";

describe("createBrowserKernel", () => {
  it("wires a browser runtime with languages provisioned and a working sync fs", async () => {
    const kernel = createBrowserKernel();
    expect(kernel.kind).toBe("browser");
    await kernel.runtime.boot();
    const caps = await kernel.runtime.getCapabilities();
    for (const name of ["python", "python3", "wasi", "git"]) {
      expect(caps.interpreters).toContain(name);
    }
    kernel.fs.writeFile("/k.txt", "via-kernel");
    expect(new TextDecoder().decode(await kernel.runtime.readFile("/k.txt"))).toBe("via-kernel");
  });

  it("opens a persistent shell session (cwd survives commands)", async () => {
    const kernel = createBrowserKernel();
    await kernel.runtime.boot();
    const shell = kernel.openShell();
    await kernel.runtime.mkdir("/proj", { recursive: true });
    await shell.exec("cd /proj");
    expect(shell.cwd).toBe("/proj");
    const r = await shell.exec("pwd");
    expect(r.stdout.trim()).toBe("/proj");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/web/src/lib/kernel.test.ts`
Expected: FAIL — `./kernel.js` does not exist.

- [ ] **Step 3: Create `kernel.ts`**

Create `apps/web/src/lib/kernel.ts`:

```ts
import { BrowserRuntime } from "@erdou/runtime-browser";
import type { FileSystemApi, Runtime } from "@erdou/runtime-contract";
import { registerLanguages } from "./languages.js";

/** Request/response shell session — the browser kernel's shape. Round 11's VM
 *  kernel adds a PTY-stream shape beside this one; consumers pick by kernel. */
export interface RpcShellSession {
  /** Live working directory — reads back after every command (for the prompt). */
  readonly cwd: string;
  exec(commandLine: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

/**
 * Everything the app needs from a runtime beyond the pure contract — the ONE
 * seam where a second kernel (Round 11's VM) slots in without touching Studio:
 * construction+provisioning, the persistent shell, and the host-side
 * synchronous workspace view (both kernels keep workspace truth host-side).
 */
export interface Kernel {
  readonly kind: "browser";
  readonly runtime: Runtime;
  readonly fs: FileSystemApi;
  openShell(): RpcShellSession;
}

export function createBrowserKernel(): Kernel {
  const runtime = new BrowserRuntime();
  registerLanguages(runtime);
  return {
    kind: "browser",
    runtime,
    fs: runtime.fs,
    openShell: () => runtime.openShell(),
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run apps/web/src/lib/kernel.test.ts`
Expected: PASS.

- [ ] **Step 5: Route `Studio` through the kernel**

In `apps/web/src/lib/studio.ts`:

1. Line 1 import — drop `BrowserRuntime` and `ShellSession`:

```ts
import { IndexedDbSnapshotStore } from "@erdou/runtime-browser";
```

2. Line 6 — extend the contract type import:

```ts
import type { RuntimeEvent, ProcessInfo, Snapshot, Runtime, FileSystemApi } from "@erdou/runtime-contract";
```

3. Line 7 — `registerLanguages` moves out of studio (kernel provisions); keep the agent constants:

```ts
import { AGENT_LANGUAGES, AGENT_COMMANDS } from "./languages.js";
```

4. Add below it:

```ts
import { createBrowserKernel, type Kernel, type RpcShellSession } from "./kernel.js";
```

5. Replace `readonly runtime = new BrowserRuntime();` (line 81) and the `_shell` field type (line 87), and add accessors:

```ts
  /** The active kernel — the seam a second runtime implementation plugs into. */
  readonly kernel: Kernel = createBrowserKernel();
  private _shell?: RpcShellSession;

  /** The contract-typed runtime of the active kernel. */
  get runtime(): Runtime {
    return this.kernel.runtime;
  }

  /** Host-side synchronous view of the workspace (see Kernel.fs). */
  get fs(): FileSystemApi {
    return this.kernel.fs;
  }
```

(Delete the old `private _shell?: ShellSession;` line; keep `gateway`/`store`/the rest untouched.)

6. The `shell` getter (line ~143):

```ts
  /** A persistent shell session (cwd/env survive across commands), for the terminal. */
  get shell(): RpcShellSession {
    return (this._shell ??= this.kernel.openShell());
  }
```

7. In `boot()` (line ~161): delete the `registerLanguages(this.runtime);` line (the kernel factory already provisioned).

8. Replace every `this.runtime.fs` with `this.fs` — four sites: `mountFolder` (line ~212), `startMountWatcher`'s `rescanFolder` call (line ~306), `saveToFolder` (line ~340), and `computeRunChanges`'s `after` closure (line ~509).

- [ ] **Step 6: Update PreviewPanel's fs access**

In `apps/web/src/components/PreviewPanel.tsx`, replace all three `studio.runtime.fs` with `studio.fs` (lines 27, 61, 103):

```ts
  const [cmd, setCmd] = useState(() => detectRunCommand(studio.fs) ?? "");
```

```ts
  const bundleEntry = hasBundleEntry(studio.fs);
```

```ts
      const result = await bundleProject(studio.fs);
```

- [ ] **Step 7: Run tests + typecheck to verify pass**

Run: `pnpm vitest run apps/web && pnpm typecheck`
Expected: PASS — Studio tests (mount/approval/config/truncate) behave identically; languages now register at construction instead of boot, which they never observed.

- [ ] **Step 8: Full-suite gate + commit**

Run: `pnpm test && pnpm lint:deps`
Expected: 0 failures.

```bash
git add apps/web
git commit -m "refactor(web): Kernel seam — Studio constructs runtime via createBrowserKernel; contract-typed runtime + fs accessors"
```

---

### Task 8: `SnapshotReader` reads the snapshot tree directly

`SnapshotReader.open` news a throwaway `BrowserRuntime` just to read files out of a `Snapshot` — a concrete-class dependency and a full-tree restore per diff. A `Snapshot` is a plain JSON tree; walk it.

**Files:**
- Modify: `apps/web/src/lib/snapshot-read.ts`
- Modify: `apps/web/src/lib/snapshot-read.test.ts` (add reader tests)
- Modify: `apps/web/src/lib/studio.ts:507` (drop the `await`)

**Interfaces:**
- Consumes: `Snapshot`, `SnapshotFsNode` from the contract.
- Produces: `SnapshotReader.open(snapshot: Snapshot): SnapshotReader` (now **synchronous**) with `read(path: string): string | null` unchanged. `buildFileChanges` untouched.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/lib/snapshot-read.test.ts`:

```ts
import { SnapshotReader } from "./snapshot-read.js";
import type { Snapshot } from "@erdou/runtime-contract";

describe("SnapshotReader", () => {
  const b64 = (s: string): string => btoa(s);
  const snap: Snapshot = {
    version: 1,
    createdAtMs: 0,
    fs: {
      type: "directory",
      mode: 0o755,
      children: {
        "a.txt": { type: "file", mode: 0o644, data: b64("hello") },
        sub: {
          type: "directory",
          mode: 0o755,
          children: { "b.txt": { type: "file", mode: 0o644, data: b64("nested") } },
        },
        link: { type: "symlink", mode: 0o777, target: "/a.txt" },
      },
    },
  };

  it("reads files at any depth straight from the tree, without a runtime", () => {
    const reader = SnapshotReader.open(snap);
    expect(reader.read("/a.txt")).toBe("hello");
    expect(reader.read("/sub/b.txt")).toBe("nested");
  });

  it("returns null for missing paths, directories, and symlinks", () => {
    const reader = SnapshotReader.open(snap);
    expect(reader.read("/missing")).toBeNull();
    expect(reader.read("/sub")).toBeNull();
    expect(reader.read("/link")).toBeNull();
  });
});
```

(Merge the imports with the file's existing `import { buildFileChanges } from "./snapshot-read.js";` line.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/web/src/lib/snapshot-read.test.ts`
Expected: FAIL — `SnapshotReader.open` returns a Promise today (`reader.read` is not a function on it).

- [ ] **Step 3: Rewrite the reader**

In `apps/web/src/lib/snapshot-read.ts`, delete the `BrowserRuntime` import and replace the class:

```ts
import type { Snapshot, SnapshotFsNode } from "@erdou/runtime-contract";
import type { FileChange } from "./studio.js";

/** Reads a path's text at some point in time. Absent file -> null. */
export type ReadText = (path: string) => string | null;

const b64ToBytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/**
 * Reads file contents straight out of a {@link Snapshot}'s JSON tree — no
 * runtime, no restore. Symlinks are not followed (diffs read workspace text
 * files by their own paths).
 */
export class SnapshotReader {
  private constructor(private readonly root: SnapshotFsNode) {}

  static open(snapshot: Snapshot): SnapshotReader {
    return new SnapshotReader(snapshot.fs);
  }

  read(path: string): string | null {
    let node: SnapshotFsNode | undefined = this.root;
    for (const part of path.split("/").filter(Boolean)) {
      if (!node || node.type !== "directory") return null;
      node = node.children[part];
    }
    if (!node || node.type !== "file") return null;
    return new TextDecoder().decode(b64ToBytes(node.data));
  }
}
```

(`buildFileChanges` below it stays exactly as-is.)

- [ ] **Step 4: Update the call site**

In `apps/web/src/lib/studio.ts` `computeRunChanges` (line ~507):

```ts
    const before = SnapshotReader.open(startSnap);
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run apps/web && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Full-suite gate + commit**

Run: `pnpm test && pnpm lint:deps`
Expected: 0 failures.

```bash
git add apps/web
git commit -m "refactor(web): SnapshotReader walks the snapshot tree directly — no throwaway BrowserRuntime"
```

---

### Task 9: Event-driven serve runs in the Preview panel

PreviewPanel assumes `port.opened` fires synchronously during `shell.exec` and that serving commands exit (both are browser-kernel accidents — a real server blocks forever). Add a `runServeCommand` helper that resolves on *either* a `port.opened` event *or* command exit, capturing opened ports from the subscription itself; rewire the panel through it.

**Files:**
- Create: `apps/web/src/lib/run-serve.ts`
- Test: `apps/web/src/lib/run-serve.test.ts`
- Modify: `apps/web/src/components/PreviewPanel.tsx` (runCommand / bundleAndRun / doRun / lastAction)

**Interfaces:**
- Consumes: `RpcShellSession` (Task 7), `Runtime.subscribe` (contract), `Studio.closePort` (Task 2).
- Produces: `runServeCommand(runtime: Pick<Runtime, "subscribe">, shell: RpcShellSession, commandLine: string): Promise<RunServeResult>` with `RunServeResult = { ok: boolean; openedPorts: number[]; code?: number; stdout?: string; stderr?: string }`. PreviewPanel's `lastAction` becomes `() => Promise<{ ok: boolean; opened: number[] }>`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/run-serve.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { RuntimeEvent } from "@erdou/runtime-contract";
import { runServeCommand } from "./run-serve.js";

/** Minimal fake: manual event emission + a scripted shell. */
function fake(execImpl: (emit: (e: RuntimeEvent) => void) => Promise<{ code: number; stdout: string; stderr: string }>) {
  const listeners = new Set<(e: RuntimeEvent) => void>();
  const emit = (e: RuntimeEvent): void => listeners.forEach((l) => l(e));
  const runtime = {
    subscribe(l: (e: RuntimeEvent) => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  const shell = { cwd: "/", exec: () => execImpl(emit) };
  return { runtime, shell, listeners };
}

const opened = (port: number): RuntimeEvent => ({ type: "port.opened", port, url: `/__port__/${port}/` });

describe("runServeCommand", () => {
  it("resolves ok on port.opened even if the command never exits (a real server blocks)", async () => {
    const { runtime, shell } = fake((emit) => {
      emit(opened(8080));
      return new Promise(() => {}); // never exits
    });
    const r = await runServeCommand(runtime, shell, "python app.py");
    expect(r.ok).toBe(true);
    expect(r.openedPorts).toEqual([8080]);
  });

  it("captures a port delivered asynchronously AFTER a successful exit", async () => {
    const { runtime, shell } = fake((emit) => {
      setTimeout(() => emit(opened(9090)), 0); // async delivery, per the contract
      return Promise.resolve({ code: 0, stdout: "served\n", stderr: "" });
    });
    const r = await runServeCommand(runtime, shell, "erdou serve .");
    expect(r.ok).toBe(true);
    expect(r.openedPorts).toEqual([9090]);
    expect(r.stdout).toBe("served\n");
  });

  it("reports a failing command's code and stderr", async () => {
    const { runtime, shell } = fake(() => Promise.resolve({ code: 2, stdout: "", stderr: "boom" }));
    const r = await runServeCommand(runtime, shell, "false");
    expect(r).toMatchObject({ ok: false, code: 2, stderr: "boom", openedPorts: [] });
  });

  it("reports a rejecting exec as ok:false with the message", async () => {
    const { runtime, shell } = fake(() => Promise.reject(new Error("no such command")));
    const r = await runServeCommand(runtime, shell, "nope");
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("no such command");
  });

  it("unsubscribes once settled by exit", async () => {
    const { runtime, shell, listeners } = fake(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }));
    await runServeCommand(runtime, shell, "echo hi");
    expect(listeners.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/web/src/lib/run-serve.test.ts`
Expected: FAIL — `./run-serve.js` does not exist.

- [ ] **Step 3: Implement the helper**

Create `apps/web/src/lib/run-serve.ts`:

```ts
import type { Runtime, RuntimeEvent } from "@erdou/runtime-contract";
import type { RpcShellSession } from "./kernel.js";

export interface RunServeResult {
  ok: boolean;
  /** Ports that opened during this run, in open order (captured from the
   *  event subscription itself — never by diffing a ports list afterwards). */
  openedPorts: number[];
  /** Present when the command exited. */
  code?: number;
  stdout?: string;
  stderr?: string;
}

/**
 * Run a (possibly serving) command without assuming it exits OR that
 * `port.opened` lands in the same tick (the contract allows async delivery).
 *
 * Resolution rules:
 *  - The command exits → ok iff exit code 0, with code/stdout/stderr. On a
 *    clean exit with no port seen yet, one macrotask of grace lets an
 *    async-delivered `port.opened` land first.
 *  - A `port.opened` arrives while the command is still running → one
 *    macrotask of grace for a fast exit (the simulated kernel's serve returns
 *    immediately — its stdout should make the result); if the command still
 *    hasn't exited by then it is a real blocking server, and the run settles
 *    as ok with the port (we deliberately never wait for a server's exit —
 *    note: its event subscription then stays live until the process ends,
 *    which the browser kernel's registration-model serve always does; a VM
 *    kernel revisits this in Round 11).
 * Never rejects — failures come back as `ok: false`.
 */
export function runServeCommand(
  runtime: Pick<Runtime, "subscribe">,
  shell: RpcShellSession,
  commandLine: string,
): Promise<RunServeResult> {
  return new Promise((resolve) => {
    const openedPorts: number[] = [];
    let settled = false;
    let exited = false;
    const unsub = runtime.subscribe((e: RuntimeEvent) => {
      if (e.type !== "port.opened") return;
      openedPorts.push(e.port);
      if (settled || exited) return;
      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({ ok: true, openedPorts });
        }
      }, 0);
    });
    shell.exec(commandLine).then(
      async (r) => {
        exited = true;
        if (r.code === 0 && openedPorts.length === 0) {
          // Let an async-delivered port.opened land before concluding "no port".
          await new Promise((tick) => setTimeout(tick, 0));
        }
        unsub();
        if (settled) return;
        settled = true;
        resolve({ ok: r.code === 0, openedPorts, code: r.code, stdout: r.stdout, stderr: r.stderr });
      },
      (err: unknown) => {
        exited = true;
        unsub();
        if (settled) return;
        settled = true;
        resolve({
          ok: false,
          openedPorts,
          code: -1,
          stderr: err instanceof Error ? err.message : String(err),
        });
      },
    );
  });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run apps/web/src/lib/run-serve.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewire PreviewPanel**

In `apps/web/src/components/PreviewPanel.tsx`:

1. Add the import:

```ts
import { runServeCommand } from "../lib/run-serve.js";
```

2. Replace `runCommand` (lines 64-92) — it now returns the ports it opened, so `doRun` never diffs `studio.openPorts`:

```ts
  /** Runs `commandLine` via the event-driven helper. Returns success + the
   *  ports the run opened (captured from events — a serving command may still
   *  be running when this resolves; that is the contract's serve idiom). */
  async function runCommand(commandLine: string): Promise<{ ok: boolean; opened: number[] }> {
    if (!commandLine || running) return { ok: false, opened: [] };
    setRunning(true);
    try {
      const result = await runServeCommand(studio.runtime, studio.shell, commandLine);
      if (!result.ok) {
        setErrors([result.stderr?.trim() || result.stdout?.trim() || `exited with code ${result.code}`]);
        setOutput(null);
      } else {
        setErrors([]);
        setOutput(result.stdout?.trim() || null);
        const first = result.openedPorts[0];
        if (first !== undefined) setSelectedPort(first);
        else if (selectedPort === null) setSelectedPort(studio.openPorts[0]?.port ?? null);
      }
      ranOnce.current = true;
      return { ok: result.ok, opened: [...result.openedPorts] };
    } finally {
      setRunning(false);
    }
  }
```

3. `bundleAndRun` (lines 94-117): change its signature/returns to the same shape — `Promise<{ ok: boolean; opened: number[] }>`; the two `return false` early-exits become `return { ok: false, opened: [] }`, and the final `return await runCommand(commandLine);` stays (it already returns the new shape). The `catch` branch returns `{ ok: false, opened: [] }` after `setErrors`.

4. `lastAction` ref type (line 44):

```ts
  const lastAction = useRef<null | (() => Promise<{ ok: boolean; opened: number[] }>)>(null);
```

5. Replace `doRun` (lines 127-143) — awaited closes (Task 2), no port diffing:

```ts
  async function doRun(action: () => Promise<{ ok: boolean; opened: number[] }>): Promise<void> {
    busy.current = true;
    try {
      for (const p of openedPorts.current) await studio.closePort(p);
      openedPorts.current = [];
      const result = await action();
      openedPorts.current = result.opened;
      // By now every VFS write the action itself made is reflected (runCommand
      // resolved), so this baseline still tells own-writes from later edits.
      lastRunFsVersion.current = studio.fsVersion;
      if (result.ok) setNonce((n) => n + 1);
    } finally {
      busy.current = false;
    }
  }
```

(Leave the module-doc comment block, `handleRun`, `handleBundleAndRun`, the live effect, and everything else untouched — their call shapes still match.)

- [ ] **Step 6: Run tests + typecheck to verify pass**

Run: `pnpm vitest run apps/web && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Full-suite gate + commit**

Run: `pnpm test && pnpm lint:deps`
Expected: 0 failures.

```bash
git add apps/web
git commit -m "feat(web): event-driven serve runs — PreviewPanel no longer assumes sync port.opened or exiting servers"
```

---

### Task 10: Diff capture tolerates async event delivery

`runAgentTurn` computes the turn's changes right after `agent.run` resolves; a runtime that delivers `file.changed` a tick late (the contract now allows it) would lose those paths — diffs silently empty. Let events settle first.

**Files:**
- Modify: `apps/web/src/lib/studio.ts` (settle before `computeRunChanges`)
- Test: `apps/web/src/lib/studio-settle.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: `eventsSettled(): Promise<void>` exported from `studio.ts` (one macrotask).

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/studio-settle.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { eventsSettled } from "./studio.js";

describe("eventsSettled", () => {
  it("lets an event delivered on a later macrotask land before reads", async () => {
    const changed = new Set<string>();
    // The async-runtime case: the mutation resolved, but its file.changed is
    // still in flight on the macrotask queue.
    setTimeout(() => changed.add("/late.txt"), 0);
    expect(changed.has("/late.txt")).toBe(false);
    await eventsSettled();
    expect(changed.has("/late.txt")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/web/src/lib/studio-settle.test.ts`
Expected: FAIL — `eventsSettled` is not exported.

- [ ] **Step 3: Implement**

In `apps/web/src/lib/studio.ts`, add near `runTitle` (module level, exported):

```ts
/** One macrotask — lets asynchronously-delivered runtime events land before a
 *  turn's changes are read (the contract allows delivery after the triggering
 *  call resolves; see runtime-contract/src/events.ts). */
export const eventsSettled = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
```

In `runAgentTurn`, insert the settle between `agent.run` and the diff (line ~481):

```ts
      const result = await agent.run(task, run.messages);
      await eventsSettled(); // async-delivered file.changed events land before we read `changed`
      // Compute the diff BEFORE deciding status, so "review" actually triggers
      // when the run changed files (the guard was a no-op while changes was []).
      const turnChanges = await this.computeRunChanges(startSnap, changed);
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run apps/web && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Full-suite gate + commit**

Run: `pnpm test && pnpm lint:deps`
Expected: 0 failures.

```bash
git add apps/web
git commit -m "fix(web): let async-delivered file.changed events settle before computing a turn's diff"
```

---

### Task 11: Final verification gates

Everything green, buildable, layered, and the round's acceptance criteria confirmed.

**Files:** none (verification only; fix-forward anything found).

- [ ] **Step 1: Full test suite**

Run: `pnpm test`
Expected: **0 failures**; total count ≥ 249 + the ~14 tests this plan added (≈263). If anything fails, fix it within the task that introduced it before proceeding.

- [ ] **Step 2: Types, layering, build, conformance**

Run: `pnpm typecheck && pnpm lint:deps && pnpm build && pnpm conformance`
Expected: all clean. `lint:deps` proves the layering invariant survived (kernel.ts lives in apps/web, which may import runtime-browser; nothing below the contract imports upward).

- [ ] **Step 3: Commit any stragglers and mark the round**

```bash
git status --short   # expect: clean (or only this plan's checkbox updates)
git add -A && git commit -m "chore(round10): contract hardening + apps/web seams complete — gates green" --allow-empty
```

---

## Self-Review (performed while writing)

- **Spec §8 coverage:** closePort → Task 2; background-serve idiom (`detached` doc + event-driven PreviewPanel) → Tasks 4+9; workspace-scoped snapshots → Task 4; async events wording + the two same-tick reliance spots → Tasks 4, 9 (doRun), 10 (diff capture); exec pid semantics → Task 3; enriched capabilities → Task 1; `file.changed` conformance → Task 4; runtime factory → Task 7; `openShell` session interface → Task 7 (`RpcShellSession`; the PTY shape lands with its only consumer in Round 11); per-runtime provisioning → Task 7 (kernel factory calls `registerLanguages`); sync-fs seam → Task 7 (`Studio.fs` getter over `Kernel.fs`); `SnapshotReader` → Task 8; capability-driven brief → Task 6; `run_shell` builtins list → Task 5. **Not in this round (per spec):** conformance factory pooling/cloning (listed under spec §11 testing for the VM — Round 11), any VM code, tier-selection UI.
- **Placeholders:** none — every step carries the code or the exact edit. The one intentionally-loose spot is Task 3 Step 1's note to reuse `process-table.test.ts`'s existing setup helper by its real name (the assertions are fully specified).
- **Type consistency:** `RunServeResult.openedPorts` (helper) vs `{ ok, opened }` (panel-internal shape) — converted at the single boundary in `runCommand` Step 5.2; `RpcShellSession` defined once in Task 7 and consumed in Task 9; `NetworkEgress`/`SnapshotCost` defined in Task 1 and consumed in Tasks 4 (none), 6 (both); `Studio.closePort` returns `Promise<void>` from Task 2 onward and `doRun` awaits it in Task 9.
