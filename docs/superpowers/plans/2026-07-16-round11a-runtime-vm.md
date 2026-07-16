# Round 11a — `@erdou/runtime-vm` MVP (v86 + Alpine, headless) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@erdou/runtime-vm` — a second Runtime that runs a real 32-bit Alpine Linux guest in a v86 WebAssembly emulator — to the point where the shared conformance suite passes against it in Node, with the Erdou VFS backing the guest's `/workspace` over 9p and a `guestd` daemon running real `exec`/`spawn`/`kill`/`ps` inside the guest.

**Architecture:** One v86 9p export holds two subtrees: `/sys-root` (the baked Alpine userland) and `/workspace` (the agent's project files = the contract `/`). The guest bind-mounts `bin`/`lib`/`usr` from `sys-root` into `workspace` and runs a resident `guestd.py` **inside `chroot /workspace`**, so a user command's filesystem root IS the contract root. `VmRuntime` wraps `emulator.fs9p`'s mutating methods to observe guest writes (→ `file.changed`), drives `guestd` over a `virtio-console` channel for processes, and boots from a self-contained saved machine state (`state.zst`) produced once by a bake script. The whole runtime satisfies the same `@erdou/runtime-contract` as `BrowserRuntime`; nothing above the contract changes.

**Tech Stack:** TypeScript strict, pnpm workspaces, Vitest. New runtime dependency: `v86` (npm, BSD-2). Guest daemon in Python 3 (baked into the Alpine image). Node-only for this round — the browser wiring is Round 11b.

## Global Constraints

- Node ≥ 22, pnpm ≥ 11.
- **Layering (`notice.md`, enforced by `pnpm lint:deps`):** `@erdou/runtime-vm` is a Runtime **implementation** — it may import `@erdou/runtime-contract` ONLY (like `runtime-browser`). Its tests may import `@erdou/conformance` and `@erdou/runtime-browser`. It must NEVER import model-gateway or any agent layer.
- **Zero regression:** the pre-existing suite (271 tests at branch base) stays green; the default `pnpm test` must remain hermetic and fast — the VM integration suite is **gated** (skipped unless its baked asset is present AND `ERDOU_VM_E2E=1`), exactly like `packages/agent-core/src/live.e2e.test.ts` gates on `ERDOU_LIVE_KEY`.
- **Repo stays clean:** the baked machine state and downloaded kernel/BIOS are **gitignored build artifacts** produced by scripts — never committed. Only a committed `assets/manifest.json` (pinned versions + sha256) and the scripts describe how to regenerate them.
- Fail fast, no silent fallbacks: a missing/renamed v86 symbol, a guestd protocol error, or a boot failure throws a typed, contextual error. FS errors are `ErrnoError`s.
- TDD per task: write the failing test first, watch it fail, implement, watch it pass, commit. Pieces that touch a live v86 guest (guestd.py, v86-host boot, the full conformance run) are **verified by the gated integration suite**, not by pure unit tests — each such task states exactly which gated check proves it.
- All commits on branch `feat/round11-runtime-vm`.
- Run from repo root: `pnpm vitest run <path>` (one file), `pnpm test` (hermetic suite), `pnpm typecheck`, `pnpm lint:deps`, `pnpm build`. The gated VM suite: `ERDOU_VM_E2E=1 pnpm vitest run packages/runtime-vm` (after `pnpm --filter @erdou/runtime-vm bake`).

## Verified foundation (do not re-litigate — three hands-on spikes proved this)

Every non-trivial integration fact below was demonstrated by a Node script that actually booted v86 0.5.424. The task code is a faithful port of that verified code.

1. **9p bridge (Spike A):** `emulator.fs9p` is a public `FS` instance whose method names survive minification. Wrapping 7 mutating methods (`CreateFile`, `CreateDirectory`, `CreateSymlink`, `Write`, `ChangeSize`, `Unlink`, `Rename`) observes **every** guest mutation post-completion (4–7 ms, no `sync` needed — the guest mounts `cache=none`). Page-side ops mutate the same store (`CreateBinaryFile`/`ChangeSize`+`Write`/`Unlink`) under a suppression flag. Files aren't back-linked to parents (`GetFullPath` is dir-only), so the bridge maintains its own `inode idx → path` map, **rebuilt after `restore_state`** (which swaps inodes wholesale). Guest writes arrive one event per ≤4 KB chunk → must be coalesced before emitting `file.changed`. `emulator.create_file()` is unusable for populating a rootfs (mode hardcoded 0666, no dirs/symlinks) — populate via `fs9p` directly + set `inodes[id].mode`.
2. **Alpine + channel + snapshot (Spike B):** pure-Node image pipeline (Alpine 3.24.1 x86 minirootfs 3.4 MB + 17 resolved apks → `python3 -c 'print(6*7)'` → 42). The buildroot kernel **ignores `root=`/`init=`** (baked initramfs) — the preloaded 9p auto-mounts at `/mnt` via fstab, and we `chroot` into it. Guestd channel = **virtio-console `/dev/hvc0`**: `new V86({virtio_console:true})`, host→guest `emulator.bus.send("virtio-console0-input-bytes", u8)`, guest→host `emulator.add_listener("virtio-console0-output-bytes", cb)` — 256-byte binary-safe, ~1 ms. Guest side MUST `os.open` the fd and `tty.setraw` while holding it. **The entire 9p FS rides inside `save_state`** → `state.bin` is self-contained (restore into `filesystem:{}` works; no re-preload). Save ~150 ms / restore-to-usable ~720 ms.
3. **Clean workspace/system split (Spike C):** one 9p export, `/sys-root` (Alpine 37 MB) + `/workspace` (user). Guest bind-mounts `bin`/`lib`/`usr` from sys-root into workspace, mounts proc/dev/tmpfs, remounts the binds read-only (after a build-time pycache warmup — else python writes `__pycache__` into sys-root), and runs `guestd` **inside `chroot /workspace`**. Then `echo data > /out.txt` lands at fs9p `workspace/out.txt` (verified NOT in sys-root), `python3`/pipes/`||`/`ps` all work, and `ls /` shows the pure workspace. The bridge filters events to the `workspace/` prefix → contract paths. Snapshot enumerates only the `/workspace` subtree via `inodes[id].direntries` (a `Map(name→idx)`; skip `.`/`..`; classify by `mode & 0o170000`) → 16 bytes vs sys-root's 37 MB. Guestd survives save/restore with the same PID. Minimal system set: `bin`, `lib`, `usr` (no `/etc`/`/sbin`/`lib32`).

Verified reference scripts (this session's scratchpad — the code below is ported from them): `r11-spikes/a/adapter.mjs`, `r11-spikes/b/{resolve-deps,install-pkgs}.mjs`, `r11-spikes/c/{setup-split,guestd-poc.py,q4-guestd}.mjs`.

## File Structure

```
packages/runtime-vm/
  package.json              # full Runtime; deps: runtime-contract + v86; devDeps: conformance, runtime-browser
  tsconfig.json             # extends ../../tsconfig.base.json
  vitest.config.ts          # environment node; testTimeout 120000 (VM boots are seconds)
  README.md                 # what it is, how to bake + run the gated e2e
  assets/
    .gitignore              # ignore everything except .gitignore and manifest.json
    manifest.json           # committed: pinned kernel/bios URLs + sha256 + alpine version + guestd hash
  scripts/
    download-assets.mjs     # fetch pinned kernel/seabios/vgabios into assets/ (verify sha256)
    bake-image.mjs          # Alpine pipeline → boot → guest setup → resident guestd → save assets/state.zst
    lib/
      apk.mjs               # APKINDEX dep resolution + .apk download/extract (ported from Spike B)
      preload.mjs           # setupSplitFs + SKELETON_DIRS + guest-setup command strings (ported from Spike C)
  src/
    guest/guestd.py         # the guest daemon (framed protocol over /dev/hvc0), baked into the image
    guestd-protocol.ts      # pure frame + message codec (TDD)
    guestd-client.ts        # drives the protocol over a console channel (TDD w/ fake channel)
    fs-bridge.ts            # wraps fs9p; path index; write coalescing; workspace filter → file.changed; async fs (TDD w/ fake fs9p)
    workspace-snapshot.ts   # enumerate/restore the /workspace subtree ↔ contract Snapshot (TDD)
    port-registry.ts        # serve/dispatch/close registry (own copy; TDD)
    capabilities.ts         # the VM's RuntimeCapabilities
    v86-host.ts             # typed v86 wrapper + symbol guard + console bus + save/restore (gated smoke)
    vm-runtime.ts           # VmRuntime implements Runtime (composition)
    index.ts
    guestd-protocol.test.ts
    guestd-client.test.ts
    fs-bridge.test.ts
    workspace-snapshot.test.ts
    port-registry.test.ts
    capabilities.test.ts
    v86-host.symbols.test.ts          # hermetic-ish: constructs an empty V86, asserts the wrapped symbols exist
    vm-runtime.conformance.test.ts    # GATED (asset + ERDOU_VM_E2E): runConformance + VM-specific checks
```

---

### Task 1: Contract-suite seed items (from Round 10 review)

Two shared conformance additions the VM must also satisfy: a stricter delivery-bound test (the Round 10 review noted `until()` masks a runtime that violates the one-macrotask bound) and an exec-kill test (kill through the pure contract was untested). Both pass on `BrowserRuntime` unchanged.

**Files:**
- Modify: `packages/conformance/src/suites/filesystem.ts`
- Modify: `packages/conformance/src/suites/process.ts`
- Modify: `packages/conformance/src/types.ts` (teardown registry)
- Modify: `packages/conformance/src/index.ts` (afterEach shutdown)

**Interfaces:**
- Consumes: `until` from `../types.js` (added in Round 10).
- Produces: a per-test teardown seam — `booted()` registers each runtime and `runConformance` shuts them down in `afterEach`. Harmless for `BrowserRuntime` (cheap `shutdown()`), **essential** for `VmRuntime` (each `booted()` starts a 512 MB v86 with running CPU timers; without teardown ~20 conformance tests OOM and leave open handles that hang vitest).

- [ ] **Step 1: Write the failing tests**

Append to the `describe("filesystem", ...)` block in `packages/conformance/src/suites/filesystem.ts`:

```ts
    it("delivers a mutation's file.changed within one macrotask of the call resolving", async () => {
      const rt = await booted(make);
      let seen = false;
      rt.subscribe((e) => {
        if (e.type === "file.changed" && e.path === "/bound.txt") seen = true;
      });
      await rt.writeFile("/bound.txt", "x");
      // The contract bounds delivery to <= one macrotask after the call resolves
      // (runtime-contract/src/events.ts). NOT until() — this asserts the bound.
      await new Promise((r) => setTimeout(r, 0));
      expect(seen).toBe(true);
    });
```

Append to the `describe("process", ...)` block in `packages/conformance/src/suites/process.ts` (no new import needed):

```ts
    it("kill(pid) on an exec'd process is honored through the contract", async () => {
      const rt = await booted(make);
      const p = await rt.exec("echo killable");
      // kill by pid must not throw whether the process is still running or already
      // exited (echo exits instantly on the browser kernel; a real shell may linger).
      await rt.kill(p.pid);
      const status = await rt.wait(p.pid);
      // Either it finished on its own (code 0) or was signalled — both valid; the
      // point is kill(pid) is contract surface and wait(pid) still resolves.
      expect(typeof status.code).toBe("number");
      const info = (await rt.getProcesses()).find((x) => x.pid === p.pid);
      expect(info === undefined || info.state !== "running").toBe(true);
    });
```

- [ ] **Step 2: Add the per-test teardown seam**

In `packages/conformance/src/types.ts`, add a registry and register each booted runtime:

```ts
import type { Runtime } from "@erdou/runtime-contract";

export type MakeRuntime = () => Runtime | Promise<Runtime>;

const active: Runtime[] = [];

export async function booted(make: MakeRuntime): Promise<Runtime> {
  const rt = await make();
  await rt.boot();
  active.push(rt);
  return rt;
}

/** Shut down every runtime created via booted() since the last call. A VM
 *  runtime holds a live emulator (CPU timers, ~512 MB) — without this, a
 *  per-test factory leaks one VM per test and hangs/OOMs the run. */
export async function teardownRuntimes(): Promise<void> {
  const rts = active.splice(0, active.length);
  await Promise.all(rts.map((rt) => rt.shutdown().catch(() => {})));
}
```

(Keep the existing `until` export in this file.)

In `packages/conformance/src/index.ts`, drain after each test:

```ts
import { describe, afterEach } from "vitest";
import { teardownRuntimes } from "./types.js";
// ...existing suite imports...

export function runConformance(name: string, make: MakeRuntime): void {
  describe(`conformance: ${name}`, () => {
    afterEach(async () => { await teardownRuntimes(); });
    filesystemSuite(make);
    processSuite(make);
    shellSuite(make);
    snapshotSuite(make);
    portSuite(make);
    capabilitiesSuite(make);
  });
}
```

- [ ] **Step 3: Run to verify the new tests fail-then-pass on BrowserRuntime**

Run: `pnpm vitest run packages/conformance`
Expected: the two new tests run under `conformance: BrowserRuntime`. The delivery-bound test PASSES (BrowserRuntime's bus is synchronous); the exec-kill test PASSES (BrowserRuntime's exec returns a real pid via Round 10's `adopt`, so `kill(p.pid)` + `wait(p.pid)` resolve; the record is retained so `getProcesses()` still lists it as exited). Teardown adds an `afterEach` that calls `BrowserRuntime.shutdown()` (cheap) — all existing conformance tests stay green. If any test fails, fix the test to match the contract, not the runtime.

- [ ] **Step 4: Commit**

```bash
git add packages/conformance
git commit -m "test(conformance): one-macrotask delivery bound + exec-kill; per-test runtime teardown seam"
```

---

### Task 2: `@erdou/runtime-vm` scaffold — package, layering, capabilities, port registry

Stand up the package so it builds, typechecks, and passes `lint:deps`, with the two smallest self-contained pieces (capabilities + port registry) fully tested and a `VmRuntime` stub that satisfies the `Runtime` type by throwing "not booted" for the not-yet-built surfaces.

**Files:**
- Create: `packages/runtime-vm/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`
- Create: `packages/runtime-vm/src/capabilities.ts`, `capabilities.test.ts`
- Create: `packages/runtime-vm/src/port-registry.ts`, `port-registry.test.ts`
- Create: `packages/runtime-vm/src/vm-runtime.ts` (stub)
- Modify: `.dependency-cruiser.cjs`
- Modify: `pnpm-lock.yaml` (via `pnpm install` after adding the `v86` dep)

**Interfaces:**
- Produces:
  - `vmCapabilities(interpreters: string[]): RuntimeCapabilities` in `capabilities.ts`.
  - `class PortRegistry` in `port-registry.ts` with `exposePort(port): string`, `serve(port, handler): void`, `dispatch(port, req): Promise<HttpResponse>`, `close(port): void`, `ports(): number[]`, taking `(emit: (e: RuntimeEvent) => void)` in its constructor — same behavior as `runtime-browser`'s (EADDRINUSE on double-serve, 502 on unbound dispatch, `port.opened`/`port.closed` events).
  - `class VmRuntime implements Runtime` in `vm-runtime.ts` (stub; fleshed out in Task 9).

- [ ] **Step 1: Create the package manifest, tsconfig, vitest config**

`packages/runtime-vm/package.json`:

```json
{
  "name": "@erdou/runtime-vm",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "module": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": { "types": "./src/index.ts", "import": "./src/index.ts" } },
  "files": ["dist"],
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts --clean",
    "typecheck": "tsc --noEmit",
    "download-assets": "node scripts/download-assets.mjs",
    "bake": "node scripts/bake-image.mjs"
  },
  "dependencies": {
    "@erdou/runtime-contract": "workspace:*",
    "v86": "^0.5.424"
  },
  "devDependencies": {
    "@erdou/conformance": "workspace:*",
    "@erdou/runtime-browser": "workspace:*"
  },
  "publishConfig": {
    "main": "./dist/index.js",
    "module": "./dist/index.js",
    "types": "./dist/index.d.ts",
    "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } }
  }
}
```

`packages/runtime-vm/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src"] }
```

`packages/runtime-vm/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  // VM boots are seconds; the gated conformance suite needs a generous budget.
  test: { environment: "node", include: ["src/**/*.test.ts"], testTimeout: 120_000, hookTimeout: 120_000 },
});
```

- [ ] **Step 2: Install the v86 dep**

Run: `pnpm install` (from repo root — picks up the new package + `v86` dependency, updates the lockfile).
Expected: `v86` resolves; no workspace errors.

- [ ] **Step 3: Write failing tests for capabilities + port registry**

`packages/runtime-vm/src/capabilities.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { vmCapabilities } from "./capabilities.js";

describe("vmCapabilities", () => {
  it("describes a real 32-bit Alpine guest", () => {
    const caps = vmCapabilities(["python3"]);
    expect(caps.realOs).toBe(true);
    expect(caps.nativeProcesses).toBe(true);
    expect(caps.nativeAddons).toBe(true); // a real machine runs native binaries
    expect(caps.interpreters).toEqual(["python3"]);
    expect(caps.packageManagers).toEqual(["apk", "pip"]);
    expect(caps.networkEgress).toBe("none"); // Round 12 adds the gateway
    expect(caps.memoryLimitMB).toBe(512);
    expect(caps.snapshotCost).toBe("cheap"); // workspace-scoped, not the whole machine
  });
});
```

`packages/runtime-vm/src/port-registry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { RuntimeEvent, HttpHandler } from "@erdou/runtime-contract";
import { PortRegistry } from "./port-registry.js";

const req = { method: "GET", url: "/", headers: {}, body: new Uint8Array() };

describe("PortRegistry", () => {
  it("serves, dispatches, then closes with events and a 502 afterward", async () => {
    const events: RuntimeEvent[] = [];
    const reg = new PortRegistry((e) => events.push(e));
    const handler: HttpHandler = () => ({ status: 200, headers: {}, body: new TextEncoder().encode("hi") });
    reg.serve(8080, handler);
    expect(events.some((e) => e.type === "port.opened" && e.port === 8080)).toBe(true);
    const ok = await reg.dispatch(8080, req);
    expect(ok.status).toBe(200);
    reg.close(8080);
    expect(events.some((e) => e.type === "port.closed" && e.port === 8080)).toBe(true);
    expect((await reg.dispatch(8080, req)).status).toBe(502);
  });

  it("throws EADDRINUSE on double serve and is idempotent on close", () => {
    const reg = new PortRegistry(() => {});
    const h: HttpHandler = () => ({ status: 200, headers: {}, body: new Uint8Array() });
    reg.serve(3000, h);
    expect(() => reg.serve(3000, h)).toThrow(/EADDRINUSE/);
    reg.close(3000);
    expect(() => reg.close(3000)).not.toThrow();
  });
});
```

- [ ] **Step 4: Run to verify they fail**

Run: `pnpm vitest run packages/runtime-vm`
Expected: FAIL — `./capabilities.js` / `./port-registry.js` don't exist.

- [ ] **Step 5: Implement capabilities + port registry + the VmRuntime stub + index**

`packages/runtime-vm/src/capabilities.ts`:

```ts
import type { RuntimeCapabilities } from "@erdou/runtime-contract";

/** Capabilities for the v86 + Alpine guest. `interpreters` is what the baked
 *  image actually ships (MVP: python3). networkEgress is "none" until Round 12
 *  wires the package-registry gateway. */
export function vmCapabilities(interpreters: string[]): RuntimeCapabilities {
  return {
    nativeProcesses: true,
    virtualPorts: true,
    persistentStorage: true,
    threads: false,
    nativeAddons: true,
    realOs: true,
    interpreters,
    packageManagers: ["apk", "pip"],
    networkEgress: "none",
    memoryLimitMB: 512,
    snapshotCost: "cheap",
  };
}
```

`packages/runtime-vm/src/port-registry.ts` (behaviorally identical to `runtime-browser`'s; own copy because layering forbids importing it):

```ts
import { ErrnoError } from "@erdou/runtime-contract";
import type { HttpHandler, HttpRequest, HttpResponse, RuntimeEvent } from "@erdou/runtime-contract";

/** The in-VM HTTP surface: a program serves a handler on a virtual port and
 *  `dispatch` routes a request to it. For Round 11a this is page-side only
 *  (no proxy into a real guest server yet — that is Round 12). */
export class PortRegistry {
  private readonly handlers = new Map<number, HttpHandler>();
  constructor(private readonly emit: (e: RuntimeEvent) => void) {}

  exposePort(port: number): string {
    const url = `/__port__/${port}/`;
    this.emit({ type: "port.opened", port, url });
    return url;
  }

  serve(port: number, handler: HttpHandler): void {
    if (this.handlers.has(port)) throw new ErrnoError("EADDRINUSE", { syscall: "serve", path: String(port) });
    this.handlers.set(port, handler);
    this.emit({ type: "port.opened", port, url: `/__port__/${port}/` });
  }

  async dispatch(port: number, req: HttpRequest): Promise<HttpResponse> {
    const handler = this.handlers.get(port);
    if (!handler) {
      return { status: 502, headers: { "content-type": "text/plain" }, body: new TextEncoder().encode(`No server listening on port ${port}`) };
    }
    return handler(req);
  }

  close(port: number): void {
    if (this.handlers.delete(port)) this.emit({ type: "port.closed", port });
  }

  ports(): number[] {
    return [...this.handlers.keys()];
  }
}
```

`packages/runtime-vm/src/vm-runtime.ts` (stub — completed in Task 9):

```ts
import type {
  Runtime, SpawnOptions, ProcessHandle, ProcessInfo, ExitStatus, Signal,
  Stat, FileEntry, WriteFileOptions, MkdirOptions, RmOptions,
  RuntimeCapabilities, RuntimeEventListener, Unsubscribe, Snapshot,
  VirtualPort, HttpRequest, HttpResponse,
} from "@erdou/runtime-contract";
import { vmCapabilities } from "./capabilities.js";

const notBooted = (): never => {
  throw new Error("VmRuntime: not booted — call boot() first (full implementation lands in Task 9)");
};

/** A Runtime backed by a v86 + Alpine guest. Stub in Task 2; composed in Task 9. */
export class VmRuntime implements Runtime {
  async boot(): Promise<void> { notBooted(); }
  async shutdown(): Promise<void> {}
  async spawn(_o: SpawnOptions): Promise<ProcessHandle> { return notBooted(); }
  async exec(_c: string, _o?: Omit<SpawnOptions, "cmd" | "args">): Promise<ProcessHandle> { return notBooted(); }
  async kill(_p: number, _s?: Signal): Promise<void> { notBooted(); }
  async wait(_p: number): Promise<ExitStatus> { return notBooted(); }
  async getProcesses(): Promise<ProcessInfo[]> { return notBooted(); }
  async readFile(_p: string): Promise<Uint8Array> { return notBooted(); }
  async writeFile(_p: string, _d: Uint8Array | string, _o?: WriteFileOptions): Promise<void> { notBooted(); }
  async readdir(_p: string): Promise<FileEntry[]> { return notBooted(); }
  async mkdir(_p: string, _o?: MkdirOptions): Promise<void> { notBooted(); }
  async rm(_p: string, _o?: RmOptions): Promise<void> { notBooted(); }
  async rename(_f: string, _t: string): Promise<void> { notBooted(); }
  async stat(_p: string): Promise<Stat> { return notBooted(); }
  async createSnapshot(): Promise<Snapshot> { return notBooted(); }
  async restoreSnapshot(_s: Snapshot): Promise<void> { notBooted(); }
  async listen(_p: number): Promise<VirtualPort> { return notBooted(); }
  async exposePort(_p: number): Promise<string> { return notBooted(); }
  async dispatch(_p: number, _r: HttpRequest): Promise<HttpResponse> { return notBooted(); }
  async closePort(_p: number): Promise<void> { notBooted(); }
  async getCapabilities(): Promise<RuntimeCapabilities> { return vmCapabilities(["python3"]); }
  subscribe(_l: RuntimeEventListener): Unsubscribe { return () => {}; }
}
```

`packages/runtime-vm/src/index.ts`:

```ts
export { VmRuntime } from "./vm-runtime.js";
export { vmCapabilities } from "./capabilities.js";
```

- [ ] **Step 6: Add the layering rules**

In `.dependency-cruiser.cjs`, three edits:

1. Add `runtime-vm` to the `contract-stays-pure` rule's forbidden `to` alternation (so the contract can't import it). Change:
   ```js
   to: { path: "^packages/(runtime-browser|conformance|model-gateway|agent-tools|agent-core|lang-python|runtime-wasi|bundler|tool-git)/src" },
   ```
   to include `runtime-vm`:
   ```js
   to: { path: "^packages/(runtime-browser|runtime-vm|conformance|model-gateway|agent-tools|agent-core|lang-python|runtime-wasi|bundler|tool-git)/src" },
   ```

2. Extend the `runtime-never-imports-model-or-agent` rule's `from` to include `runtime-vm`:
   ```js
   from: { path: "^packages/runtime-(contract|browser|vm)/src" },
   ```

3. Add a new rule after `runtime-browser-only-contract`:
   ```js
   {
     name: "runtime-vm-only-contract",
     comment: "runtime-vm is a Runtime implementation; it may import only @erdou/runtime-contract (+ the v86 npm dep). Tests may import conformance and runtime-browser.",
     severity: "error",
     from: { path: "^packages/runtime-vm/src", pathNot: "\\.test\\.ts$" },
     to: { path: "^packages/(runtime-browser|conformance|model-gateway|agent-tools|agent-core)/src" },
   },
   ```

- [ ] **Step 7: Run tests + gates**

Run: `pnpm vitest run packages/runtime-vm && pnpm typecheck && pnpm lint:deps`
Expected: capability + port tests PASS; typecheck clean (the stub satisfies `Runtime`); `lint:deps` clean (runtime-vm imports only the contract).

- [ ] **Step 8: Full-suite gate + commit**

Run: `pnpm test`
Expected: 0 failures (the VM package adds only hermetic unit tests so far).

```bash
git add packages/runtime-vm .dependency-cruiser.cjs pnpm-lock.yaml package.json
git commit -m "feat(runtime-vm): package scaffold — capabilities, port registry, VmRuntime stub, layering rule"
```

---

### Task 3: guestd wire protocol (pure codec, TDD)

The host and guest talk over `/dev/hvc0` in **length-prefixed binary frames** so stdout/stderr are binary-safe (a line protocol would break on `\n` in output). Each frame: `[u32be payloadLen][1 byte type][u32be id][body]`. Body is raw bytes for stdout/stderr, UTF-8 JSON for control messages. This task is pure encode/decode + a streaming reassembler — fully unit-testable, no v86.

**Files:**
- Create: `packages/runtime-vm/src/guestd-protocol.ts`, `guestd-protocol.test.ts`

**Interfaces:**
- Produces:
  - `const enum FrameType` values (as plain string consts): `READY="R"`, `STARTED="S"`, `STDOUT="O"`, `STDERR="E"`, `EXIT="X"`, `PROCS="P"`, `ERROR="!"`, and requests `EXEC="x"`, `SPAWN="s"`, `KILL="k"`, `PS="p"`.
  - `encodeFrame(type: string, id: number, body: Uint8Array): Uint8Array`
  - `encodeJsonFrame(type: string, id: number, obj: unknown): Uint8Array`
  - `class FrameReader { push(chunk: Uint8Array): Frame[] }` where `Frame = { type: string; id: number; body: Uint8Array }` — accumulates bytes and yields complete frames (handles split/merged chunks).
  - `decodeJson(body: Uint8Array): unknown`
- Consumed by: `guestd-client.ts` (Task 4) and mirrored by `guestd.py` (Task 4).

- [ ] **Step 1: Write the failing tests**

`packages/runtime-vm/src/guestd-protocol.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { encodeFrame, encodeJsonFrame, FrameReader, decodeJson, FrameType } from "./guestd-protocol.js";

const bytes = (...n: number[]): Uint8Array => new Uint8Array(n);

describe("guestd-protocol", () => {
  it("round-trips a binary frame through the reader", () => {
    const frame = encodeFrame(FrameType.STDOUT, 7, bytes(0x00, 0xff, 0x0a, 0x41));
    const r = new FrameReader();
    const out = r.push(frame);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe("O");
    expect(out[0]!.id).toBe(7);
    expect([...out[0]!.body]).toEqual([0x00, 0xff, 0x0a, 0x41]);
  });

  it("reassembles a frame split across chunks and splits merged frames", () => {
    const a = encodeJsonFrame(FrameType.EXEC, 1, { cmd: "echo hi" });
    const b = encodeFrame(FrameType.STDOUT, 1, bytes(0x68, 0x69));
    const both = new Uint8Array(a.length + b.length);
    both.set(a, 0);
    both.set(b, a.length);
    const r = new FrameReader();
    // split at an arbitrary interior byte
    const mid = a.length + 2;
    expect(r.push(both.slice(0, mid))).toHaveLength(1); // only `a` completes
    const rest = r.push(both.slice(mid));
    expect(rest).toHaveLength(1);
    expect(rest[0]!.type).toBe("O");
    expect(decodeJson(a.subarray(9))).toEqual({ cmd: "echo hi" }); // body starts after 4+1+4 header
  });

  it("carries all byte values 0x00-0xff intact", () => {
    const payload = new Uint8Array(256).map((_, i) => i);
    const r = new FrameReader();
    const [f] = r.push(encodeFrame(FrameType.STDERR, 99, payload));
    expect([...f!.body]).toEqual([...payload]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/runtime-vm/src/guestd-protocol.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the codec**

`packages/runtime-vm/src/guestd-protocol.ts`:

```ts
/** Frame types (single ASCII byte). Requests are lowercase, responses uppercase/symbol. */
export const FrameType = {
  READY: "R", STARTED: "S", STDOUT: "O", STDERR: "E", EXIT: "X", PROCS: "P", ERROR: "!",
  EXEC: "x", SPAWN: "s", KILL: "k", PS: "p", PING: "i",
} as const;

export interface Frame {
  type: string;
  id: number;
  body: Uint8Array;
}

const HEADER = 9; // u32be payloadLen + 1 byte type + u32be id; payloadLen counts type+id+body

/** Encode one frame. `payloadLen` = 1 (type) + 4 (id) + body.length. */
export function encodeFrame(type: string, id: number, body: Uint8Array): Uint8Array {
  const payloadLen = 1 + 4 + body.length;
  const out = new Uint8Array(4 + payloadLen);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, payloadLen, false);
  out[4] = type.charCodeAt(0);
  dv.setUint32(5, id, false);
  out.set(body, HEADER);
  return out;
}

export function encodeJsonFrame(type: string, id: number, obj: unknown): Uint8Array {
  return encodeFrame(type, id, new TextEncoder().encode(JSON.stringify(obj)));
}

export function decodeJson(body: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(body));
}

/** Accumulates bytes from a byte stream and yields complete frames. */
export class FrameReader {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): Frame[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    this.buf = merged;

    const frames: Frame[] = [];
    let off = 0;
    while (this.buf.length - off >= 4) {
      const dv = new DataView(this.buf.buffer, this.buf.byteOffset + off);
      const payloadLen = dv.getUint32(0, false);
      if (this.buf.length - off - 4 < payloadLen) break; // incomplete
      const type = String.fromCharCode(this.buf[off + 4]!);
      const id = dv.getUint32(5, false);
      const body = this.buf.slice(off + HEADER, off + 4 + payloadLen);
      frames.push({ type, id, body });
      off += 4 + payloadLen;
    }
    if (off > 0) this.buf = this.buf.slice(off);
    return frames;
  }
}
```

- [ ] **Step 4: Run to verify pass + commit**

Run: `pnpm vitest run packages/runtime-vm/src/guestd-protocol.test.ts`
Expected: PASS.

```bash
git add packages/runtime-vm/src/guestd-protocol.ts packages/runtime-vm/src/guestd-protocol.test.ts
git commit -m "feat(runtime-vm): guestd wire protocol — length-prefixed binary frames + streaming reader"
```

---

### Task 4: guestd client (TDD w/ a fake channel) + `guestd.py` (verified by the gated e2e)

`guestd-client.ts` drives the protocol over a byte channel: it correlates responses by id, exposes `exec`/`spawn` (returning a `ProcessHandle`-shaped result with `stdout`/`stderr` `ByteStream`s + `wait`/`kill`), `kill`, and `ps`, and rejects an unknown command with `ENOENT`. It is fully unit-testable against a **fake channel** scripted to speak the protocol. `guestd.py` is the guest daemon that implements the other end; it can only run inside the guest, so it is **verified by the Task 9 gated conformance run**, not a Node unit test — but the client's protocol handling is exercised here in full.

**Files:**
- Create: `packages/runtime-vm/src/guestd-client.ts`, `guestd-client.test.ts`
- Create: `packages/runtime-vm/src/guest/guestd.py`

**Interfaces:**
- Consumes: `guestd-protocol.ts` (Task 3); `ByteStream`/`WritableByteStream` shapes from `@erdou/runtime-contract`.
- Produces:
  - `interface GuestChannel { send(bytes: Uint8Array): void; subscribe(cb: (bytes: Uint8Array) => void): void }` — the transport the client talks over (v86-host provides the real one in Task 7; the test provides a fake).
  - `class GuestdClient` constructed with `(channel: GuestChannel)`:
    - `ready(): Promise<{ pid: number }>` — resolves when the `READY` frame arrives.
    - `exec(cmdline: string, opts?: { cwd?: string; env?: Record<string,string> }): Promise<GuestProcess>` — runs `sh -c cmdline`.
    - `spawn(cmd: string, args: string[], opts?): Promise<GuestProcess>` — resolves the command via `command -v` in the guest; rejects `ErrnoError("ENOENT")` if missing.
    - `kill(pid: number, signal?: string): Promise<void>`, `ps(): Promise<ProcessInfo[]>`.
  - `interface GuestProcess { pid: number; stdout: ByteStream; stderr: ByteStream; wait(): Promise<ExitStatus>; kill(signal?: string): Promise<void> }`.

- [ ] **Step 1: Write the failing test (client against a fake channel)**

`packages/runtime-vm/src/guestd-client.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { GuestdClient, type GuestChannel } from "./guestd-client.js";
import { encodeFrame, encodeJsonFrame, FrameReader, decodeJson, FrameType } from "./guestd-protocol.js";

/** A fake guest: replies READY to the client's PING kick (modelling the real
 *  post-restore handshake — NOT an unconditional timer), then delegates other
 *  request frames to the scripted behavior. */
function fakeGuest(handle: (type: string, id: number, body: Uint8Array, reply: (b: Uint8Array) => void) => void) {
  let onData: (b: Uint8Array) => void = () => {};
  const reader = new FrameReader();
  const channel: GuestChannel = {
    send(bytes) {
      for (const f of reader.push(bytes)) {
        if (f.type === FrameType.PING) { onData(encodeJsonFrame(FrameType.READY, 0, { pid: 63 })); continue; }
        handle(f.type, f.id, f.body, (b) => onData(b));
      }
    },
    subscribe(cb) { onData = cb; },
  };
  return channel;
}

const enc = new TextEncoder();

describe("GuestdClient", () => {
  it("resolves ready() with the guest pid", async () => {
    const client = new GuestdClient(fakeGuest(() => {}));
    expect(await client.ready()).toEqual({ pid: 63 });
  });

  it("execs a command, streams stdout, and resolves wait() with the exit code", async () => {
    const channel = fakeGuest((type, id, _body, reply) => {
      if (type === FrameType.EXEC) {
        reply(encodeJsonFrame(FrameType.STARTED, id, { pid: 100 }));
        reply(encodeFrame(FrameType.STDOUT, id, enc.encode("hi\n")));
        reply(encodeJsonFrame(FrameType.EXIT, id, { code: 0, signal: null }));
      }
    });
    const client = new GuestdClient(channel);
    await client.ready();
    const p = await client.exec("echo hi");
    expect(p.pid).toBe(100);
    expect(await p.stdout.text()).toBe("hi\n");
    expect(await p.wait()).toEqual({ code: 0, signal: null });
  });

  it("rejects spawn of an unknown command with ENOENT", async () => {
    const channel = fakeGuest((type, id, body, reply) => {
      if (type === FrameType.SPAWN) {
        const { cmd } = decodeJson(body) as { cmd: string };
        if (cmd === "nope") reply(encodeJsonFrame(FrameType.ERROR, id, { code: "ENOENT", message: "nope" }));
      }
    });
    const client = new GuestdClient(channel);
    await client.ready();
    await expect(client.spawn("nope", [])).rejects.toThrow(/ENOENT/);
  });

  it("ps() returns the guest process list", async () => {
    const channel = fakeGuest((type, id, _body, reply) => {
      if (type === FrameType.PS) {
        reply(encodeJsonFrame(FrameType.PROCS, id, { procs: [{ pid: 1, ppid: 0, cmd: "init", args: [], cwd: "/", state: "running", startTimeMs: 0, exitCode: null }] }));
      }
    });
    const client = new GuestdClient(channel);
    await client.ready();
    const procs = await client.ps();
    expect(procs[0]!.pid).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/runtime-vm/src/guestd-client.test.ts`
Expected: FAIL — `./guestd-client.js` missing.

- [ ] **Step 3: Implement the client**

`packages/runtime-vm/src/guestd-client.ts`:

```ts
import { ErrnoError } from "@erdou/runtime-contract";
import type { ByteStream, ExitStatus, ProcessInfo } from "@erdou/runtime-contract";
import { encodeJsonFrame, FrameReader, decodeJson, FrameType } from "./guestd-protocol.js";

export interface GuestChannel {
  send(bytes: Uint8Array): void;
  subscribe(cb: (bytes: Uint8Array) => void): void;
}

export interface GuestProcess {
  pid: number;
  stdout: ByteStream;
  stderr: ByteStream;
  wait(): Promise<ExitStatus>;
  kill(signal?: string): Promise<void>;
}

/** A ByteStream fed by pushed chunks, closed by end(). */
class ChunkStream implements ByteStream {
  private chunks: Uint8Array[] = [];
  private resolvers: Array<(r: IteratorResult<Uint8Array>) => void> = [];
  private closed = false;
  push(b: Uint8Array): void {
    if (this.resolvers.length) this.resolvers.shift()!({ value: b, done: false });
    else this.chunks.push(b);
  }
  end(): void {
    this.closed = true;
    while (this.resolvers.length) this.resolvers.shift()!({ value: undefined as unknown as Uint8Array, done: true });
  }
  read(): AsyncIterableIterator<Uint8Array> {
    const self = this;
    return {
      [Symbol.asyncIterator]() { return this; },
      next(): Promise<IteratorResult<Uint8Array>> {
        if (self.chunks.length) return Promise.resolve({ value: self.chunks.shift()!, done: false });
        if (self.closed) return Promise.resolve({ value: undefined as unknown as Uint8Array, done: true });
        return new Promise((res) => self.resolvers.push(res));
      },
    };
  }
  async text(): Promise<string> {
    const parts: Uint8Array[] = [];
    for await (const c of this.read()) parts.push(c);
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return new TextDecoder().decode(out);
  }
}

interface Pending {
  stdout: ChunkStream;
  stderr: ChunkStream;
  onStarted?: (pid: number) => void;
  onExit?: (s: ExitStatus) => void;
  onError?: (e: Error) => void;
}

export class GuestdClient {
  private readonly reader = new FrameReader();
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly control = new Map<number, (frame: { type: string; body: Uint8Array }) => void>();
  private readyResolve?: (v: { pid: number }) => void;
  private readonly readyPromise: Promise<{ pid: number }>;
  private pingTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly channel: GuestChannel) {
    this.readyPromise = new Promise((res) => { this.readyResolve = res; });
    this.channel.subscribe((bytes) => {
      for (const f of this.reader.push(bytes)) this.onFrame(f.type, f.id, f.body);
    });
  }

  /** Resolve when guestd is reachable. After a state RESTORE the guest sits idle
   *  and its one-time startup READY already fired (pre-snapshot) — so we KICK:
   *  send PING repeatedly until guestd replies READY. (Spike C: the first hvc0
   *  frame is the kick; without it boot() can hang forever.) */
  ready(): Promise<{ pid: number }> {
    if (!this.pingTimer) {
      const ping = () => this.channel.send(encodeJsonFrame(FrameType.PING, 0, {}));
      ping();
      this.pingTimer = setInterval(ping, 200);
      void this.readyPromise.then(() => { if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = undefined; } });
    }
    return this.readyPromise;
  }

  private onFrame(type: string, id: number, body: Uint8Array): void {
    if (type === FrameType.READY) { this.readyResolve?.(decodeJson(body) as { pid: number }); return; }
    const ctl = this.control.get(id);
    if (ctl) { ctl({ type, body }); return; }
    const p = this.pending.get(id);
    if (!p) return;
    switch (type) {
      case FrameType.STARTED: p.onStarted?.((decodeJson(body) as { pid: number }).pid); break;
      case FrameType.STDOUT: p.stdout.push(body); break;
      case FrameType.STDERR: p.stderr.push(body); break;
      case FrameType.EXIT: {
        p.stdout.end(); p.stderr.end();
        p.onExit?.(decodeJson(body) as ExitStatus);
        this.pending.delete(id);
        break;
      }
      case FrameType.ERROR: {
        p.stdout.end(); p.stderr.end();
        p.onError?.(new Error((decodeJson(body) as { message: string }).message));
        this.pending.delete(id);
        break;
      }
    }
  }

  private run(op: string, payload: Record<string, unknown>): Promise<GuestProcess> {
    const id = this.nextId++;
    const stdout = new ChunkStream();
    const stderr = new ChunkStream();
    let resolveStarted!: (pid: number) => void;
    let rejectStart!: (e: Error) => void;
    const started = new Promise<number>((res, rej) => { resolveStarted = res; rejectStart = rej; });
    let resolveExit!: (s: ExitStatus) => void;
    const exit = new Promise<ExitStatus>((res) => { resolveExit = res; });
    this.pending.set(id, {
      stdout, stderr,
      onStarted: resolveStarted,
      onExit: resolveExit,
      onError: (e) => rejectStart(e),
    });
    this.channel.send(encodeJsonFrame(op, id, payload));
    return started.then((pid) => ({
      pid, stdout, stderr,
      wait: () => exit,
      kill: (signal?: string) => this.kill(pid, signal),
    }));
  }

  exec(cmdline: string, opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<GuestProcess> {
    return this.run(FrameType.EXEC, { cmd: cmdline, cwd: opts.cwd, env: opts.env }).catch((e) => {
      throw e instanceof ErrnoError ? e : new ErrnoError("ENOENT", { path: cmdline, syscall: "exec" });
    });
  }

  spawn(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<GuestProcess> {
    return this.run(FrameType.SPAWN, { cmd, args, cwd: opts.cwd, env: opts.env }).catch(() => {
      throw new ErrnoError("ENOENT", { path: cmd, syscall: "spawn" });
    });
  }

  kill(pid: number, signal = "SIGTERM"): Promise<void> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.control.set(id, () => { this.control.delete(id); resolve(); });
      this.channel.send(encodeJsonFrame(FrameType.KILL, id, { pid, signal }));
    });
  }

  ps(): Promise<ProcessInfo[]> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.control.set(id, ({ body }) => {
        this.control.delete(id);
        resolve((decodeJson(body) as { procs: ProcessInfo[] }).procs);
      });
      this.channel.send(encodeJsonFrame(FrameType.PS, id, {}));
    });
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/runtime-vm/src/guestd-client.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write `guestd.py` (verified later by the gated e2e in Task 9)**

`packages/runtime-vm/src/guest/guestd.py` — the guest daemon. Runs INSIDE `chroot /workspace` (so its `/` is the contract root), holds `/dev/hvc0` raw, speaks the Task-3 frame protocol. Ported from the verified Spike C `guestd-poc.py` + the binary framing.

```python
#!/usr/bin/env python3
# Erdou guestd — runs inside `chroot /workspace` on the v86 Alpine guest.
# Its filesystem root IS the contract root, so user commands are a plain
# subprocess (no per-command chroot). Speaks the length-prefixed binary frame
# protocol (see guestd-protocol.ts) over /dev/hvc0. Verified by the gated
# conformance run (packages/runtime-vm/src/vm-runtime.conformance.test.ts).
import os, sys, json, struct, subprocess, threading, signal, shutil

fd = os.open("/dev/hvc0", os.O_RDWR)
import tty
tty.setraw(fd)                       # we HOLD fd → raw sticks (spike B/C gotcha)
_wlock = threading.Lock()

# Frame: u32be payloadLen | 1 byte type | u32be id | body   (payloadLen counts type+id+body)
def send(type_char, ident, body):
    payload = type_char.encode() + struct.pack(">I", ident) + body
    with _wlock:
        os.write(fd, struct.pack(">I", len(payload)) + payload)

def send_json(type_char, ident, obj):
    send(type_char, ident, json.dumps(obj).encode())

SIGNALS = {"SIGTERM": signal.SIGTERM, "SIGKILL": signal.SIGKILL, "SIGINT": signal.SIGINT, "SIGHUP": signal.SIGHUP}
procs = {}   # id -> subprocess.Popen

def pump(stream, type_char, ident):
    while True:
        chunk = stream.read(4096)
        if not chunk:
            break
        send(type_char, ident, chunk)

def run_command(ident, argv, cwd, env, shell):
    try:
        full_env = dict(os.environ)
        if env:
            full_env.update(env)
        p = subprocess.Popen(argv, cwd=cwd or "/", env=full_env, shell=shell,
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except FileNotFoundError:
        send_json("!", ident, {"code": "ENOENT", "message": " ".join(argv) if isinstance(argv, list) else str(argv)})
        return
    procs[ident] = p
    send_json("S", ident, {"pid": p.pid})
    t_out = threading.Thread(target=pump, args=(p.stdout, "O", ident), daemon=True)
    t_err = threading.Thread(target=pump, args=(p.stderr, "E", ident), daemon=True)
    t_out.start(); t_err.start()
    code = p.wait()
    t_out.join(); t_err.join()
    procs.pop(ident, None)
    sig = None
    if code < 0:
        sig = next((n for n, v in SIGNALS.items() if v == -code), None)
    send_json("X", ident, {"code": code if code >= 0 else 128 - code, "signal": sig})

def handle(type_char, ident, body):
    if type_char == "x":            # EXEC: sh -c cmd
        req = json.loads(body or b"{}")
        threading.Thread(target=run_command, args=(ident, req["cmd"], req.get("cwd"), req.get("env"), True), daemon=True).start()
    elif type_char == "s":          # SPAWN: cmd + args, resolve via PATH first
        req = json.loads(body or b"{}")
        if shutil.which(req["cmd"]) is None:
            send_json("!", ident, {"code": "ENOENT", "message": req["cmd"]})
            return
        argv = [req["cmd"], *req.get("args", [])]
        threading.Thread(target=run_command, args=(ident, argv, req.get("cwd"), req.get("env"), False), daemon=True).start()
    elif type_char == "k":          # KILL
        req = json.loads(body or b"{}")
        try:
            os.kill(req["pid"], SIGNALS.get(req.get("signal"), signal.SIGTERM))
        except ProcessLookupError:
            pass
        send_json("X", ident, {"code": 0, "signal": None})   # ack (control id, not a process id)
    elif type_char == "p":          # PS
        send_json("P", ident, {"procs": list_procs()})
    elif type_char == "i":          # PING → the client's post-restore kick; re-announce READY
        send_json("R", 0, {"pid": os.getpid()})

def list_procs():
    out = []
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open("/proc/%s/cmdline" % pid, "rb") as f:
                parts = f.read().split(b"\x00")
            with open("/proc/%s/stat" % pid) as f:
                ppid = int(f.read().split(") ", 1)[1].split()[1])
            cmd = (parts[0] or b"").decode(errors="replace")
            args = [p.decode(errors="replace") for p in parts[1:] if p]
            out.append({"pid": int(pid), "ppid": ppid, "cmd": cmd, "args": args,
                        "cwd": "/", "state": "running", "startTimeMs": 0, "exitCode": None})
        except (FileNotFoundError, ProcessLookupError, IndexError, PermissionError):
            continue
    return out

send_json("R", 0, {"pid": os.getpid()})

# Frame reader loop
buf = b""
while True:
    chunk = os.read(fd, 65536)
    if not chunk:
        break
    buf += chunk
    while len(buf) >= 4:
        (plen,) = struct.unpack(">I", buf[:4])
        if len(buf) - 4 < plen:
            break
        payload = buf[4:4 + plen]
        buf = buf[4 + plen:]
        t = chr(payload[0])
        (ident,) = struct.unpack(">I", payload[1:5])
        try:
            handle(t, ident, payload[5:])
        except Exception as e:            # never let one bad frame kill the daemon
            send_json("!", ident, {"code": "EINVAL", "message": str(e)})
```

- [ ] **Step 6: Commit**

```bash
git add packages/runtime-vm/src/guestd-client.ts packages/runtime-vm/src/guestd-client.test.ts packages/runtime-vm/src/guest/guestd.py
git commit -m "feat(runtime-vm): guestd client (id-correlated exec/spawn/kill/ps) + guestd.py daemon"
```

---

### Task 5: fs-bridge — wrap fs9p, observe guest writes, expose async workspace FS

Port Spike A's verified adapter to TypeScript and add: the `workspace/` prefix filter (→ contract paths), write-event **coalescing** (one `file.changed` per path per flush, not one per 4 KB chunk), a `RuntimeEvent` emitter, the async `Runtime` FS methods over `/workspace`, and a `rebuildIndex()` for post-`restore_state`. The `Fs9p` object is a structural interface (the real one is `emulator.fs9p`); tests use a **fake `Fs9p`** backed by JS maps, so all bridge logic is unit-tested without v86.

**Files:**
- Create: `packages/runtime-vm/src/fs-bridge.ts`, `fs-bridge.test.ts`

**Interfaces:**
- Consumes: contract FS types + `ErrnoError` + `RuntimeEvent`.
- Produces:
  - `interface Fs9p` — the subset of `emulator.fs9p` the bridge uses: `inodes: Array<{ mode: number; size: number; direntries?: Map<string, number>; symlink?: string; mtime: number; qid: { version: number } }>`; `CreateFile`, `CreateDirectory`, `CreateSymlink`, `Write`, `ChangeSize`, `Unlink`, `Rename`, `Search`, `SearchPath`, `GetFullPath`, `GetInode`, `CreateBinaryFile`, `read_file`. (Method shapes exactly as Spike A documented.)
  - `const WORKSPACE = "workspace"` and `const SKELETON_DIRS = ["bin", "lib", "usr", "proc", "dev", "tmp"]`.
  - `class Fs9pBridge` constructed with `(fs9p: Fs9p, emit: (e: RuntimeEvent) => void, opts?: { coalesceMs?: number })`:
    - `attach(): void` — installs the method wrappers + builds the initial path index.
    - `rebuildIndex(): void` — re-walk `workspace/` into the idx→path map (call after `restore_state`).
    - async FS: `readFile(path)`, `writeFile(path, data, opts?)`, `readdir(path)`, `mkdir(path, opts?)`, `rm(path, opts?)`, `rename(from, to)`, `stat(path)` — all over the `/workspace` subtree, translating contract `/x` ↔ fs9p `workspace/x`.
    - `flush(): void` — force-emit any pending coalesced `file.changed` (used before snapshot reads).
- Consumed by: `vm-runtime.ts` (Task 9), `workspace-snapshot.ts` (Task 6 shares the fs9p enumeration helper — exported as `enumerateWorkspace`).

- [ ] **Step 1: Write the failing tests (fake fs9p)**

`packages/runtime-vm/src/fs-bridge.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import type { RuntimeEvent } from "@erdou/runtime-contract";
import { Fs9pBridge, WORKSPACE, type Fs9p } from "./fs-bridge.js";

/** A JS-map-backed fake of the v86 FS surface the bridge uses. Inodes are
 *  {mode,size,direntries?,symlink?,mtime,qid}; dirs hold a name→idx map. */
function makeFakeFs9p(): Fs9p & { root: number } {
  const inodes: any[] = [];
  const data: (Uint8Array | undefined)[] = [];
  const mkInode = (mode: number): number => {
    inodes.push({ mode, size: 0, direntries: (mode & 0o170000) === 0o040000 ? new Map() : undefined, mtime: 0, qid: { version: 0 } });
    data.push(undefined);
    return inodes.length - 1;
  };
  const root = mkInode(0o040755); // idx 0 = export root
  const fs: any = {
    inodes,
    GetInode: (i: number) => inodes[i],
    CreateDirectory(name: string, parent: number) { const i = mkInode(0o040755); inodes[parent].direntries.set(name, i); return i; },
    CreateFile(name: string, parent: number) { const i = mkInode(0o100644); inodes[parent].direntries.set(name, i); return i; },
    CreateSymlink(name: string, parent: number, target: string) { const i = mkInode(0o120777); inodes[i].symlink = target; inodes[parent].direntries.set(name, i); return i; },
    async CreateBinaryFile(name: string, parent: number, buf: Uint8Array) { const i = this.CreateFile(name, parent); data[i] = new Uint8Array(buf); inodes[i].size = buf.length; return i; },
    Search(parent: number, name: string) { const d = inodes[parent].direntries; return d && d.has(name) ? d.get(name) : -1; },
    SearchPath(path: string) {
      const parts = path.split("/").filter(Boolean);
      let id = 0, parentid = -1, name = "";
      for (const p of parts) { const nx = this.Search(id, p); parentid = id; name = p; if (nx === -1) return { id: -1, parentid, name }; id = nx; }
      return { id, parentid, name: parts[parts.length - 1] ?? "" };
    },
    GetFullPath(_i: number) { return ""; }, // dir-only in v86; the bridge maintains its own map
    async Write(i: number, offset: number, count: number, buf: Uint8Array) {
      const cur = data[i] ?? new Uint8Array(0);
      const need = offset + count;
      const out = new Uint8Array(Math.max(cur.length, need));
      out.set(cur, 0); out.set(buf.subarray(0, count), offset);
      data[i] = out; inodes[i].size = out.length;
    },
    async ChangeSize(i: number, size: number) { const cur = data[i] ?? new Uint8Array(0); const out = new Uint8Array(size); out.set(cur.subarray(0, size), 0); data[i] = out; inodes[i].size = size; },
    Unlink(parent: number, name: string) { const d = inodes[parent].direntries; if (!d.has(name)) return -1; d.delete(name); return 0; },
    async Rename(od: number, on: string, nd: number, nn: string) { const s = inodes[od].direntries; if (!s.has(on)) return -1; const idx = s.get(on); s.delete(on); inodes[nd].direntries.set(nn, idx); return 0; },
    async read_file(path: string) { const w = this.SearchPath(path); return w.id === -1 ? null : (data[w.id] ?? new Uint8Array(0)); },
    root,
  };
  return fs;
}

function bootWorkspace(fs: any): void {
  const ws = fs.CreateDirectory(WORKSPACE, 0);
  // skeleton dirs, page-side (no wrappers yet)
  for (const d of ["bin", "lib", "usr", "proc", "dev", "tmp"]) fs.CreateDirectory(d, ws);
}

describe("Fs9pBridge", () => {
  it("page-side writeFile emits one synchronous create and reads back", async () => {
    const fs = makeFakeFs9p(); bootWorkspace(fs);
    const events: RuntimeEvent[] = [];
    const bridge = new Fs9pBridge(fs, (e) => events.push(e));
    bridge.attach();
    await bridge.writeFile("/hello.txt", "hi");
    expect(new TextDecoder().decode(await bridge.readFile("/hello.txt"))).toBe("hi");
    // The contract requires the event (conformance's file.changed test drives
    // page-side writes); it must land synchronously, not via the coalesce timer.
    const changes = events.filter((e) => e.type === "file.changed");
    expect(changes).toEqual([{ type: "file.changed", path: "/hello.txt", kind: "create" }]);
    await bridge.writeFile("/hello.txt", "bye");
    expect(events.filter((e) => e.type === "file.changed").at(-1)).toMatchObject({ path: "/hello.txt", kind: "modify" });
  });

  it("a guest write (through the wrapped fs9p) emits a coalesced file.changed with the contract path", async () => {
    vi.useFakeTimers();
    const fs = makeFakeFs9p(); bootWorkspace(fs);
    const events: RuntimeEvent[] = [];
    const bridge = new Fs9pBridge(fs, (e) => events.push(e), { coalesceMs: 5 });
    bridge.attach();
    const wsId = fs.SearchPath("workspace").id;
    // simulate the guest: create + two chunked writes to workspace/out.txt
    const id = fs.CreateFile("out.txt", wsId);
    await fs.Write(id, 0, 3, new TextEncoder().encode("abc"));
    await fs.Write(id, 3, 3, new TextEncoder().encode("def"));
    vi.advanceTimersByTime(6);
    const changes = events.filter((e) => e.type === "file.changed");
    expect(changes).toHaveLength(1); // coalesced, not 3
    expect(changes[0]).toMatchObject({ type: "file.changed", path: "/out.txt", kind: "create" });
    vi.useRealTimers();
  });

  it("readFile of a missing path rejects ENOENT; mkdir + readdir round-trips", async () => {
    const fs = makeFakeFs9p(); bootWorkspace(fs);
    const bridge = new Fs9pBridge(fs, () => {});
    bridge.attach();
    await expect(bridge.readFile("/nope")).rejects.toThrow(/ENOENT/);
    await bridge.mkdir("/d", { recursive: true });
    await bridge.writeFile("/d/x", "1");
    expect((await bridge.readdir("/d")).map((e) => e.name)).toEqual(["x"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/runtime-vm/src/fs-bridge.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the bridge**

`packages/runtime-vm/src/fs-bridge.ts` (the wrapping logic is a direct port of the verified Spike A `adapter.mjs`; the additions are the workspace prefix filter, coalescing, event mapping, and the async FS methods):

```ts
import { ErrnoError } from "@erdou/runtime-contract";
import type { FileEntry, RuntimeEvent, Stat, WriteFileOptions, MkdirOptions, RmOptions } from "@erdou/runtime-contract";

export const WORKSPACE = "workspace";
export const SKELETON_DIRS = ["bin", "lib", "usr", "proc", "dev", "tmp"];

const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFREG = 0o100000, S_IFLNK = 0o120000;

/** The subset of v86's `emulator.fs9p` (class FS) the bridge drives. Method
 *  names verified present in the shipped minified build (Spike A). */
export interface Fs9pInode { mode: number; size: number; direntries?: Map<string, number>; symlink?: string; mtime: number; qid: { version: number }; }
export interface Fs9p {
  inodes: Fs9pInode[];
  GetInode(idx: number): Fs9pInode;
  CreateFile(name: string, parentid: number): number;
  CreateDirectory(name: string, parentid: number): number;
  CreateSymlink(name: string, parentid: number, target: string): number;
  CreateBinaryFile(name: string, parentid: number, buf: Uint8Array): Promise<number>;
  Write(idx: number, offset: number, count: number, buf: Uint8Array): Promise<void>;
  ChangeSize(idx: number, size: number): Promise<void>;
  Unlink(parentid: number, name: string): number;
  Rename(olddir: number, oldname: string, newdir: number, newname: string): Promise<number>;
  Search(parentid: number, name: string): number;
  SearchPath(path: string): { id: number; parentid: number; name: string };
  GetFullPath(idx: number): string;
  read_file(path: string): Promise<Uint8Array | null>;
}

type ChangeKind = "create" | "modify" | "delete";

/** Wraps fs9p to observe guest writes and exposes an async workspace FS.
 *  Contract path `/x` maps to fs9p path `workspace/x`. */
export class Fs9pBridge {
  private suppress = 0;
  private inWrite = 0;
  private readonly paths = new Map<number, string>(); // inode idx -> fs9p-relative path ("" = export root)
  private readonly pendingChanges = new Map<string, ChangeKind>(); // contract path -> kind (coalesced)
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly coalesceMs: number;
  private orig: Record<string, (...a: any[]) => any> = {};

  constructor(private readonly fs: Fs9p, private readonly emit: (e: RuntimeEvent) => void, opts: { coalesceMs?: number } = {}) {
    this.coalesceMs = opts.coalesceMs ?? 10;
  }

  attach(): void {
    this.paths.set(0, "");
    this.rebuildIndex();
    const fs = this.fs as any;
    for (const m of ["CreateFile", "CreateDirectory", "CreateSymlink", "Write", "ChangeSize", "Unlink", "Rename"]) this.orig[m] = fs[m];
    const self = this;
    const join = (dir: string, name: string) => (dir ? dir + "/" + name : name);
    const dirPath = (parentid: number): string => {
      let p = self.paths.get(parentid);
      if (p === undefined) { p = self.fs.GetFullPath(parentid); self.paths.set(parentid, p); }
      return p;
    };

    fs.CreateFile = function (name: string, parentid: number) {
      const idx = self.orig.CreateFile.call(this, name, parentid);
      const p = join(dirPath(parentid), name); self.paths.set(idx, p);
      self.record(p, "create"); return idx;
    };
    fs.CreateDirectory = function (name: string, parentid: number) {
      const idx = self.orig.CreateDirectory.call(this, name, parentid);
      if (parentid >= 0) { const p = join(dirPath(parentid), name); self.paths.set(idx, p); self.record(p, "create"); }
      return idx;
    };
    fs.CreateSymlink = function (name: string, parentid: number, target: string) {
      const idx = self.orig.CreateSymlink.call(this, name, parentid, target);
      const p = join(dirPath(parentid), name); self.paths.set(idx, p); self.record(p, "create"); return idx;
    };
    fs.Write = async function (idx: number, offset: number, count: number, buffer: Uint8Array) {
      self.inWrite++;
      try { await self.orig.Write.call(this, idx, offset, count, buffer); } finally { self.inWrite--; }
      self.record(self.paths.get(idx) ?? `<inode:${idx}>`, "modify");
    };
    fs.ChangeSize = async function (idx: number, newsize: number) {
      const oldsize = this.GetInode(idx).size;
      await self.orig.ChangeSize.call(this, idx, newsize);
      if (!self.inWrite && newsize !== oldsize) self.record(self.paths.get(idx) ?? `<inode:${idx}>`, "modify");
    };
    fs.Unlink = function (parentid: number, name: string) {
      const idx = this.Search(parentid, name);
      const p = idx !== -1 ? (self.paths.get(idx) ?? join(dirPath(parentid), name)) : null;
      const ret = self.orig.Unlink.call(this, parentid, name);
      if (ret === 0 && idx !== -1 && p !== null) { self.paths.delete(idx); self.record(p, "delete"); }
      return ret;
    };
    fs.Rename = async function (olddir: number, oldname: string, newdir: number, newname: string) {
      const idx = this.Search(olddir, oldname);
      const oldPath = idx !== -1 ? (self.paths.get(idx) ?? join(dirPath(olddir), oldname)) : null;
      const ret = await self.orig.Rename.call(this, olddir, oldname, newdir, newname);
      if (ret === 0 && idx !== -1 && oldPath !== null) {
        const newPath = join(dirPath(newdir), newname);
        const prefix = oldPath + "/";
        for (const [i, p] of self.paths) {
          if (i === idx) self.paths.set(i, newPath);
          else if (p.startsWith(prefix)) self.paths.set(i, newPath + "/" + p.slice(prefix.length));
        }
        self.record(oldPath, "delete"); self.record(newPath, "create");
      }
      return ret;
    };
  }

  /** Re-walk workspace/ into the idx→path map (call after restore_state). */
  rebuildIndex(): void {
    this.paths.clear();
    this.paths.set(0, "");
    const ws = this.fs.SearchPath(WORKSPACE);
    if (ws.id === -1) return;
    const walk = (id: number, rel: string): void => {
      this.paths.set(id, rel);
      const d = this.fs.inodes[id]?.direntries;
      if (!d) return;
      for (const [name, childId] of d) {
        if (name === "." || name === "..") continue;
        walk(childId, rel ? rel + "/" + name : name);
      }
    };
    walk(ws.id, WORKSPACE);
  }

  // ---- event coalescing + workspace filter ----
  private contractPath(fs9pPath: string): string | null {
    if (fs9pPath === WORKSPACE) return "/";
    if (fs9pPath.startsWith(WORKSPACE + "/")) {
      const rest = fs9pPath.slice(WORKSPACE.length + 1);
      const parts = rest.split("/");
      if (SKELETON_DIRS.includes(parts[0]!) ) return null; // bind-mount points are image-owned
      return "/" + rest;
    }
    return null; // sys-root / bind-mount writes — not the workspace
  }

  private record(fs9pPath: string, kind: ChangeKind): void {
    if (this.suppress) return;
    const cp = this.contractPath(fs9pPath);
    if (cp === null || cp === "/") return;
    // create beats modify; delete overrides a pending create/modify.
    const prev = this.pendingChanges.get(cp);
    if (kind === "delete") this.pendingChanges.set(cp, "delete");
    else if (prev === undefined) this.pendingChanges.set(cp, kind);
    else if (prev === "modify" && kind === "create") this.pendingChanges.set(cp, "create");
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), this.coalesceMs);
  }

  flush(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined; }
    const batch = [...this.pendingChanges.entries()];
    this.pendingChanges.clear();
    for (const [path, kind] of batch) this.emit({ type: "file.changed", path, kind });
  }

  /** Emit a page-side (contract-API) file.changed SYNCHRONOUSLY — NOT through
   *  the coalesce timer — so it lands within the caller's call (honors the
   *  contract's one-macrotask delivery bound; conformance's file.changed test
   *  does writeFile→writeFile→rm and waits for each event). `contractPath` is
   *  already "/x" form. Guest writes stay coalesced via record(); these don't. */
  private emitChange(contractPath: string, kind: ChangeKind): void {
    this.emit({ type: "file.changed", path: contractPath, kind });
  }

  /** Normalize a contract path to "/x" form (for events). */
  private cpath(path: string): string {
    return "/" + path.split("/").filter(Boolean).join("/");
  }

  // ---- async workspace FS (contract "/x" <-> fs9p "workspace/x") ----
  private ws(path: string): string {
    const norm = "/" + path.split("/").filter(Boolean).join("/");
    return norm === "/" ? WORKSPACE : WORKSPACE + norm;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const data = await this.fs.read_file(this.ws(path));
    if (data === null) throw new ErrnoError("ENOENT", { path, syscall: "open" });
    return data;
  }

  async writeFile(path: string, data: Uint8Array | string, _opts?: WriteFileOptions): Promise<void> {
    const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
    this.suppress++;
    try {
      const w = this.fs.SearchPath(this.ws(path));
      let idx: number;
      let kind: ChangeKind;
      if (w.id === -1) {
        if (w.parentid === -1) throw new ErrnoError("ENOENT", { path, syscall: "open" });
        idx = await this.fs.CreateBinaryFile(w.name, w.parentid, buf);
        kind = "create";
      } else {
        await this.fs.ChangeSize(w.id, buf.length);
        await this.fs.Write(w.id, 0, buf.length, buf);
        idx = w.id; kind = "modify";
      }
      const inode = this.fs.GetInode(idx); inode.mtime = Math.round(Date.now() / 1000); inode.qid.version++;
      this.paths.set(idx, this.ws(path));
      this.emitChange(this.cpath(path), kind); // synchronous — contract requires the event
    } finally { this.suppress--; }
    void _opts;
  }

  async readdir(path: string): Promise<FileEntry[]> {
    const w = this.fs.SearchPath(this.ws(path));
    if (w.id === -1) throw new ErrnoError("ENOENT", { path, syscall: "scandir" });
    const inode = this.fs.GetInode(w.id);
    if ((inode.mode & S_IFMT) !== S_IFDIR) throw new ErrnoError("ENOTDIR", { path, syscall: "scandir" });
    const out: FileEntry[] = [];
    for (const [name, childId] of inode.direntries ?? []) {
      if (name === "." || name === "..") continue;
      const m = this.fs.GetInode(childId).mode & S_IFMT;
      out.push({ name, type: m === S_IFDIR ? "directory" : m === S_IFLNK ? "symlink" : "file" });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async mkdir(path: string, opts?: MkdirOptions): Promise<void> {
    this.suppress++;
    try {
      const parts = ("/" + path.split("/").filter(Boolean).join("/")).split("/").filter(Boolean);
      let parentid = this.fs.SearchPath(WORKSPACE).id;
      for (let i = 0; i < parts.length; i++) {
        const existing = this.fs.Search(parentid, parts[i]!);
        if (existing !== -1) {
          if (i === parts.length - 1 && !opts?.recursive) throw new ErrnoError("EEXIST", { path, syscall: "mkdir" });
          parentid = existing;
        } else {
          if (i < parts.length - 1 && !opts?.recursive) throw new ErrnoError("ENOENT", { path, syscall: "mkdir" });
          const id = this.fs.CreateDirectory(parts[i]!, parentid);
          this.paths.set(id, WORKSPACE + "/" + parts.slice(0, i + 1).join("/"));
          this.emitChange("/" + parts.slice(0, i + 1).join("/"), "create"); // each newly-created dir
          parentid = id;
        }
      }
    } finally { this.suppress--; }
  }

  async rm(path: string, opts?: RmOptions): Promise<void> {
    this.suppress++;
    try {
      const w = this.fs.SearchPath(this.ws(path));
      if (w.id === -1) { if (opts?.force) return; throw new ErrnoError("ENOENT", { path, syscall: "unlink" }); }
      const inode = this.fs.GetInode(w.id);
      if ((inode.mode & S_IFMT) === S_IFDIR && inode.direntries) {
        const kids = [...inode.direntries.keys()].filter((k) => k !== "." && k !== "..");
        if (kids.length && !opts?.recursive) throw new ErrnoError("ENOTEMPTY", { path, syscall: "rmdir" });
        for (const k of kids) await this.rm(path.replace(/\/$/, "") + "/" + k, { recursive: true, force: true });
      }
      const ret = this.fs.Unlink(w.parentid, w.name);
      if (ret < 0 && !opts?.force) throw new ErrnoError("ENOENT", { path, syscall: "unlink" });
      this.paths.delete(w.id);
      this.emitChange(this.cpath(path), "delete");
    } finally { this.suppress--; }
  }

  async rename(from: string, to: string): Promise<void> {
    this.suppress++;
    try {
      const src = this.fs.SearchPath(this.ws(from));
      if (src.id === -1) throw new ErrnoError("ENOENT", { path: from, syscall: "rename" });
      const dst = this.fs.SearchPath(this.ws(to));
      const ret = await this.fs.Rename(src.parentid, src.name, dst.parentid, dst.name);
      if (ret < 0) throw new ErrnoError("ENOENT", { path: to, syscall: "rename" });
      this.rebuildIndex();
      this.emitChange(this.cpath(from), "delete");
      this.emitChange(this.cpath(to), "create");
    } finally { this.suppress--; }
  }

  async stat(path: string): Promise<Stat> {
    const w = this.fs.SearchPath(this.ws(path));
    if (w.id === -1) throw new ErrnoError("ENOENT", { path, syscall: "stat" });
    const inode = this.fs.GetInode(w.id);
    const m = inode.mode & S_IFMT;
    return {
      type: m === S_IFDIR ? "directory" : m === S_IFLNK ? "symlink" : "file",
      size: inode.size, mode: inode.mode & 0o7777,
      mtimeMs: inode.mtime * 1000, ctimeMs: inode.mtime * 1000, birthtimeMs: inode.mtime * 1000,
    };
  }
}
```

- [ ] **Step 4: Run to verify pass + commit**

Run: `pnpm vitest run packages/runtime-vm/src/fs-bridge.test.ts && pnpm typecheck`
Expected: PASS (3 tests), typecheck clean.

```bash
git add packages/runtime-vm/src/fs-bridge.ts packages/runtime-vm/src/fs-bridge.test.ts
git commit -m "feat(runtime-vm): fs9p bridge — wrap guest writes, coalesce+filter to workspace file.changed, async FS"
```

---

### Task 6: workspace snapshot — enumerate/restore the `/workspace` subtree ↔ contract `Snapshot`

`createSnapshot`/`restoreSnapshot` must be **workspace-scoped** (the 16-byte user tree, never the 37 MB Alpine). Serialize the `/workspace` subtree (excluding the skeleton mount points) into the contract's `Snapshot` shape; restore = clear the workspace (except skeleton) and rewrite. Pure over `Fs9p` + `Fs9pBridge` — unit-tested with the same fake fs9p.

**Files:**
- Create: `packages/runtime-vm/src/workspace-snapshot.ts`, `workspace-snapshot.test.ts`

**Interfaces:**
- Consumes: `Fs9p`, `WORKSPACE`, `SKELETON_DIRS` (Task 5); `Snapshot`, `SnapshotFsNode` (contract); `Fs9pBridge` for writes on restore.
- Produces:
  - `snapshotWorkspace(fs9p: Fs9p, clock: () => number): Promise<Snapshot>` — walks `workspace/`, skips `SKELETON_DIRS`, base64-encodes file bytes into a `SnapshotFsNode` tree.
  - `restoreWorkspace(fs9p: Fs9p, bridge: Fs9pBridge, snap: Snapshot): Promise<void>` — removes current non-skeleton workspace entries, then recreates the snapshot tree via `bridge.writeFile`/`bridge.mkdir` (so the path index stays correct).

- [ ] **Step 1: Write the failing test**

`packages/runtime-vm/src/workspace-snapshot.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { snapshotWorkspace, restoreWorkspace } from "./workspace-snapshot.js";
import { Fs9pBridge, WORKSPACE } from "./fs-bridge.js";
// reuse the fake from fs-bridge.test via a tiny local copy of makeFakeFs9p + bootWorkspace:
import { makeFakeFs9p, bootWorkspace } from "./test-support/fake-fs9p.js";

describe("workspace snapshot", () => {
  it("captures only the user files (not skeleton dirs), restores exactly", async () => {
    const fs = makeFakeFs9p(); bootWorkspace(fs);
    const bridge = new Fs9pBridge(fs, () => {}); bridge.attach();
    await bridge.mkdir("/sub", { recursive: true });
    await bridge.writeFile("/a.txt", "one");
    await bridge.writeFile("/sub/b.txt", "two");

    const snap = await snapshotWorkspace(fs, () => 0);
    // skeleton dirs (bin/lib/usr/proc/dev/tmp) excluded; only a.txt + sub/b.txt
    const top = snap.fs.type === "directory" ? Object.keys(snap.fs.children) : [];
    expect(top.sort()).toEqual(["a.txt", "sub"]);

    // mutate then restore
    await bridge.writeFile("/a.txt", "changed");
    await bridge.writeFile("/added.txt", "new");
    await restoreWorkspace(fs, bridge, snap);
    expect(new TextDecoder().decode(await bridge.readFile("/a.txt"))).toBe("one");
    await expect(bridge.readFile("/added.txt")).rejects.toThrow(/ENOENT/);
    expect(new TextDecoder().decode(await bridge.readFile("/sub/b.txt"))).toBe("two");
  });
});
```

Also create the shared fake at `packages/runtime-vm/src/test-support/fake-fs9p.ts` by extracting `makeFakeFs9p` + `bootWorkspace` from Task 5's test (move them there and have `fs-bridge.test.ts` import from it too, so the fake is defined once).

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/runtime-vm/src/workspace-snapshot.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`packages/runtime-vm/src/workspace-snapshot.ts`:

```ts
import type { Snapshot, SnapshotFsNode } from "@erdou/runtime-contract";
import { Fs9pBridge, WORKSPACE, SKELETON_DIRS, type Fs9p } from "./fs-bridge.js";

const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFLNK = 0o120000;
const toB64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");

/** Serialize the /workspace subtree (minus skeleton mount points) to a contract Snapshot. */
export async function snapshotWorkspace(fs9p: Fs9p, clock: () => number): Promise<Snapshot> {
  const ws = fs9p.SearchPath(WORKSPACE);
  if (ws.id === -1) throw new Error("snapshotWorkspace: no /workspace");
  const build = async (id: number, atRoot: boolean): Promise<SnapshotFsNode> => {
    const inode = fs9p.GetInode(id);
    const m = inode.mode & S_IFMT;
    if (m === S_IFDIR) {
      const children: Record<string, SnapshotFsNode> = {};
      for (const [name, childId] of inode.direntries ?? []) {
        if (name === "." || name === "..") continue;
        if (atRoot && SKELETON_DIRS.includes(name)) continue; // image-owned mount points
        children[name] = await build(childId, false);
      }
      return { type: "directory", mode: inode.mode & 0o7777, children };
    }
    if (m === S_IFLNK) return { type: "symlink", mode: inode.mode & 0o7777, target: inode.symlink ?? "" };
    const path = pathOf(fs9p, id);
    const data = (await fs9p.read_file(path)) ?? new Uint8Array(0);
    return { type: "file", mode: inode.mode & 0o7777, data: toB64(data) };
  };
  return { version: 1, createdAtMs: clock(), fs: await build(ws.id, true) };
}

/** Recompute a fs9p path for an inode by walking from the workspace root. */
function pathOf(fs9p: Fs9p, target: number): string {
  const ws = fs9p.SearchPath(WORKSPACE).id;
  let found = "";
  const walk = (id: number, rel: string): boolean => {
    if (id === target) { found = rel; return true; }
    for (const [name, childId] of fs9p.GetInode(id).direntries ?? []) {
      if (name === "." || name === "..") continue;
      if (walk(childId, rel + "/" + name)) return true;
    }
    return false;
  };
  walk(ws, WORKSPACE);
  return found;
}

/** Clear the workspace (except skeleton) and rewrite the snapshot via the bridge. */
export async function restoreWorkspace(fs9p: Fs9p, bridge: Fs9pBridge, snap: Snapshot): Promise<void> {
  const wsId = fs9p.SearchPath(WORKSPACE).id;
  const top = fs9p.GetInode(wsId).direntries;
  if (top) {
    for (const name of [...top.keys()]) {
      if (name === "." || name === ".." || SKELETON_DIRS.includes(name)) continue;
      await bridge.rm("/" + name, { recursive: true, force: true });
    }
  }
  if (snap.fs.type !== "directory") return;
  const write = async (node: SnapshotFsNode, prefix: string): Promise<void> => {
    if (node.type === "directory") {
      if (prefix !== "") await bridge.mkdir(prefix, { recursive: true });
      for (const [name, child] of Object.entries(node.children)) await write(child, prefix + "/" + name);
    } else if (node.type === "file") {
      await bridge.writeFile(prefix, Uint8Array.from(Buffer.from(node.data, "base64")));
    }
    // symlinks in the workspace snapshot are rare; skip for the MVP (bridge has no symlink write yet).
  };
  await write(snap.fs, "");
}
```

- [ ] **Step 4: Run to verify pass + commit**

Run: `pnpm vitest run packages/runtime-vm/src/workspace-snapshot.test.ts packages/runtime-vm/src/fs-bridge.test.ts`
Expected: PASS (both — the fake was moved to test-support and both import it).

```bash
git add packages/runtime-vm/src/workspace-snapshot.ts packages/runtime-vm/src/workspace-snapshot.test.ts packages/runtime-vm/src/test-support/fake-fs9p.ts packages/runtime-vm/src/fs-bridge.test.ts
git commit -m "feat(runtime-vm): workspace-scoped snapshot (excludes skeleton + sys-root) + restore via the bridge"
```

---

### Task 7: v86 host wrapper + symbol guard

`v86-host.ts` is the ONLY file that touches the untyped `v86` package. It constructs the emulator from a saved state, exposes `fs9p`, a `GuestChannel` over `/dev/hvc0`, `saveState`/`restoreState`/`destroy`, and — critically — a **startup symbol guard** that fail-fasts if a v86 upgrade renamed any method the bridge depends on. The symbol guard is testable **without** the baked asset (construct an empty `new V86({...})` and assert the symbols), which is what this task's hermetic-ish test does; a full boot-from-state is exercised in Task 9.

**Files:**
- Create: `packages/runtime-vm/src/v86-host.ts`, `v86-host.symbols.test.ts`

**Interfaces:**
- Consumes: `v86` (npm), `GuestChannel` (Task 4), `Fs9p` (Task 5).
- Produces:
  - `interface V86Assets { biosPath: string; vgaBiosPath: string; kernelPath: string; statePath?: string; memoryMB: number }`
  - `assertFs9pSymbols(fs9p: unknown): void` — throws with a clear message if any required method is missing.
  - `class V86Host` constructed with `(assets: V86Assets)`:
    - `boot(): Promise<void>` — constructs V86 (`virtio_console: true`, `initial_state` if `statePath`), runs the symbol guard, resolves when `emulator-ready` fired.
    - `readonly fs9p: Fs9p`
    - `channel(): GuestChannel` — over `virtio-console0-input-bytes` / `virtio-console0-output-bytes`.
    - `serial(): { send(s: string): void; onByte(cb: (b: number) => void): void }` — for the bake script's setup commands.
    - `run(): void` (start CPU), `saveState(): Promise<Uint8Array>`, `restoreState(buf: Uint8Array): Promise<void>`, `destroy(): Promise<void>`.

- [ ] **Step 1: Write the symbol-guard test (no baked asset needed)**

`packages/runtime-vm/src/v86-host.symbols.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { assertFs9pSymbols } from "./v86-host.js";

describe("assertFs9pSymbols", () => {
  it("passes on an object with all required fs9p methods", () => {
    const ok: Record<string, unknown> = { inodes: [] };
    for (const m of ["GetInode", "CreateFile", "CreateDirectory", "CreateSymlink", "CreateBinaryFile", "Write", "ChangeSize", "Unlink", "Rename", "Search", "SearchPath", "GetFullPath", "read_file"]) ok[m] = () => {};
    expect(() => assertFs9pSymbols(ok)).not.toThrow();
  });

  it("throws a clear error naming the missing method", () => {
    const bad: Record<string, unknown> = { inodes: [], CreateFile: () => {} };
    expect(() => assertFs9pSymbols(bad)).toThrow(/fs9p.*missing.*(SearchPath|CreateDirectory)/);
  });
});
```

> Optionally, add a SECOND gated test in this file that constructs a real empty `new V86({ filesystem: {}, autostart: false, bios, vga_bios, bzimage })` and asserts `assertFs9pSymbols(emulator.fs9p)` passes — gate it `describe.skipIf(!assetsPresent())` (needs the kernel/bios from `download-assets`, no network at test time). This catches a v86 upgrade in CI once assets are cached. Keep it optional; the hermetic test above is the required one.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/runtime-vm/src/v86-host.symbols.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `v86-host.ts`**

`packages/runtime-vm/src/v86-host.ts`:

```ts
import { readFile } from "node:fs/promises";
// v86 ships an ESM build; the constructor is exported as `V86`.
// @ts-expect-error — v86 has no bundled types.
import { V86 } from "v86";
import type { GuestChannel } from "./guestd-client.js";
import type { Fs9p } from "./fs-bridge.js";

export interface V86Assets {
  biosPath: string;
  vgaBiosPath: string;
  kernelPath: string;
  statePath?: string;
  memoryMB: number;
}

const REQUIRED_FS9P = [
  "GetInode", "CreateFile", "CreateDirectory", "CreateSymlink", "CreateBinaryFile",
  "Write", "ChangeSize", "Unlink", "Rename", "Search", "SearchPath", "GetFullPath", "read_file",
] as const;

/** Fail-fast if a v86 upgrade renamed a method the fs-bridge depends on. */
export function assertFs9pSymbols(fs9p: unknown): void {
  const o = fs9p as Record<string, unknown> | null;
  if (!o || !Array.isArray((o as { inodes?: unknown }).inodes)) {
    throw new Error("v86 fs9p missing or has no `inodes` array — construct V86 with `filesystem: {}`");
  }
  const missing = REQUIRED_FS9P.filter((m) => typeof o[m] !== "function");
  if (missing.length) throw new Error(`v86 fs9p missing required method(s): ${missing.join(", ")} — v86 upgrade may have renamed them`);
}

export class V86Host {
  private emulator: any;
  readonly fs9p!: Fs9p; // set after boot (declared for the type; assigned in boot)

  constructor(private readonly assets: V86Assets) {}

  async boot(): Promise<void> {
    const [bios, vga, kernel, state] = await Promise.all([
      readFile(this.assets.biosPath),
      readFile(this.assets.vgaBiosPath),
      readFile(this.assets.kernelPath),
      this.assets.statePath ? readFile(this.assets.statePath) : Promise.resolve(undefined),
    ]);
    // EXACT ArrayBuffer — a Node Buffer may be a view into a pooled ArrayBuffer
    // at a non-zero byteOffset; `.buffer` would hand v86 wrong bytes. Copy into
    // a fresh 0-offset buffer.
    const ab = (b: Buffer): ArrayBuffer => new Uint8Array(b).buffer;
    const opts: Record<string, unknown> = {
      bios: { buffer: ab(bios) },
      vga_bios: { buffer: ab(vga) },
      bzimage: { buffer: ab(kernel) },
      memory_size: this.assets.memoryMB * 1024 * 1024,
      filesystem: {},
      virtio_console: true,
      autostart: false,
      disable_keyboard: true,
      cmdline: "console=ttyS0 tsc=reliable mitigations=off random.trust_cpu=on",
    };
    if (state) opts.initial_state = { buffer: ab(state) };
    this.emulator = new V86(opts);
    await new Promise<void>((resolve) => this.emulator.add_listener("emulator-ready", () => resolve()));
    assertFs9pSymbols(this.emulator.fs9p);
    (this as { fs9p: Fs9p }).fs9p = this.emulator.fs9p as Fs9p;
  }

  run(): void { this.emulator.run(); }

  channel(): GuestChannel {
    return {
      send: (bytes: Uint8Array) => this.emulator.bus.send("virtio-console0-input-bytes", bytes),
      subscribe: (cb: (bytes: Uint8Array) => void) => this.emulator.add_listener("virtio-console0-output-bytes", cb),
    };
  }

  serial(): { send(s: string): void; onByte(cb: (b: number) => void): void } {
    return {
      send: (s: string) => this.emulator.serial0_send(s),
      onByte: (cb: (b: number) => void) => this.emulator.add_listener("serial0-output-byte", cb),
    };
  }

  async saveState(): Promise<Uint8Array> {
    return new Uint8Array(await this.emulator.save_state());
  }

  async restoreState(buf: Uint8Array): Promise<void> {
    // Pass the view, not buf.buffer — v86 does `new Uint8Array(state)` and a
    // subarray/oversized backing buffer would append trailing garbage.
    await this.emulator.restore_state(buf);
  }

  async destroy(): Promise<void> {
    await this.emulator.destroy();
  }
}
```

- [ ] **Step 4: Run to verify pass + gates + commit**

Run: `pnpm vitest run packages/runtime-vm/src/v86-host.symbols.test.ts && pnpm typecheck && pnpm lint:deps`
Expected: PASS (2 tests); typecheck clean (the `@ts-expect-error` swallows v86's missing types); lint:deps clean.

```bash
git add packages/runtime-vm/src/v86-host.ts packages/runtime-vm/src/v86-host.symbols.test.ts
git commit -m "feat(runtime-vm): typed v86 host wrapper + fail-fast fs9p symbol guard"
```

---

### Task 8: bake pipeline + asset management

Two Node scripts + committed metadata that produce the gitignored boot assets. `download-assets.mjs` fetches the pinned kernel/BIOS. `bake-image.mjs` runs the full verified pipeline (Alpine deps → rootfs → split FS → boot → guest chroot/bind setup → resident guestd → `save_state`) and writes `assets/state.zst`. Ported directly from the three spikes' verified scripts.

**Files:**
- Create: `packages/runtime-vm/assets/.gitignore`, `assets/manifest.json`
- Create: `packages/runtime-vm/scripts/download-assets.mjs`
- Create: `packages/runtime-vm/scripts/bake-image.mjs`
- Create: `packages/runtime-vm/scripts/lib/apk.mjs` (dep resolution + apk download/extract — ported from Spike B `resolve-deps.mjs` + `install-pkgs.mjs`)
- Create: `packages/runtime-vm/scripts/lib/preload.mjs` (`setupSplitFs`, `SKELETON_DIRS`, `GUEST_SETUP_CMD`, `REMOUNT_RO_CMD` — ported from Spike C `setup-split.mjs`)

**Interfaces:**
- Produces: `packages/runtime-vm/assets/state.zst` (gitignored) + `assets/{seabios.bin,vgabios.bin,kernel.bin}` (gitignored). `assets/manifest.json` is committed and drives `download-assets`.
- Consumed by: Task 9's conformance harness (which loads these assets to boot `VmRuntime`).

- [ ] **Step 1: Asset gitignore + manifest**

`packages/runtime-vm/assets/.gitignore`:

```
*
!.gitignore
!manifest.json
```

`packages/runtime-vm/assets/manifest.json` (pin the exact versions verified by the spikes; the URLs are the ones the spikes fetched — a bake fetches Alpine at build time, so `alpine` here is a version record, and `kernel`/`bios` are the v86 boot blobs):

```json
{
  "note": "Pinned inputs for `pnpm --filter @erdou/runtime-vm download-assets` and `bake`. These produce gitignored artifacts in this dir; nothing binary is committed.",
  "alpine": { "version": "3.24.1", "arch": "x86", "minirootfs": "alpine-minirootfs-3.24.1-x86.tar.gz", "cdn": "https://dl-cdn.alpinelinux.org/alpine" },
  "kernel": { "file": "kernel.bin", "source": "v86 buildroot bzImage (9p+virtio); pin the exact copy your bake was verified against", "sha256": "<fill-from-download>" },
  "bios": { "seabios": "seabios.bin", "vgabios": "vgabios.bin", "source": "v86 build assets" },
  "guestd": { "path": "src/guest/guestd.py" },
  "memoryMB": 512
}
```

> The kernel + BIOS blobs are the ones the spikes used (`buildroot-bzimage68.bin`, `seabios.bin`, `vgabios.bin`, available in the v86 project's build assets). `download-assets.mjs` fetches them from a pinned location the implementer sets (a release URL or a vendored copy); record the sha256 in the manifest on first download. If no stable public URL is available, vendor the three blobs into a release attachment or the team's asset store and point the manifest there — do NOT commit them to git.

- [ ] **Step 2: `scripts/lib/apk.mjs` — Alpine dep resolution + install (ported from Spike B, verified)**

```js
// Resolve python3's transitive deps from APKINDEX and extract the .apk payloads
// into a rootfs dir. Verified in Spike B (18 packages, python3 -> 42).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";

export async function fetchBuf(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** Parse APKINDEX.tar.gz into a list of {name, version, provides[], depends[], apk}. */
export async function parseApkIndex(indexBuf, tmpDir) {
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "APKINDEX.tar.gz"), indexBuf);
  execFileSync("tar", ["-xzf", "APKINDEX.tar.gz", "APKINDEX"], { cwd: tmpDir });
  const text = fs.readFileSync(path.join(tmpDir, "APKINDEX"), "utf8");
  const pkgs = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    const f = {};
    for (const line of block.split("\n")) { const k = line[0]; f[k] = (f[k] ? f[k] + "\n" : "") + line.slice(2); }
    if (!f.P) continue;
    pkgs.push({
      name: f.P, version: f.V,
      provides: (f.p ? f.p.split(" ") : []).map((s) => s.split(/[=<>]/)[0]),
      depends: (f.D ? f.D.split(" ") : []).filter((d) => !d.startsWith("!")).map((s) => s.replace(/^!/, "").split(/[=<>]/)[0]),
      apk: `${f.P}-${f.V}.apk`,
    });
  }
  return pkgs;
}

/** Resolve `root` + transitive deps against the provides map (so:… and bare names). */
export function resolve(pkgs, roots) {
  const byProvide = new Map();
  for (const p of pkgs) { byProvide.set(p.name, p); for (const pr of p.provides) if (!byProvide.has(pr)) byProvide.set(pr, p); }
  const order = [], seen = new Set(), missing = [];
  const visit = (dep) => {
    const p = byProvide.get(dep) ?? byProvide.get(dep.replace(/^so:/, "").replace(/^cmd:/, ""));
    if (!p) { if (!/^\/|^so:libc/.test(dep)) missing.push(dep); return; }
    if (seen.has(p.name)) return;
    seen.add(p.name);
    for (const d of p.depends) visit(d);
    order.push(p);
  };
  for (const r of roots) visit(r);
  return { order, missing };
}

/** Download + extract each .apk payload into rootfsDir (skips control dotfiles). */
export async function installApks(order, repoUrl, rootfsDir, tmpDir) {
  fs.mkdirSync(rootfsDir, { recursive: true });
  for (const p of order) {
    const buf = await fetchBuf(`${repoUrl}/${p.apk}`);
    const apkPath = path.join(tmpDir, p.apk);
    fs.writeFileSync(apkPath, buf);
    // an apk is a gzip'd tar; extract the payload, skip .PKGINFO/.SIGN.* and xattr keyword warnings
    execFileSync("tar", ["-xzf", apkPath, "-C", rootfsDir, "--exclude=.*", "--warning=no-unknown-keyword"], { stdio: "ignore" });
  }
}

export function unpackMinirootfs(buf, rootfsDir, tmpDir) {
  fs.mkdirSync(rootfsDir, { recursive: true });
  const p = path.join(tmpDir, "minirootfs.tar.gz");
  fs.writeFileSync(p, buf);
  execFileSync("tar", ["-xzf", p, "-C", rootfsDir], { stdio: "ignore" });
}
```

- [ ] **Step 3: `scripts/lib/preload.mjs` — split-FS builder + guest setup strings (ported from Spike C, verified)**

```js
// Populate ONE fs9p export with /sys-root (Alpine) + /workspace (empty + skeleton).
// create_file() is useless (mode 0666, no dirs/symlinks) — drive fs9p directly.
import fs from "node:fs";
import path from "node:path";

export const SKELETON_DIRS = ["bin", "lib", "usr", "proc", "dev", "tmp"];

async function walk(fs9p, localDir, parentId, stats) {
  for (const entry of fs.readdirSync(localDir, { withFileTypes: true })) {
    const full = path.join(localDir, entry.name);
    if (entry.isDirectory()) {
      const st = fs.lstatSync(full);
      const id = fs9p.CreateDirectory(entry.name, parentId);
      fs9p.inodes[id].mode = (st.mode & 0o7777) | 0o040000; stats.dirs++;
      await walk(fs9p, full, id, stats);
    } else if (entry.isSymbolicLink()) {
      fs9p.CreateSymlink(entry.name, parentId, fs.readlinkSync(full)); stats.symlinks++;
    } else if (entry.isFile()) {
      const data = fs.readFileSync(full); const st = fs.lstatSync(full);
      const id = await fs9p.CreateBinaryFile(entry.name, parentId, new Uint8Array(data));
      fs9p.inodes[id].mode = (st.mode & 0o7777) | 0o100000; stats.files++; stats.bytes += data.length;
    }
  }
}

/** Build sys-root (from rootfsDir) + workspace + skeleton; copy guestd.py into sys-root. */
export async function setupSplitFs(fs9p, rootfsDir, guestdSrcPath) {
  const stats = { dirs: 0, files: 0, symlinks: 0, bytes: 0 };
  const sysId = fs9p.CreateDirectory("sys-root", 0); fs9p.inodes[sysId].mode = 0o040755;
  await walk(fs9p, rootfsDir, sysId, stats);
  // guestd at sys-root/usr/lib/erdou/guestd.py (visible via the /usr bind, no workspace pollution)
  const usrId = fs9p.Search(sysId, "usr");
  const libId = fs9p.Search(usrId, "lib");
  const erdouId = fs9p.CreateDirectory("erdou", libId); fs9p.inodes[erdouId].mode = 0o040755;
  const gd = fs.readFileSync(guestdSrcPath);
  const gid = await fs9p.CreateBinaryFile("guestd.py", erdouId, new Uint8Array(gd));
  fs9p.inodes[gid].mode = 0o100755;
  const wsId = fs9p.CreateDirectory("workspace", 0); fs9p.inodes[wsId].mode = 0o040755;
  for (const d of SKELETON_DIRS) { const id = fs9p.CreateDirectory(d, wsId); fs9p.inodes[id].mode = 0o040755; }
  return stats;
}

// The exact verified guest-side setup (busybox ash; failure markers quote-split
// because the guest tty echoes the typed command — Spike C gotcha).
export const GUEST_SETUP_CMD =
  "for d in bin lib usr; do mount -o bind /mnt/sys-root/$d /mnt/workspace/$d || echo BINDF''AIL_$d; done; " +
  "mount -t proc proc /mnt/workspace/proc; mount -o bind /dev /mnt/workspace/dev; mount -t tmpfs tmpfs /mnt/workspace/tmp";
export const PYCACHE_WARMUP_CMD =
  "chroot /mnt/workspace /usr/bin/python3 -c 'import subprocess, tty, termios, json, struct, threading, signal, shutil' 2>/dev/null; echo WARMED";
export const REMOUNT_RO_CMD =
  "for d in bin lib usr; do mount -o remount,ro,bind /mnt/workspace/$d || echo ROF''AIL_$d; done; echo ROREADY";
export const LAUNCH_GUESTD_CMD =
  "chroot /mnt/workspace /usr/bin/python3 /usr/lib/erdou/guestd.py </dev/null >/tmp/gd.log 2>&1 & echo GDLAUNCHED";
```

- [ ] **Step 4: `scripts/download-assets.mjs`**

```js
// Fetch the pinned kernel + BIOS blobs into assets/ (gitignored). Reads
// assets/manifest.json for the source locations; verifies sha256 when present.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, "..", "assets");
const manifest = JSON.parse(fs.readFileSync(path.join(assets, "manifest.json"), "utf8"));

async function get(url, dest, sha256) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (sha256 && sha256 !== "<fill-from-download>") {
    const got = crypto.createHash("sha256").update(buf).digest("hex");
    if (got !== sha256) throw new Error(`sha256 mismatch for ${dest}: expected ${sha256}, got ${got}`);
  }
  fs.writeFileSync(dest, buf);
  console.log(`wrote ${dest} (${buf.length} bytes)`);
}

// NOTE: set manifest.kernel.url / manifest.bios.*.url to the pinned source your
// bake was verified against (a release attachment or the team asset store).
const kernelUrl = manifest.kernel.url;
const seabiosUrl = manifest.bios.seabiosUrl;
const vgabiosUrl = manifest.bios.vgabiosUrl;
if (!kernelUrl || !seabiosUrl || !vgabiosUrl) {
  throw new Error("assets/manifest.json needs kernel.url + bios.seabiosUrl + bios.vgabiosUrl (pin your sources)");
}
await get(kernelUrl, path.join(assets, "kernel.bin"), manifest.kernel.sha256);
await get(seabiosUrl, path.join(assets, "seabios.bin"));
await get(vgabiosUrl, path.join(assets, "vgabios.bin"));
console.log("assets ready");
```

- [ ] **Step 5: `scripts/bake-image.mjs` — the full verified pipeline**

```js
// Bake the self-contained Alpine machine state. Verified end-to-end across
// Spikes A/B/C. Run: `pnpm --filter @erdou/runtime-vm bake` (needs network for
// Alpine + the assets from download-assets). Produces assets/state.zst.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
// @ts-ignore
import { V86 } from "v86";
import { fetchBuf, parseApkIndex, resolve, installApks, unpackMinirootfs } from "./lib/apk.mjs";
import { setupSplitFs, GUEST_SETUP_CMD, PYCACHE_WARMUP_CMD, REMOUNT_RO_CMD, LAUNCH_GUESTD_CMD } from "./lib/preload.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, "..", "assets");
const tmp = path.join(here, "..", ".bake-tmp");
const rootfs = path.join(tmp, "rootfs");
fs.mkdirSync(tmp, { recursive: true });

const m = JSON.parse(fs.readFileSync(path.join(assets, "manifest.json"), "utf8"));
const cdn = m.alpine.cdn, ver = m.alpine.version, arch = m.alpine.arch;
const branch = "v" + ver.split(".").slice(0, 2).join(".");
const mainRepo = `${cdn}/${branch}/main/${arch}`;

console.log("1/6 fetch minirootfs + APKINDEX");
const releasesBase = `${cdn}/${branch}/releases/${arch}`;
const mini = await fetchBuf(`${releasesBase}/${m.alpine.minirootfs}`);
unpackMinirootfs(mini, rootfs, tmp);
const idx = await parseApkIndex(await fetchBuf(`${mainRepo}/APKINDEX.tar.gz`), tmp);
// python3 may pull community deps too; fetch community APKINDEX if a dep is missing from main
const { order, missing } = resolve(idx, ["python3"]);
if (missing.length) console.warn("unresolved (assumed provided by base):", missing);

console.log(`2/6 install ${order.length} apks`);
await installApks(order, mainRepo, rootfs, tmp);

console.log("3/6 boot buildroot + preload split FS");
// EXACT ArrayBuffer: Node's readFileSync may return a POOLED Buffer at a
// non-zero byteOffset for small files (<4 KB), so `.buffer` would hand v86 the
// wrong bytes with no error. new Uint8Array(buf) copies into a fresh 0-offset
// ArrayBuffer. (Verified-spike form was { url }; this is the buffer equivalent.)
const ab = (p) => new Uint8Array(fs.readFileSync(p)).buffer;
const emulator = new V86({
  bios: { buffer: ab(path.join(assets, "seabios.bin")) },
  vga_bios: { buffer: ab(path.join(assets, "vgabios.bin")) },
  bzimage: { buffer: ab(path.join(assets, "kernel.bin")) },
  memory_size: m.memoryMB * 1024 * 1024,
  filesystem: {},
  virtio_console: true,
  autostart: false,
  disable_keyboard: true,
  cmdline: "console=ttyS0 tsc=reliable mitigations=off random.trust_cpu=on",
});
await new Promise((r) => emulator.add_listener("emulator-ready", r));
await setupSplitFs(emulator.fs9p, rootfs, path.join(here, "..", "src", "guest", "guestd.py"));
emulator.run();

console.log("4/6 drive guest chroot/bind setup over serial");
let sbuf = "";
const serialWait = (marker, timeoutMs = 120000) => new Promise((resolve, reject) => {
  const start = sbuf.length;
  const to = setTimeout(() => reject(new Error(`serial timeout waiting for ${marker}; tail=${JSON.stringify(sbuf.slice(-300))}`)), timeoutMs);
  const check = () => { if (sbuf.slice(start).includes(marker)) { clearTimeout(to); resolve(); } };
  emulator.add_listener("serial0-output-byte", (b) => { sbuf += String.fromCharCode(b); check(); });
  check();
});
await serialWait("~% ");                       // buildroot prompt (9p auto-mounted at /mnt via fstab)
const sh = (cmd, marker, t) => { emulator.serial0_send(cmd + "\n"); return serialWait(marker, t); };
await sh(GUEST_SETUP_CMD + "; echo SETUPDONE", "SETUPDONE");
await sh(PYCACHE_WARMUP_CMD, "WARMED");         // warm pycache into sys-root (rw) once
await sh(REMOUNT_RO_CMD, "ROREADY");            // freeze system view read-only
await sh(LAUNCH_GUESTD_CMD, "GDLAUNCHED");      // resident guestd inside the workspace chroot
await new Promise((r) => setTimeout(r, 1500));  // let guestd reach its read loop

console.log("5/6 save_state (self-contained: 9p FS rides inside)");
const state = new Uint8Array(await emulator.save_state());
await emulator.destroy();

console.log("6/6 zstd-compress → assets/state.zst");
// gzip is fine for the MVP if zstd bindings aren't present; keep the extension honest.
const compressed = zlib.gzipSync(state, { level: 9 });
fs.writeFileSync(path.join(assets, "state.zst"), compressed);
fs.writeFileSync(path.join(assets, "state.meta.json"), JSON.stringify({ rawBytes: state.length, compressedBytes: compressed.length, alpine: ver, codec: "gzip" }, null, 2));
console.log(`done: state ${state.length} -> ${compressed.length} bytes (assets/state.zst)`);
process.exit(0);
```

> The bake decompresses `state.zst` at runtime (Task 9 / Task 7 load path reads it). Codec is recorded in `state.meta.json`; the MVP uses gzip (Node built-in) — swap to real zstd later without changing the interface. `.bake-tmp/` is gitignored (add it to the package `.gitignore` or the repo root's).

- [ ] **Step 6: Run the bake once (produces the gated asset) + commit the scripts**

Run: `pnpm --filter @erdou/runtime-vm download-assets` (after pinning URLs in the manifest), then `pnpm --filter @erdou/runtime-vm bake`.
Expected: `assets/state.zst` + `assets/state.meta.json` written; console shows `python3` deps installed, guest setup markers, and the final state size (~30–40 MB compressed). This is the verification that the pipeline works end-to-end (it reproduces Spikes B+C).

> If `download-assets` has no pinned URL yet, copy the three verified blobs from the spike dir manually into `assets/` for the first bake, and record their sha256 in the manifest — the point of this step is a working `state.zst`, and the manifest documents how to regenerate it.

```bash
git add packages/runtime-vm/assets/.gitignore packages/runtime-vm/assets/manifest.json packages/runtime-vm/scripts
# (assets/state.zst, kernel.bin, seabios.bin, vgabios.bin, .bake-tmp are gitignored — verify `git status` shows none of them)
git commit -m "feat(runtime-vm): bake pipeline — Alpine apk install + split-FS + resident guestd → self-contained state.zst"
```

---

### Task 9: VmRuntime composition + gated conformance harness (THE integration deliverable)

Wire everything into `VmRuntime` and prove it satisfies the shared contract by running `runConformance` against a real booted guest. This is where `guestd.py`, `v86-host`, the fs-bridge, and the snapshot all get exercised together against the live Alpine guest. The suite is **gated** on the baked asset + `ERDOU_VM_E2E=1` so the default `pnpm test` stays hermetic.

**Files:**
- Modify: `packages/runtime-vm/src/vm-runtime.ts` (replace the stub)
- Create: `packages/runtime-vm/src/vm-runtime.conformance.test.ts`
- Create: `packages/runtime-vm/src/assets.ts` (locate assets + presence check)

**Interfaces:**
- Consumes: `V86Host` (7), `Fs9pBridge` (5), `GuestdClient` (4), `PortRegistry` (2), `snapshotWorkspace`/`restoreWorkspace` (6), `vmCapabilities` (2).
- Produces: a complete `VmRuntime` implementing `Runtime`; `assetsPresent(): boolean` and `defaultAssets(): V86Assets` in `assets.ts`.

- [ ] **Step 1: Implement `assets.ts`**

`packages/runtime-vm/src/assets.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { V86Assets } from "./v86-host.js";

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
const files = ["kernel.bin", "seabios.bin", "vgabios.bin", "state.zst"];

export function assetsPresent(): boolean {
  return files.every((f) => existsSync(join(assetsDir, f)));
}

/** Decompress state.zst to a sibling state.bin path v86 can load, then return the asset paths. */
export function defaultAssets(): V86Assets {
  const statePath = join(assetsDir, "state.bin");
  if (!existsSync(statePath)) {
    const meta = JSON.parse(readFileSync(join(assetsDir, "state.meta.json"), "utf8")) as { codec: string };
    if (meta.codec !== "gzip") throw new Error(`unknown state codec ${meta.codec}`);
    require("node:fs").writeFileSync(statePath, gunzipSync(readFileSync(join(assetsDir, "state.zst"))));
  }
  return {
    biosPath: join(assetsDir, "seabios.bin"),
    vgaBiosPath: join(assetsDir, "vgabios.bin"),
    kernelPath: join(assetsDir, "kernel.bin"),
    statePath,
    memoryMB: 512,
  };
}
```

> `require` in ESM: replace with a top `import { writeFileSync } from "node:fs"` and call `writeFileSync(...)`. (Use the import; the `require` above is shorthand — the implementer wires the import.)

- [ ] **Step 2: Replace the `VmRuntime` stub with the real composition**

`packages/runtime-vm/src/vm-runtime.ts`:

```ts
import { ErrnoError } from "@erdou/runtime-contract";
import type {
  Runtime, SpawnOptions, ProcessHandle, ProcessInfo, ExitStatus, Signal,
  Stat, FileEntry, WriteFileOptions, MkdirOptions, RmOptions,
  RuntimeCapabilities, RuntimeEvent, RuntimeEventListener, Unsubscribe, Snapshot,
  VirtualPort, HttpRequest, HttpResponse,
} from "@erdou/runtime-contract";
import { V86Host, type V86Assets } from "./v86-host.js";
import { Fs9pBridge } from "./fs-bridge.js";
import { GuestdClient, type GuestProcess } from "./guestd-client.js";
import { PortRegistry } from "./port-registry.js";
import { snapshotWorkspace, restoreWorkspace } from "./workspace-snapshot.js";
import { vmCapabilities } from "./capabilities.js";

const SIG = (s?: Signal): string => s ?? "SIGTERM";

/** A retained runtime-side process record (survives exit). */
interface ProcRecord {
  pid: number;
  cmd: string;
  args: string[];
  proc: GuestProcess;
  state: "running" | "exited" | "killed";
  status: ExitStatus | null;
  waited: Promise<ExitStatus>;
}

export class VmRuntime implements Runtime {
  private host: V86Host;
  private bridge!: Fs9pBridge;
  private guestd!: GuestdClient;
  private ports!: PortRegistry;
  private readonly listeners = new Set<RuntimeEventListener>();
  // Retained per pid — kept AFTER exit (unlike guestd.ps(), which only lists
  // live /proc) so wait()/kill()/getProcesses() honor the contract for an
  // already-exited process. BrowserRuntime's process table never deletes
  // records either; VmRuntime must match.
  private readonly procs = new Map<number, ProcRecord>();
  private readonly clock: () => number;
  private booted = false;

  constructor(assets: V86Assets, opts: { clock?: () => number } = {}) {
    this.host = new V86Host(assets);
    this.clock = opts.clock ?? (() => Date.now());
  }

  private emit(e: RuntimeEvent): void { for (const l of this.listeners) { try { l(e); } catch (err) { console.error("VmRuntime listener threw:", err); } } }

  async boot(): Promise<void> {
    if (this.booted) return;
    await this.host.boot();
    this.ports = new PortRegistry((e) => this.emit(e));
    this.bridge = new Fs9pBridge(this.host.fs9p, (e) => this.emit(e));
    this.bridge.attach();          // wraps fs9p + builds the workspace path index from the restored state
    this.host.run();               // resume the CPU from the baked state (guestd is already resident)
    this.guestd = new GuestdClient(this.host.channel());
    await this.guestd.ready();      // first hvc0 frame is the kick; guestd replies READY
    this.booted = true;
  }

  async shutdown(): Promise<void> { await this.host.destroy(); }

  // ---- process (guestd) ----
  private track(p: GuestProcess, cmd: string, args: string[]): ProcessHandle {
    const rec: ProcRecord = { pid: p.pid, cmd, args, proc: p, state: "running", status: null, waited: p.wait() };
    this.procs.set(p.pid, rec);
    this.emit({ type: "process.started", pid: p.pid, cmd });
    void rec.waited.then((s) => {
      rec.status = s;
      rec.state = s.signal ? "killed" : "exited"; // record survives (NOT deleted)
      this.emit({ type: "process.exited", pid: p.pid, code: s.code, signal: s.signal });
    });
    const stdinEnded = { write() {}, end() {} };
    return { pid: p.pid, stdout: p.stdout, stderr: p.stderr, stdin: stdinEnded, wait: () => rec.waited, kill: (s?: Signal) => p.kill(SIG(s)) };
  }

  async exec(commandLine: string, options?: Omit<SpawnOptions, "cmd" | "args">): Promise<ProcessHandle> {
    return this.track(await this.guestd.exec(commandLine, { cwd: options?.cwd, env: options?.env }), commandLine, []);
  }
  async spawn(options: SpawnOptions): Promise<ProcessHandle> {
    return this.track(await this.guestd.spawn(options.cmd, options.args ?? [], { cwd: options.cwd, env: options.env }), options.cmd, options.args ?? []);
  }
  async kill(pid: number, signal?: Signal): Promise<void> {
    const rec = this.procs.get(pid);
    if (!rec) throw new ErrnoError("ESRCH", { path: String(pid), syscall: "kill" });
    if (rec.state !== "running") return; // killing an already-exited pid is a no-op, not an error
    await rec.proc.kill(SIG(signal));
  }
  async wait(pid: number): Promise<ExitStatus> {
    const rec = this.procs.get(pid);
    if (!rec) throw new ErrnoError("ESRCH", { path: String(pid), syscall: "wait" });
    return rec.status ?? rec.waited; // stored status if already exited, else the live promise
  }
  async getProcesses(): Promise<ProcessInfo[]> {
    // Merge live guest /proc with our retained exited records (dedup by pid), so
    // a process that has exited still appears with state "exited"/"killed".
    const live = await this.guestd.ps();
    const seen = new Set(live.map((p) => p.pid));
    const retained: ProcessInfo[] = [];
    for (const rec of this.procs.values()) {
      if (seen.has(rec.pid)) continue;
      retained.push({ pid: rec.pid, ppid: 0, cmd: rec.cmd, args: rec.args, cwd: "/", state: rec.state, startTimeMs: 0, exitCode: rec.status?.code ?? null });
    }
    return [...live, ...retained];
  }

  // ---- filesystem (bridge) ----
  readFile(p: string): Promise<Uint8Array> { return this.bridge.readFile(p); }
  writeFile(p: string, d: Uint8Array | string, o?: WriteFileOptions): Promise<void> { return this.bridge.writeFile(p, d, o); }
  readdir(p: string): Promise<FileEntry[]> { return this.bridge.readdir(p); }
  mkdir(p: string, o?: MkdirOptions): Promise<void> { return this.bridge.mkdir(p, o); }
  rm(p: string, o?: RmOptions): Promise<void> { return this.bridge.rm(p, o); }
  rename(f: string, t: string): Promise<void> { return this.bridge.rename(f, t); }
  stat(p: string): Promise<Stat> { return this.bridge.stat(p); }

  // ---- snapshot (workspace-scoped) ----
  async createSnapshot(): Promise<Snapshot> { this.bridge.flush(); return snapshotWorkspace(this.host.fs9p, this.clock); }
  async restoreSnapshot(s: Snapshot): Promise<void> { await restoreWorkspace(this.host.fs9p, this.bridge, s); }

  // ---- ports (in-VM for 11a; real guest proxy is Round 12) ----
  async listen(port: number): Promise<VirtualPort> {
    const reg = this.ports; reg.serve(port, () => ({ status: 502, headers: {}, body: new Uint8Array() }));
    return { port, close: async () => reg.close(port) };
  }
  async exposePort(port: number): Promise<string> { return this.ports.exposePort(port); }
  async dispatch(port: number, req: HttpRequest): Promise<HttpResponse> { return this.ports.dispatch(port, req); }
  async closePort(port: number): Promise<void> { this.ports.close(port); }

  async getCapabilities(): Promise<RuntimeCapabilities> { return vmCapabilities(["python3"]); }
  subscribe(l: RuntimeEventListener): Unsubscribe { this.listeners.add(l); return () => this.listeners.delete(l); }
}

export type { V86Assets };
```

> `listen()` here serves a placeholder 502 handler just to satisfy the legacy bind semantics; the conformance port test only requires `exposePort` (URL + event), `dispatch`-unbound → 502, and `closePort` idempotency — all delegated to `PortRegistry`. Don't over-build guest TCP; that's Round 12.

- [ ] **Step 3: Write the gated conformance harness**

`packages/runtime-vm/src/vm-runtime.conformance.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { runConformance } from "@erdou/conformance";
import { VmRuntime } from "./vm-runtime.js";
import { assetsPresent, defaultAssets } from "./assets.js";

const RUN = assetsPresent() && process.env.ERDOU_VM_E2E === "1";

// Gated: needs the baked asset (pnpm --filter @erdou/runtime-vm bake) AND
// ERDOU_VM_E2E=1. Keeps the default `pnpm test` hermetic and fast.
describe.skipIf(!RUN)("VmRuntime (gated e2e)", () => {
  // Each conformance test gets a FRESH VM booted from the self-contained state.
  runConformance("VmRuntime", () => new VmRuntime(defaultAssets(), { clock: () => 0 }));

  // VM-specific checks the shared suite doesn't cover:
  it("runs real python3 in the guest", async () => {
    const rt = new VmRuntime(defaultAssets());
    await rt.boot();
    const p = await rt.exec("python3 -c 'print(6*7)'");
    expect((await p.stdout.text()).trim()).toBe("42");
    await rt.shutdown();
  });

  it("snapshot captures only the workspace, not the 37MB Alpine system", async () => {
    const rt = new VmRuntime(defaultAssets());
    await rt.boot();
    await rt.writeFile("/only.txt", "x");
    const snap = await rt.createSnapshot();
    const json = JSON.stringify(snap);
    expect(json.length).toBeLessThan(100_000); // workspace-scoped, nowhere near 37MB
    expect(json).toContain("only.txt");
    await rt.shutdown();
  });

  it("kills a long-running guest process", async () => {
    const rt = new VmRuntime(defaultAssets());
    await rt.boot();
    const p = await rt.exec("sleep 30");
    await rt.kill(p.pid, "SIGKILL");
    const status = await rt.wait(p.pid);
    expect(status.signal ?? status.code).toBeTruthy();
    await rt.shutdown();
  });
});
```

- [ ] **Step 4: Run the gated suite**

Run (after `pnpm --filter @erdou/runtime-vm bake` from Task 8):
```
ERDOU_VM_E2E=1 pnpm vitest run packages/runtime-vm/src/vm-runtime.conformance.test.ts
```
Expected: **`conformance: VmRuntime` all green** (filesystem, process, shell, snapshot, port, capabilities suites) + the 3 VM-specific tests pass. This proves guestd exec/spawn/kill/ps, the fs9p bridge, the workspace snapshot, and boot-from-state all work against the real Alpine guest.

> Debugging notes distilled from the spikes, in case a suite test hangs: (a) after boot the guest is idle — `guestd.ready()`'s first frame IS the kick; if `ready()` never resolves, the guestd launch marker in the bake didn't actually start the daemon (check `/tmp/gd.log` by exec'ing `cat /tmp/gd.log` is circular — instead re-bake with the launch command echoing to serial). (b) `exec("echo data > /out.txt")` writing to `/out.txt` and `readFile("/out.txt")` reading it is the split-FS invariant — if it fails, the bind-mounts/chroot in the bake regressed. (c) per-test boot is ~1.5 s; 15+ tests fit the 120 s `testTimeout`.

- [ ] **Step 5: Verify the default suite stays hermetic + commit**

Run: `pnpm test` (WITHOUT the env var)
Expected: the VmRuntime suite is **skipped**; total stays green; no VM boots in the default run.

```bash
git add packages/runtime-vm/src/vm-runtime.ts packages/runtime-vm/src/vm-runtime.conformance.test.ts packages/runtime-vm/src/assets.ts
git commit -m "feat(runtime-vm): VmRuntime composition + gated conformance (green against a real Alpine guest)"
```

---

### Task 10: Final gates, README, and memory

Confirm the round's acceptance and document how to bake + run the gated suite.

**Files:**
- Create: `packages/runtime-vm/README.md`
- Modify: repo root `.gitignore` (ensure `packages/runtime-vm/.bake-tmp/` is ignored) if not covered

- [ ] **Step 1: README**

`packages/runtime-vm/README.md`:

```markdown
# @erdou/runtime-vm

A second Erdou Runtime: a real 32-bit Alpine Linux guest in a [v86](https://github.com/copy/v86) WebAssembly emulator, satisfying the same `@erdou/runtime-contract` as `@erdou/runtime-browser`.

- **Workspace over 9p:** the Erdou VFS backs the guest's `/workspace` (the contract `/`); the Alpine system lives in `/sys-root`, bind-mounted read-only into the workspace chroot. Guest writes surface as `file.changed`; snapshots are workspace-scoped (user files only, not the 37 MB system).
- **Processes via `guestd`:** a resident Python daemon runs `exec`/`spawn`/`kill`/`ps` inside the workspace chroot, framed over a virtio-console channel.
- **Self-contained state:** the whole machine (incl. the 9p FS) is baked into `assets/state.zst` once; boot = restore (~1 s).

## Build the assets (once; not committed)

```
pnpm --filter @erdou/runtime-vm download-assets   # pinned kernel + BIOS → assets/ (gitignored)
pnpm --filter @erdou/runtime-vm bake              # Alpine + guestd → assets/state.zst (gitignored)
```

## Run the gated conformance/e2e suite

```
ERDOU_VM_E2E=1 pnpm vitest run packages/runtime-vm
```

The default `pnpm test` skips this suite (it needs the baked asset and is slow), keeping CI hermetic.

## Status (Round 11a)

MVP: contract-complete, conformance-green in Node. Deferred to Round 11b: the browser wiring (`Kernel` seam `kind` union, PTY terminal, UI kernel toggle). Deferred to Round 12: real guest-server preview (`dispatch` into a guest TCP listener) and the package-registry network gateway (`networkEgress` is `"none"` today).
```

- [ ] **Step 2: Final gates**

Run: `pnpm test && pnpm typecheck && pnpm lint:deps && pnpm build`
Expected: all clean. `pnpm test` stays hermetic (VM suite skipped); `lint:deps` proves `runtime-vm` imports only the contract; `build` emits the package's dist.

- [ ] **Step 3: Confirm the gated suite once more, then commit**

Run: `ERDOU_VM_E2E=1 pnpm vitest run packages/runtime-vm` (with assets baked)
Expected: conformance green against `VmRuntime`.

```bash
git add packages/runtime-vm/README.md .gitignore
git commit -m "docs(runtime-vm): README (bake + gated e2e); Round 11a complete — conformance green against a real Alpine guest"
```

---

## Self-Review (performed while writing)

**Spec coverage (§ of `2026-07-16-dual-kernel-vm-runtime-design.md`):**
- §4 shared workspace / 9p hinge → Tasks 5 (bridge) + 8 (split-FS bake). Guest writes → `file.changed`: Task 5, verified in Task 9.
- §5 components: `VmRuntime` → Task 9; guest agent (`guestd`) exec/spawn/kill/ps over virtio-console → Tasks 3/4; image pipeline → Task 8; **PTY terminal → deferred to 11b** (Round 11a is headless/Node; noted in scope + README).
- §6 ports/preview → **Round 12** (Task 9 ships the in-VM `PortRegistry` that satisfies conformance; real guest-TCP dispatch is out of scope, stated).
- §7 network egress → `networkEgress: "none"` for 11a (Task 2 capabilities), gateway deferred to Round 12 (README).
- §8 contract seed items → Task 1 (delivery-bound + exec-kill conformance). `closePort`/async-events/workspace-snapshot semantics already landed in Round 10; `VmRuntime` honors them.
- §11 testing: conformance against `VmRuntime` in Node (v86 runs under Node — verified) → Task 9; image smoke → Task 8's bake run; the harness boots from the baked state per test.
- §12 delivery: this is Round **11a** (the split the user chose). 11b (browser wiring: `Kernel.kind` union, PTY terminal, UI toggle, apps/web VmRuntime construction) is a separate plan authored after 11a executes.

**Round-10 review seed list:** delivery-bound + exec-kill conformance → Task 1 (done here). `Kernel.kind` union, `runServeCommand` blocking-server lifecycle, PreviewPanel closePort logging → these are apps/web concerns → Round 11b. VM-harness close-after-serve → covered by the shared port suite running against `VmRuntime` in Task 9.

**Placeholder scan:** two spots intentionally flagged for the implementer to finalize, both with the exact fix stated inline (not vague): (a) `assets.ts` `require` → replace with the `writeFileSync` import; (b) `manifest.json` kernel/BIOS URLs → pin to the team's asset source (the blobs are the verified spike assets; do not commit). Everything else is complete code.

**Type consistency:** `GuestChannel` (Task 4) is produced by `V86Host.channel()` (Task 7) and consumed by `GuestdClient` (Task 4) + `VmRuntime` (Task 9) — same shape. `Fs9p` (Task 5) is produced by `V86Host.fs9p` (Task 7) and consumed by `Fs9pBridge` + `snapshotWorkspace`/`restoreWorkspace` (Task 6). `FrameType`/`Frame`/`FrameReader` (Task 3) used by both `guestd-client.ts` and mirrored byte-for-byte by `guestd.py` (incl. `PING`). `V86Assets` (Task 7) produced by `defaultAssets()` (Task 9) and consumed by `VmRuntime` ctor. `SKELETON_DIRS`/`WORKSPACE` defined in `fs-bridge.ts` (Task 5), reused by `workspace-snapshot.ts` (Task 6) and the bake `preload.mjs` (Task 8, its own copy — scripts are separate from src by design).

**Adversarial verification pass (4 reviewers before execution; all 6 verified findings folded in):**
- **C1** — page-side `writeFile`/`mkdir`/`rm`/`rename` now emit `file.changed` **synchronously** (new `emitChange`, not the coalesce timer) so the conformance `file.changed` test and the Task-1 one-macrotask bound pass; guest writes stay coalesced; the fs-bridge unit test was inverted to expect the event.
- **C2** — `VmRuntime` **retains** process records after exit (`ProcRecord` map): `wait` returns the stored status, `kill` no-ops for an exited pid, `getProcesses` merges live `guestd.ps()` with retained exited records — so `process.ts`'s `state === "exited"` assertion and the exec-kill test pass.
- **I1** — READY is now a **response to a `PING` kick**: `GuestdClient.ready()` pings on an interval until READY arrives (survives the post-restore idle guest, per Spike C); `guestd.py` replies READY to PING; the fake channel models request→READY.
- **I2** — conformance gained a **per-test teardown seam** (`booted()` registers; `runConformance` `afterEach` shuts down) so ~20 per-test VM boots don't OOM/hang.
- **I3** — the bake reads assets into an **exact 0-offset `ArrayBuffer`** (`new Uint8Array(readFileSync(p)).buffer`) — a pooled small-file Buffer would silently feed v86 wrong bytes.
- **M1** — `restoreState` passes the view, not `buf.buffer`.

