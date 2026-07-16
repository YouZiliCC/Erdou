# Round 11c — apps/web VM kernel integration (toggle + xterm PTY) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the browser-ready `@erdou/runtime-vm` into the real apps/web app: a `Kernel` toggle that lazily boots the VM (real Alpine Linux) and copies the workspace across, a synchronous `Kernel.fs` over the guest, and an xterm.js interactive PTY terminal — so a user can switch, in the browser, between the fast simulated kernel and a real Linux VM, with the same project following them.

**Architecture:** Extend the app's `Kernel` seam (`kind: "browser" | "vm"`, optional `openPty`) and add `createVmKernel()` — a VM kernel whose `runtime` is a `VmRuntime` (booted from Vite-served assets via `loadBrowserInputs`), whose `fs` is a `SyncFs9pFs`, whose `openShell()` is an exec-backed `RpcShellSession`, and which exposes `openPty()` for the streaming terminal. `Studio` makes its `kernel` switchable: switching to `"vm"` lazily boots it (with progress), copies the current workspace file-by-file into the new kernel, re-subscribes runtime events, and swaps. A kernel selector drives it; `TerminalPanel` renders the existing block terminal for the browser kernel and an xterm PTY for the VM. Verified end-to-end by a gated headless-Chromium app e2e.

**Tech Stack:** TypeScript strict, pnpm workspaces, Vite + React (apps/web), Vitest. New apps/web deps: `@erdou/runtime-vm` (workspace), `@xterm/xterm` ^6, `v86` (pinned to runtime-vm's ^0.5.424, for the `?url` wasm import). Gated e2e via playwright-core + system Chromium.

## Global Constraints

- Node ≥ 22, pnpm ≥ 11.
- **Layering (`pnpm lint:deps`):** apps/web MAY import runtime implementations (`runtime-browser`, `runtime-vm`); the runtime packages still import only the contract. No new violations.
- **Zero regression + hermetic default:** `pnpm test` stays green and fast; the Node gated VM conformance stays **24/24**; the new app e2e is gated (skipped unless the VM asset + a system Chromium + `ERDOU_VM_E2E=1` are present). The default browser-kernel app experience is unchanged when the user never switches.
- **Repo clean:** the VM boot assets (state.zst/kernel/bios) stay gitignored; apps/web serves them from `public/vm-assets/` via **symlinks created by a predev/prebuild script** (the symlink targets are gitignored) — never commit the binaries.
- **Locked UX decisions (via brainstorming):** (1) switching kernels **copies the workspace** across (the project follows you); (2) the VM boots **lazily** — the default kernel is the browser one (zero download / instant), and the VM's ~40 MB state + ~2 s boot happen only on first switch to it, with a progress indicator.
- Fail fast, no silent fallbacks. TDD per task; app-integration pieces that need a real browser (asset serving, xterm PTY, the toggle flow) are verified by the **gated app e2e** (Task 7), not pure units — each such task names its gated check.
- All commits on branch `feat/round11c-app-vm` (already checked out, off Round 11b `feat/round11b-browser-vm`).
- Gates: `pnpm test`, `pnpm typecheck`, `pnpm lint:deps`, `pnpm build`; Node gated: `ERDOU_VM_E2E=1 pnpm vitest run packages/runtime-vm/src/vm-runtime.conformance.test.ts`; app e2e (Task 7): `ERDOU_VM_E2E=1 pnpm vitest run apps/web/src/app-vm.e2e.test.ts`.

## Verified foundation (Spike G — VmRuntime + xterm in the REAL apps/web Vite app; see `.superpowers/sdd/r11c-spike-notes.md` + `r11c-spikes/g/REPORT.md`)

- **VmRuntime boots in the real Vite app (dev AND prod build), READY ~1.7 s (cold) / ~1.6 s (warm IDB); xterm.js drives a live interactive PTY** (6/6: python3→42, keystroke echo, `ls`, `python3 --version`, resize).
- **REQUIRED FIX (Task 1):** `packages/runtime-vm/src/index.ts` re-exports the NODE loader (`loadNodeInputs`/`defaultAssets`/`assetsPresent` from `./assets.js`, which has top-level `node:fs` imports). Under Vite the browser-external `node:fs` stub **throws on named-import access at import time** → the page dies before `main()` runs. The default package entry MUST be browser-clean.
- **Assets:** symlink the 4 bake assets into `apps/web/public/vm-assets/` (Vite dev serves `public/` and follows symlinks; build dereferences them into real files). `loadBrowserInputs({ baseUrl: "/vm-assets", ... })`.
- **v86.wasm:** `import wasmUrl from "v86/build/v86.wasm?url"` (needs `v86` as a direct apps/web dep, pinned to runtime-vm's version so pnpm dedupes to one instance). The README's `new URL(...)` form does NOT work under Vite.
- **`import { V86 } from "v86"`: ZERO vite.config change** — Vite optimizeDeps prebundles libv86.mjs; its node refs are behind runtime guards (falsy in browser). No `external`/`optimizeDeps.exclude`/alias.
- No COOP/COEP; ~700 MB tab heap with the guest; IDB caching works under Vite. v86 boot chunk ~708 KB (lazy `import()` behind the toggle keeps it out of the initial bundle).
- **xterm wiring** (`@xterm/xterm` 6.0.0): `pty.onData(d => term.write(d))` (term.write takes Uint8Array), `term.onData(s => pty.write(enc.encode(s)))`, `term.onResize(({cols,rows}) => pty.resize(cols,rows))`, `import "@xterm/xterm/css/xterm.css"`.

## File Structure

```
packages/runtime-vm/
  src/index.ts            # MODIFY: default entry browser-clean (drop Node-loader re-exports)
  src/node.ts             # NEW: Node-only entry (loadNodeInputs/defaultAssets/assetsPresent/V86Assets)
  package.json            # MODIFY: add "./node" subpath export; rebuild dist
  src/vm-runtime.conformance.test.ts / scripts  # MODIFY imports to ./node.js
  src/browser-assets.ts   # MODIFY (Task 8 cleanups): poisoned-cache invalidation; version from a param
apps/web/
  package.json            # MODIFY: + @erdou/runtime-vm, @xterm/xterm, v86
  scripts/link-vm-assets.mjs   # NEW: symlink the 4 assets into public/vm-assets/ (predev/prebuild)
  public/vm-assets/.gitignore  # NEW: ignore the symlinked binaries
  src/lib/kernel.ts       # MODIFY: Kernel.kind union + optional openPty; RpcShellSession stays
  src/lib/vm-kernel.ts    # NEW: createVmKernel() — VmRuntime + SyncFs9pFs + exec-shell + openPty + browser asset loader
  src/lib/vm-assets.ts    # NEW: the Vite asset config (baseUrl + wasmUrl import) consumed by createVmKernel
  src/lib/workspace-copy.ts    # NEW: copyWorkspace(fromFs, toFs) — file-by-file across two FileSystemApi
  src/lib/studio.ts       # MODIFY: mutable kernel + switchKernel (lazy boot, copy, re-subscribe, _shell reset)
  src/components/KernelToggle.tsx   # NEW: kernel selector + VM boot progress
  src/components/TerminalPanel.tsx  # MODIFY: dual-mode (block terminal | xterm PTY by kernel.kind)
  src/components/PtyTerminal.tsx    # NEW: xterm.js ↔ PtySession component
  src/lib/*.test.ts, src/app-vm.e2e.test.ts (NEW gated)
```

---

### Task 1: `@erdou/runtime-vm` default entry is browser-clean (Node loaders → `./node` subpath)

Spike G's one hard blocker: the default `index.ts` re-exports `loadNodeInputs`/`defaultAssets`/`assetsPresent` from `./assets.js`, which has top-level `node:fs`/`node:zlib`/`node:module` imports. Vite's browser-external `node:fs` stub throws on named access at import time, so importing `@erdou/runtime-vm` in the browser dies before any code runs. Move the Node-only surface to a `./node` subpath export; keep the default entry browser-clean.

**Files:**
- Create: `packages/runtime-vm/src/node.ts`
- Modify: `packages/runtime-vm/src/index.ts`, `package.json` (add `"./node"` export)
- Modify: `packages/runtime-vm/src/vm-runtime.conformance.test.ts` + any script importing the Node loaders (point at `./node.js` or keep deep-importing `./assets.js`)

**Interfaces:**
- Produces: `@erdou/runtime-vm` default entry exports ONLY browser-clean symbols (`VmRuntime`, `vmCapabilities`, `loadBrowserInputs`, `openIdbBlobStore`, `decompressGzip`, `V86Host`, `SyncFs9pFs`, `openPtySession`, `Fs9pBridge`, `WORKSPACE`, `SKELETON_DIRS`, and the types `V86BootInputs`/`PtySession`/`PtyChannel`/`BrowserAssetOptions`/`IdbBlobStore`/`Fs9p`/`GuestProcess`/`GuestChannel`). `@erdou/runtime-vm/node` exports `loadNodeInputs`, `defaultAssets`, `assetsPresent`, type `V86Assets`.

- [ ] **Step 1: Write the failing test — the default entry has no node: imports**

`packages/runtime-vm/src/index.browser-clean.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Statically walk the default-entry import graph and assert no module in it has a
// top-level `node:*` (or bare node builtin) import — those throw under Vite's
// browser-external stubs at import time (Spike G). assets.ts (node:fs) must NOT
// be reachable from index.ts.
const here = dirname(fileURLToPath(import.meta.url));
function topLevelImports(file: string): string[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(/^\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]!);
}
const NODE_BUILTINS = /^(node:|fs$|path$|zlib$|module$|url$|crypto$|os$|child_process$)/;

describe("runtime-vm default entry is browser-clean", () => {
  it("index.ts does not (transitively, one hop) re-export a node:* module", () => {
    const idxImports = topLevelImports(join(here, "index.ts"));
    // index.ts should not import assets.ts (the node:fs module)
    expect(idxImports.some((i) => /\.\/assets(\.js)?$/.test(i))).toBe(false);
    // and its direct local imports must themselves be node-free at the top level
    for (const imp of idxImports) {
      if (!imp.startsWith("./")) continue;
      const f = join(here, imp.replace(/\.js$/, ".ts"));
      const nested = topLevelImports(f).filter((n) => NODE_BUILTINS.test(n));
      expect(nested, `${imp} pulls node builtins: ${nested}`).toEqual([]);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/runtime-vm/src/index.browser-clean.test.ts`
Expected: FAIL — `index.ts` currently `export { loadNodeInputs, defaultAssets, assetsPresent } from "./assets.js"`, and `assets.ts` imports `node:fs`.

- [ ] **Step 3: Create `node.ts` + trim `index.ts`**

`packages/runtime-vm/src/node.ts`:

```ts
// Node-only entry: file-based asset loading (top-level node: imports). Browser
// consumers must NOT import this — the default entry (index.ts) is browser-clean.
export { loadNodeInputs, defaultAssets, assetsPresent } from "./assets.js";
export type { V86Assets } from "./assets.js";
```

In `index.ts`, REMOVE the `loadNodeInputs`/`defaultAssets`/`assetsPresent`/`V86Assets` re-exports (keep everything else — the browser surface added in Round 11b).

- [ ] **Step 4: Add the `./node` subpath export**

In `packages/runtime-vm/package.json`, add to `exports` (both dev and `publishConfig`):

```json
    "./node": { "types": "./src/node.ts", "import": "./src/node.ts" }
```

and in `publishConfig.exports`:

```json
    "./node": { "types": "./dist/node.d.ts", "import": "./dist/node.js" }
```

Update the `build` script to also emit `node.ts`: `tsup src/index.ts src/node.ts --format esm --dts --clean`.

- [ ] **Step 5: Point Node consumers at `./node`**

In `vm-runtime.conformance.test.ts`, change `import { assetsPresent, defaultAssets, loadNodeInputs } from "./assets.js";` to `from "./node.js";` (or leave the deep `./assets.js` import — both work; prefer `./node.js` for the public path). Grep for other `loadNodeInputs`/`defaultAssets`/`assetsPresent` importers (scripts) and repoint. `assets.ts` itself stays (node.ts re-exports it).

- [ ] **Step 6: Run tests + gates**

Run: `pnpm vitest run packages/runtime-vm && pnpm typecheck && pnpm lint:deps`
Expected: the browser-clean test PASSES; typecheck clean.
Run: `ERDOU_VM_E2E=1 pnpm vitest run packages/runtime-vm/src/vm-runtime.conformance.test.ts` (rm -f the stale `assets/state.bin` first)
Expected: still 24/24 green (only the import path changed).

- [ ] **Step 7: Rebuild dist + full suite + commit**

Run: `pnpm --filter @erdou/runtime-vm build && pnpm test`
Expected: dist emits `index.js` + `node.js` + their `.d.ts`; suite green.

```bash
git add packages/runtime-vm
git commit -m "refactor(runtime-vm)!: browser-clean default entry — Node loaders move to @erdou/runtime-vm/node"
```

---

### Task 2: `Kernel.kind` union + optional `openPty` + a VM exec-shell

Extend the app's `Kernel` seam so a second kind fits: `kind: "browser" | "vm"`, an optional `openPty()` (the browser kernel has none; the VM streams a real terminal), and a reusable exec-backed `RpcShellSession` the VM kernel uses for its block-terminal/preview shell (request/response over `runtime.exec`, tracking `cwd`).

**Files:**
- Modify: `apps/web/src/lib/kernel.ts`
- Create: `apps/web/src/lib/exec-shell.ts`, `exec-shell.test.ts`

**Interfaces:**
- Produces:
  - `Kernel.kind: "browser" | "vm"`; `Kernel.openPty?: (opts?: { cols?: number; rows?: number }) => Promise<import("@erdou/runtime-vm").PtySession>` (optional).
  - `createExecShell(runtime: Pick<Runtime, "exec">): RpcShellSession` in `exec-shell.ts` — a persistent request/response shell over `runtime.exec`, tracking `cwd` across commands (handles `cd`), for a runtime whose native shell is a real guest (the VM). Signature matches the existing `RpcShellSession` (`cwd` getter + `exec(line) → {code, stdout, stderr}`).
- Consumed by: Task 3 (`createVmKernel` uses `createExecShell` + sets `openPty`).

- [ ] **Step 1: Write the failing test**

`apps/web/src/lib/exec-shell.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createExecShell } from "./exec-shell.js";
import type { ProcessHandle } from "@erdou/runtime-contract";

/** A fake runtime.exec that records commands and returns scripted output. cwd is
 *  tracked by the shell, so `cd` changes the prompt without a real fs. */
function fakeRuntime(handler: (line: string, cwd: string) => { code: number; stdout: string; stderr: string }) {
  const calls: { line: string; cwd: string }[] = [];
  return {
    calls,
    exec: async (line: string): Promise<ProcessHandle> => {
      // createExecShell runs `cd <dir> && <cmd>; pwd`-style — see impl. Here we
      // parse the trailing user command out for the assertion.
      const cwd = "/"; // the shell prepends cd; the fake just echoes for pwd
      calls.push({ line, cwd });
      const r = handler(line, cwd);
      return {
        pid: 1,
        stdout: { read: async function* () {}, text: async () => r.stdout },
        stderr: { read: async function* () {}, text: async () => r.stderr },
        stdin: { write() {}, end() {} },
        wait: async () => ({ code: r.code, signal: null }),
        kill: async () => {},
      } as unknown as ProcessHandle;
    },
  };
}

describe("createExecShell", () => {
  it("runs a command and returns code/stdout/stderr", async () => {
    const rt = fakeRuntime(() => ({ code: 0, stdout: "hi\n", stderr: "" }));
    const shell = createExecShell(rt);
    const r = await shell.exec("echo hi");
    expect(r).toEqual({ code: 0, stdout: "hi\n", stderr: "" });
  });

  it("tracks cwd across cd (the prompt follows)", async () => {
    // The shell resolves cwd by asking the runtime; model that: `cd /tmp` then pwd → /tmp.
    let cwd = "/";
    const rt = fakeRuntime((line) => {
      const m = /(?:^|&&\s*)cd\s+(\S+)/.exec(line);
      if (m) cwd = m[1]!.startsWith("/") ? m[1]! : cwd.replace(/\/$/, "") + "/" + m[1];
      return { code: 0, stdout: cwd + "\n", stderr: "" }; // impl reads pwd from trailing output
    });
    const shell = createExecShell(rt);
    await shell.exec("cd /tmp");
    expect(shell.cwd).toBe("/tmp");
  });
});
```

> The exec-shell resolves the post-command cwd by appending a `; pwd` sentinel to each command line and parsing the last line (the guest is a real shell, so `cd` persists only if we thread cwd ourselves — `createExecShell` prepends `cd <cwd> && ` and reads the trailing `pwd`). Implement to match this contract; adjust the test's fake to the exact sentinel your impl uses.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run apps/web/src/lib/exec-shell.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `exec-shell.ts`**

```ts
import type { Runtime } from "@erdou/runtime-contract";
import type { RpcShellSession } from "./kernel.js";

/** A persistent request/response shell over a runtime whose native shell is a
 *  real guest (the VM). Each command runs as `cd <cwd> && ( <line> ); __rc=$?;
 *  pwd; exit $__rc` so cwd survives across calls (a fresh `exec` otherwise starts
 *  at /). The trailing pwd line updates the tracked cwd for the prompt. */
export function createExecShell(runtime: Pick<Runtime, "exec">): RpcShellSession {
  let cwd = "/";
  const PWD = "PWD"; // unlikely sentinel prefix
  return {
    get cwd() { return cwd; },
    async exec(line: string) {
      const wrapped = `cd ${shq(cwd)} 2>/dev/null; ( ${line} ); __rc=$?; printf '${PWD}%s\\n' "$(pwd)"; exit $__rc`;
      const proc = await runtime.exec(wrapped);
      const [status, rawOut, stderr] = await Promise.all([proc.wait(), proc.stdout.text(), proc.stderr.text()]);
      // strip the trailing PWD sentinel line, update cwd
      let stdout = rawOut;
      const idx = rawOut.lastIndexOf(PWD);
      if (idx !== -1) {
        const after = rawOut.slice(idx + PWD.length);
        const nl = after.indexOf("\n");
        cwd = (nl === -1 ? after : after.slice(0, nl)).trim() || cwd;
        stdout = rawOut.slice(0, idx);
      }
      return { code: status.code, stdout, stderr };
    },
  };
}

const shq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
```

(Adjust the test's fake so its `pwd` echo matches this sentinel + parsing.)

- [ ] **Step 4: Extend the `Kernel` interface**

In `apps/web/src/lib/kernel.ts`:

```ts
import type { PtySession } from "@erdou/runtime-vm";
// ...
export interface Kernel {
  readonly kind: "browser" | "vm";
  readonly runtime: Runtime;
  readonly fs: FileSystemApi;
  openShell(): RpcShellSession;
  /** Streaming interactive terminal — the VM kernel provides it; the browser kernel does not. */
  openPty?(opts?: { cols?: number; rows?: number }): Promise<PtySession>;
}
```

(`createBrowserKernel` stays as-is — `kind: "browser"`, no `openPty`.)

- [ ] **Step 5: Run tests + gates + commit**

Run: `pnpm vitest run apps/web && pnpm typecheck && pnpm lint:deps`
Expected: PASS (exec-shell tests; existing kernel tests still green — the union + optional openPty are backward-compatible).

```bash
git add apps/web/src/lib/kernel.ts apps/web/src/lib/exec-shell.ts apps/web/src/lib/exec-shell.test.ts
git commit -m "feat(web): Kernel.kind union + optional openPty + createExecShell (VM request/response shell)"
```

---

### Task 3: `createVmKernel` + `VmRuntime.syncFs()` + Vite asset wiring

The VM kernel factory: construct a `VmRuntime` from Vite-served assets (`loadBrowserInputs` over `/vm-assets` + the `?url` wasm import), boot it, and expose `runtime` + `fs` (a `SyncFs9pFs` over the guest, via a new `VmRuntime.syncFs()` that shares the runtime's event bus — resolving the 11b double-emit note) + `openShell` (`createExecShell`) + `openPty`. Plus the asset plumbing: deps, the `public/vm-assets/` symlink script, and the wasm-url config.

**Files:**
- Modify: `packages/runtime-vm/src/vm-runtime.ts` (add `syncFs()`), `index.ts` (export nothing new — `SyncFs9pFs` already exported)
- Create: `apps/web/src/lib/vm-kernel.ts`, `vm-kernel.test.ts`, `apps/web/src/lib/vm-assets.ts`
- Create: `apps/web/scripts/link-vm-assets.mjs`, `apps/web/public/vm-assets/.gitignore`
- Modify: `apps/web/package.json` (deps + predev/prebuild scripts)

**Interfaces:**
- Produces:
  - `VmRuntime.syncFs(): SyncFs9pFs` — constructs a `SyncFs9pFs` over the guest's `fs9p`, emitting `file.changed` on the runtime's event bus (only file *creates* can double with the bridge's coalesced event — benign, deduped downstream; documented).
  - `createVmKernel(opts?: { onProgress?: (phase: string) => void }): Promise<Kernel>` — returns a fully-BOOTED VM kernel (`kind: "vm"`), so `Studio.switchKernel` awaits it (lazy boot).
  - `vmAssets(): { baseUrl: string; wasmUrl: string; version: string }` in `vm-assets.ts` (Vite config: `baseUrl: "/vm-assets"`, `wasmUrl` from the `?url` import, `version` from a build constant).
- Consumed by: Task 4 (`Studio.switchKernel`), Task 7 (app e2e).

- [ ] **Step 1: Add `VmRuntime.syncFs()` (+ a unit test)**

In `packages/runtime-vm/src/vm-runtime.ts`, add (after boot, `host.fs9p` + `emit` exist):

```ts
import { SyncFs9pFs } from "./sync-fs.js";
// ...
/** A synchronous FileSystemApi over the guest workspace, sharing this runtime's
 *  event bus. Page-side creates can double with the async bridge's coalesced
 *  create event (both observe the same fs9p CreateFile) — harmless, deduped by
 *  consumers (the app's file.changed handler keys by path). Available after boot(). */
syncFs(): SyncFs9pFs {
  if (!this.booted) throw new Error("VmRuntime.syncFs(): not booted");
  return new SyncFs9pFs(this.host.fs9p, (e) => this.emit(e));
}
```

Add to `packages/runtime-vm/src/vm-runtime.test.ts` (or a new hermetic test if none) — actually `syncFs` needs a booted runtime (real v86), so cover it in the **gated** conformance file: add a VM-specific test that `rt.syncFs().writeFile("/sf.txt","x")` then `rt.readFile("/sf.txt")` (async bridge) reads it, proving both surfaces share one fs9p. (Hermetic unit coverage of SyncFs9pFs already exists from 11b.)

- [ ] **Step 2: Write the failing `vm-kernel` test**

`apps/web/src/lib/vm-kernel.test.ts` (unit-tests the WIRING with a fake VmRuntime — the real boot is the e2e's job):

```ts
import { describe, it, expect, vi } from "vitest";
import { createVmKernel } from "./vm-kernel.js";

// Inject a fake runtime factory so the test doesn't boot a real VM.
const fakeRuntime = () => {
  const events: unknown[] = [];
  return {
    booted: true,
    boot: vi.fn(async () => {}),
    exec: vi.fn(),
    openPty: vi.fn(async () => ({ write() {}, onData() {}, resize() {}, dispose: async () => {} })),
    syncFs: () => ({ readFile() { return new Uint8Array(); }, writeFile() {}, readdir() { return []; }, mkdir() {}, rm() {}, exists() { return false; }, stat() { return {} as any; } }),
    subscribe: () => () => {},
    _events: events,
  };
};

describe("createVmKernel", () => {
  it("boots the runtime, kind is 'vm', exposes fs (syncFs) + openShell + openPty", async () => {
    const rt = fakeRuntime();
    const kernel = await createVmKernel({ makeRuntime: () => rt as any });
    expect(kernel.kind).toBe("vm");
    expect(rt.boot).toHaveBeenCalled();
    expect(kernel.fs).toBe(rt.syncFs() as any); // fs is the runtime's syncFs (compare shape)
    expect(typeof kernel.openShell().exec).toBe("function"); // exec-shell
    expect(typeof kernel.openPty).toBe("function");
  });
});
```

> `createVmKernel` takes a hidden `makeRuntime` seam (default: the real `new VmRuntime(() => loadBrowserInputs(vmAssets()))`) so the test injects a fake. Adjust the assertion for `fs` to compare the actual returned object identity (call `rt.syncFs` once and reuse).

- [ ] **Step 3: Implement `vm-assets.ts` + `vm-kernel.ts`**

`apps/web/src/lib/vm-assets.ts`:

```ts
// Vite serves the v86 boot assets from public/vm-assets/ (symlinked by
// scripts/link-vm-assets.mjs). v86.wasm comes via a ?url asset import (Vite emits
// a hashed URL in the build). `version` keys the IndexedDB state cache; bump on
// a re-bake. (Derive from the asset's own hash later; a constant is fine now.)
import wasmUrl from "v86/build/v86.wasm?url";

export function vmAssets(): { baseUrl: string; wasmUrl: string; version: string } {
  return { baseUrl: "/vm-assets", wasmUrl, version: "alpine-3.24.1-r11b" };
}
```

> `v86/build/v86.wasm?url` needs a module declaration if tsc complains — Vite's client types (`vite/client`) declare `*?url`. Ensure `apps/web/tsconfig.json` includes `"types": ["vite/client"]` (it likely already resolves via the React plugin; if tsc errors on the `?url` import, add a `src/vite-env.d.ts` with `/// <reference types="vite/client" />`).

`apps/web/src/lib/vm-kernel.ts`:

```ts
import { VmRuntime, loadBrowserInputs, type PtySession } from "@erdou/runtime-vm";
import type { FileSystemApi, Runtime } from "@erdou/runtime-contract";
import type { Kernel, RpcShellSession } from "./kernel.js";
import { createExecShell } from "./exec-shell.js";
import { vmAssets } from "./vm-assets.js";

interface VmLike extends Runtime {
  boot(): Promise<void>;
  syncFs(): FileSystemApi;
  openPty(opts?: { cols?: number; rows?: number }): Promise<PtySession>;
}

/** Construct + BOOT a VM kernel (kind "vm"). Boots the real Alpine guest from the
 *  Vite-served assets; returns a ready kernel. onProgress narrates the phases. */
export async function createVmKernel(opts: { onProgress?: (phase: string) => void; makeRuntime?: () => VmLike } = {}): Promise<Kernel> {
  const onProgress = opts.onProgress ?? (() => {});
  onProgress("Loading VM image…");
  const runtime = opts.makeRuntime
    ? opts.makeRuntime()
    : (new VmRuntime(() => loadBrowserInputs(vmAssets())) as unknown as VmLike);
  onProgress("Booting Alpine Linux…");
  await runtime.boot();
  onProgress("Ready");
  const fs = runtime.syncFs();
  return {
    kind: "vm",
    runtime,
    fs,
    openShell: (): RpcShellSession => createExecShell(runtime),
    openPty: (o) => runtime.openPty(o),
  };
}
```

- [ ] **Step 4: Asset wiring — deps, symlink script, gitignore**

`apps/web/scripts/link-vm-assets.mjs`:

```js
// Symlink the v86 boot assets into public/vm-assets/ so Vite serves them (dev)
// and dereferences them into the build. Targets are gitignored — this runs on
// predev/prebuild. Idempotent (ln -sfn).
import { mkdirSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, "..", "public", "vm-assets");
const assetsDir = join(here, "..", "..", "..", "packages", "runtime-vm", "assets");
mkdirSync(pub, { recursive: true });
for (const f of ["kernel.bin", "seabios.bin", "vgabios.bin", "state.zst"]) {
  const target = join(assetsDir, f);
  const link = join(pub, f);
  if (!existsSync(target)) { console.warn(`[link-vm-assets] missing ${target} — run \`pnpm --filter @erdou/runtime-vm bake\``); continue; }
  try { rmSync(link, { force: true }); } catch {}
  symlinkSync(relative(pub, target), link);
}
console.log("[link-vm-assets] linked vm-assets");
```

`apps/web/public/vm-assets/.gitignore`:

```
*
!.gitignore
```

In `apps/web/package.json`:
- dependencies: `"@erdou/runtime-vm": "workspace:*"`, `"@xterm/xterm": "^6.0.0"`, `"v86": "0.5.424"` (pin to runtime-vm's; run `pnpm install`).
- scripts: `"predev": "node scripts/link-vm-assets.mjs"`, `"prebuild": "node scripts/link-vm-assets.mjs"` (if `dev`/`build` scripts exist, prepend; else add these `pre*` hooks so `pnpm --filter @erdou/web dev`/`build` link first).

- [ ] **Step 5: Run tests + gates + commit**

Run: `pnpm install && pnpm vitest run apps/web packages/runtime-vm && pnpm typecheck && pnpm lint:deps`
Expected: `vm-kernel` + `syncFs`-related unit tests PASS; typecheck clean (the `?url` import resolves); lint:deps clean (apps/web may import runtime-vm).
Run: `node apps/web/scripts/link-vm-assets.mjs` — confirms the symlinks are created (assets present locally).

```bash
git add packages/runtime-vm/src/vm-runtime.ts apps/web/src/lib/vm-kernel.ts apps/web/src/lib/vm-kernel.test.ts apps/web/src/lib/vm-assets.ts apps/web/scripts apps/web/public/vm-assets/.gitignore apps/web/package.json pnpm-lock.yaml
git commit -m "feat(web): createVmKernel + VmRuntime.syncFs + Vite asset wiring (public/vm-assets symlinks, v86.wasm ?url)"
```

---

### Task 4: Studio — switchable kernel, lazy VM boot, workspace copy-on-switch

Make `Studio.kernel` switchable. `switchKernel("vm")` lazily constructs+boots the VM kernel (with progress), **copies the current workspace** into it, re-subscribes the runtime event handlers to the new runtime, resets the persistent shell, and swaps. Switching back to `"browser"` reuses the (kept-alive) browser kernel and copies the workspace back. The mounted folder, runs, and snapshot machinery stay at the Studio level and follow `this.kernel` polymorphically.

**Files:**
- Create: `apps/web/src/lib/workspace-copy.ts`, `workspace-copy.test.ts`
- Modify: `apps/web/src/lib/studio.ts`
- Test: `apps/web/src/lib/studio-switch.test.ts` (new)

**Interfaces:**
- Produces:
  - `copyWorkspace(from: FileSystemApi, to: FileSystemApi, root?: string): void` in `workspace-copy.ts` — recursively copy files/dirs from one sync FS to another (skips the VM skeleton dirs so it doesn't clobber bind mounts).
  - `Studio.kernelKind: "browser" | "vm"` (getter → `this.kernel.kind`); `Studio.switchingKernel: { phase: string } | null` (progress state for the UI); `Studio.switchKernel(kind: "browser" | "vm"): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/lib/workspace-copy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { copyWorkspace } from "./workspace-copy.js";
import { Vfs } from "@erdou/runtime-browser";

describe("copyWorkspace", () => {
  it("copies files + nested dirs across two FileSystemApi, skipping VM skeleton dirs", () => {
    const from = new Vfs(); const to = new Vfs();
    from.mkdir("/sub", { recursive: true });
    from.writeFile("/a.txt", "one");
    from.writeFile("/sub/b.txt", "two");
    from.mkdir("/bin", { recursive: true }); from.writeFile("/bin/x", "system"); // skeleton — must be skipped
    copyWorkspace(from, to);
    expect(new TextDecoder().decode(to.readFile("/a.txt"))).toBe("one");
    expect(new TextDecoder().decode(to.readFile("/sub/b.txt"))).toBe("two");
    expect(to.exists("/bin/x")).toBe(false); // skeleton skipped
  });
});
```

`apps/web/src/lib/studio-switch.test.ts` (with a fake kernel factory injected so no real VM boots):

```ts
import { describe, it, expect, vi } from "vitest";
import { Studio } from "./studio.js";

vi.mock("./local-mount.js", async (o) => ({ ...(await o<typeof import("./local-mount.js")>()), persistHandle: vi.fn(async () => {}), loadPersistedHandle: vi.fn(async () => null), clearPersistedHandle: vi.fn(async () => {}) }));

describe("Studio.switchKernel", () => {
  it("switches to a (fake) vm kernel, copies the workspace, and swaps", async () => {
    const studio = new Studio();
    await studio.boot();
    await studio.fs.mkdir?.("/p", { recursive: true });
    studio.fs.writeFile("/keep.txt", "follows-me");
    // inject a fake vm kernel factory
    const fakeVm = { kind: "vm" as const, runtime: studio.runtime, fs: studio.fs, openShell: () => studio.shell, openPty: async () => ({}) as any };
    await studio.switchKernel("vm", { makeKernel: async ({ onProgress }) => { onProgress?.("boot"); return fakeVm; } });
    expect(studio.kernelKind).toBe("vm");
    // the workspace file was copied into the vm kernel's fs (same fake fs here → present)
    expect(new TextDecoder().decode(studio.fs.readFile("/keep.txt"))).toBe("follows-me");
  });
});
```

> `switchKernel` takes a hidden `makeKernel` seam (default `createVmKernel`) so tests inject a fake without booting a VM. Adjust the fake so its `fs` is a distinct Vfs to actually assert the copy (the snippet above shares fs for brevity — make the fake's fs a fresh `new Vfs()` and assert the copy landed there).

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run apps/web/src/lib/workspace-copy.test.ts apps/web/src/lib/studio-switch.test.ts`
Expected: FAIL — modules/methods missing.

- [ ] **Step 3: Implement `workspace-copy.ts`**

```ts
import type { FileSystemApi } from "@erdou/runtime-contract";
import { SKELETON_DIRS } from "@erdou/runtime-vm";

/** Recursively copy the workspace from one sync FS to another. Skips the VM
 *  skeleton mount points (bin/lib/usr/proc/dev/tmp) at the root so a copy into a
 *  VM kernel never clobbers its bind mounts. Idempotent create of dirs. */
export function copyWorkspace(from: FileSystemApi, to: FileSystemApi, root = "/"): void {
  for (const entry of from.readdir(root)) {
    if (root === "/" && SKELETON_DIRS.includes(entry.name)) continue;
    const path = root === "/" ? `/${entry.name}` : `${root}/${entry.name}`;
    if (entry.type === "directory") {
      to.mkdir(path, { recursive: true });
      copyWorkspace(from, to, path);
    } else if (entry.type === "file") {
      to.writeFile(path, from.readFile(path));
    }
    // symlinks: skip for the MVP (rare in a user workspace; the VM has its own system symlinks)
  }
}
```

- [ ] **Step 4: Implement `Studio.switchKernel`**

In `studio.ts`:
- Change `readonly kernel: Kernel = createBrowserKernel();` to `kernel: Kernel = createBrowserKernel();` (drop `readonly`) + keep a cached browser kernel so switching back is instant: `private browserKernel = this.kernel;`.
- Add `get kernelKind() { return this.kernel.kind; }` and `switchingKernel: { phase: string } | null = null;`.
- Extract the runtime-event subscription from `boot()` into `private subscribeRuntime(): void` that stores the `Unsubscribe`, so `switchKernel` can unsubscribe the old and subscribe the new. (The current `boot()` does `this.runtime.subscribe((e) => …)` for file.changed/port.opened/port.closed — move that body into `subscribeRuntime`, keep an `_unsubRuntime` field.)
- Add:

```ts
async switchKernel(kind: "browser" | "vm", opts: { makeKernel?: (o: { onProgress?: (p: string) => void }) => Promise<Kernel> } = {}): Promise<void> {
  if (kind === this.kernel.kind || this.switchingKernel) return;
  const makeKernel = opts.makeKernel ?? (async (o) => (await import("./vm-kernel.js")).createVmKernel(o));
  this.switchingKernel = { phase: "Starting…" };
  this.notify();
  try {
    const next = kind === "browser"
      ? this.browserKernel
      : await makeKernel({ onProgress: (p) => { this.switchingKernel = { phase: p }; this.notify(); } });
    if (kind === "browser" && !this._browserBooted) { await next.runtime.boot(); } // (browser boots once; see note)
    // copy the current workspace into the target kernel so the project follows
    copyWorkspace(this.kernel.fs, next.fs);
    // swap: unsubscribe old runtime events, point at the new kernel, re-subscribe
    this._unsubRuntime?.();
    this.kernel = next;
    this._shell = undefined;              // the `shell` getter re-opens on the new kernel
    this.subscribeRuntime();
    void startPreviewProxy(this.runtime); // re-point the preview reverse-proxy at the new runtime
    this.fsVersion++;
    this.logSystem("system", `Switched to the ${kind === "vm" ? "Linux VM" : "browser"} kernel.`);
  } catch (err) {
    this.logSystem("error", `Failed to switch to the ${kind} kernel`, asMessage(err));
  } finally {
    this.switchingKernel = null;
    this.notify();
  }
}
```

> The browser kernel is constructed booted-once at Studio init and its runtime is booted in `Studio.boot()`; keep a `_browserBooted` flag so switching back doesn't re-boot it. The VM kernel is returned pre-booted by `createVmKernel`. Adjust `boot()` to set `_browserBooted = true` after booting the initial browser runtime, and to call `subscribeRuntime()` (the extracted method) instead of the inline subscription.

- [ ] **Step 5: Run tests + gates + commit**

Run: `pnpm vitest run apps/web && pnpm typecheck && pnpm lint:deps`
Expected: PASS — workspace-copy + studio-switch tests green; existing studio tests (mount/approval/config/settle) still green (the kernel field going mutable + the extracted subscribe don't change their behavior).

```bash
git add apps/web/src/lib/workspace-copy.ts apps/web/src/lib/workspace-copy.test.ts apps/web/src/lib/studio.ts apps/web/src/lib/studio-switch.test.ts
git commit -m "feat(web): Studio.switchKernel — lazy VM boot + copy-workspace-on-switch + runtime event re-subscribe"
```

---

### Task 5: Kernel toggle UI + boot progress

A kernel selector (browser / Linux VM) that drives `Studio.switchKernel`, with the VM's lazy boot/download shown as a progress state. Match the existing Codex-desktop chip/Select styling (reuse the custom `Select` from `components/ui/Select.tsx`).

**Files:**
- Create: `apps/web/src/components/KernelToggle.tsx`
- Modify: `apps/web/src/App.tsx` (mount the toggle, e.g. in the TitleBar row), `apps/web/src/lib/use-studio.ts` if needed (expose `kernelKind`/`switchingKernel` via the store)

**Interfaces:**
- Consumes: `Studio.kernelKind`, `Studio.switchingKernel`, `Studio.switchKernel`.
- Produces: `<KernelToggle studio={studio} />`.

- [ ] **Step 1: Implement `KernelToggle.tsx`**

```tsx
import { useSyncExternalStore } from "react";
import type { Studio } from "../lib/studio.js";
import { Select } from "./ui/Select.js";

const OPTIONS = [
  { value: "browser" as const, label: "Browser kernel" },
  { value: "vm" as const, label: "Linux VM" },
];

/** Switch between the fast simulated browser kernel and the real Alpine VM.
 *  The VM boots lazily on first selection (~40 MB download + ~2 s), shown as a
 *  progress chip; the current project is copied across on switch. */
export function KernelToggle({ studio }: { studio: Studio }) {
  const kind = useSyncExternalStore((cb) => studio.subscribe(cb), () => studio.kernelKind);
  const switching = useSyncExternalStore((cb) => studio.subscribe(cb), () => studio.switchingKernel);
  if (switching) {
    return <span className="chip"><span className="dot busy" /> VM: {switching.phase}</span>;
  }
  return (
    <Select
      value={kind}
      options={OPTIONS}
      ariaLabel="Kernel"
      onChange={(v) => void studio.switchKernel(v as "browser" | "vm")}
    />
  );
}
```

- [ ] **Step 2: Mount it in `App.tsx`**

Add `<KernelToggle studio={studio} />` to the TitleBar row (or beside the model chip). Import it. (The `TitleBar` already renders a `runtime · js·py·wasi` chip — put the toggle next to it; optionally update that chip's label to reflect the active kernel, e.g. `runtime · linux-vm` when `kind === "vm"`.)

- [ ] **Step 3: Run tests + gates + commit**

Run: `pnpm vitest run apps/web && pnpm typecheck && pnpm lint:deps`
Expected: PASS (no new unit tests strictly required — the toggle is thin; its behavior is covered by Task 4's switchKernel tests + Task 7's e2e). Typecheck clean.

> Optionally add a shallow render test that the toggle shows the progress chip when `studio.switchingKernel` is set — a React Testing Library test if the repo has one; otherwise rely on the e2e.

```bash
git add apps/web/src/components/KernelToggle.tsx apps/web/src/App.tsx
git commit -m "feat(web): kernel toggle UI (browser / Linux VM) with lazy-boot progress"
```

---

### Task 6: xterm.js PTY terminal — `TerminalPanel` dual-mode

The browser kernel keeps its block terminal (request/response `RpcShellSession`); the VM kernel gets a streaming xterm.js PTY (`Kernel.openPty`). `TerminalPanel` renders one or the other by `kernel.kind`. Add `@xterm/xterm` (dep added in Task 3).

**Files:**
- Create: `apps/web/src/components/PtyTerminal.tsx`
- Modify: `apps/web/src/components/TerminalPanel.tsx` (branch on `studio.kernelKind`)
- Modify: `apps/web/src/styles.css` (import/allow the xterm CSS; or import it in PtyTerminal)

**Interfaces:**
- Consumes: `Studio.kernel.openPty`, `Studio.kernelKind`.
- Produces: `<PtyTerminal studio={studio} />` (an xterm terminal bound to a fresh `PtySession`, disposed on unmount).

- [ ] **Step 1: Implement `PtyTerminal.tsx`** (Spike G wiring)

```tsx
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { Studio } from "../lib/studio.js";

/** An xterm.js terminal bound to a VM PtySession (streaming). Keystrokes → pty;
 *  pty output → xterm; resize propagates to the guest. The session is opened on
 *  mount and disposed on unmount. */
export function PtyTerminal({ studio }: { studio: Studio }) {
  const elRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!elRef.current || !studio.kernel.openPty) return;
    const term = new Terminal({ cols: 80, rows: 24, convertEol: false, fontFamily: "monospace", fontSize: 13 });
    term.open(elRef.current);
    const enc = new TextEncoder();
    let disposed = false;
    let session: Awaited<ReturnType<NonNullable<typeof studio.kernel.openPty>>> | undefined;
    void studio.kernel.openPty({ cols: term.cols, rows: term.rows }).then((s) => {
      if (disposed) { void s.dispose(); return; }
      session = s;
      s.onData((d) => term.write(d));
      term.onData((str) => s.write(enc.encode(str)));
      term.onResize(({ cols, rows }) => s.resize(cols, rows));
    }).catch((err) => term.write(`\r\n[pty error] ${String(err)}\r\n`));
    return () => { disposed = true; void session?.dispose(); term.dispose(); };
  }, [studio]);
  return <div className="pty-term" ref={elRef} style={{ height: "100%", width: "100%" }} />;
}
```

- [ ] **Step 2: Branch `TerminalPanel` on the kernel**

At the top of `TerminalPanel`'s render, if the VM kernel is active, render the PTY terminal instead of the block terminal:

```tsx
import { PtyTerminal } from "./PtyTerminal.js";
// ... inside TerminalPanel, before the block-terminal JSX:
if (studio.kernelKind === "vm" && studio.kernel.openPty) {
  return <PtyTerminal studio={studio} />;
}
// ...existing block terminal for the browser kernel...
```

(Keep the existing block terminal untouched for `kind === "browser"`.)

- [ ] **Step 3: Run tests + gates + commit**

Run: `pnpm vitest run apps/web && pnpm typecheck && pnpm lint:deps && pnpm --filter @erdou/web build`
Expected: PASS; the build bundles `@xterm/xterm` + its CSS. (No hermetic unit test for the xterm render — jsdom lacks a real terminal; it's verified by Task 7's e2e.)

```bash
git add apps/web/src/components/PtyTerminal.tsx apps/web/src/components/TerminalPanel.tsx apps/web/src/styles.css
git commit -m "feat(web): xterm.js PTY terminal for the VM kernel — TerminalPanel dual-mode"
```

---

### Task 7: Gated app e2e — switch to the VM kernel + run in the xterm PTY, in the real app

Productionize Spike G's driver into a gated test that drives the REAL apps/web (Vite dev) in headless Chromium: boots on the browser kernel, switches to the VM (progress → ready), opens the xterm PTY terminal, runs a command in the real Alpine guest, and verifies output — then switches back. This is the verification for Tasks 3–6 (the browser/app pieces that can't be unit-tested). Gated on the VM asset + `ERDOU_VM_E2E=1` + a system Chromium.

**Files:**
- Create: `apps/web/src/app-vm.e2e.test.ts` (gated vitest that runs a driver script)
- Create: `apps/web/scripts/app-vm-e2e/run.mjs` (start `vite dev`, drive Chromium, assert; ported from Spike G's `drive.mjs` + the round-9/10 app-e2e pattern)
- Modify: `apps/web/package.json` (devDep `playwright-core` if not already present in the workspace)

**Interfaces:**
- Produces: a gated e2e that exits 0 iff the toggle→VM→PTY flow passes; the vitest wrapper asserts it.

- [ ] **Step 1: The driver (port Spike G + the app-e2e pattern)**

`apps/web/scripts/app-vm-e2e/run.mjs`: link the VM assets (`node scripts/link-vm-assets.mjs`), start `pnpm --filter @erdou/web dev` (capture the printed URL), launch headless Chromium (system `process.env.CHROMIUM` default `/usr/bin/chromium-browser`, `--no-proxy-server`), then:
1. Load the app; assert the browser kernel is active (default).
2. Select "Linux VM" in the KernelToggle; wait for the progress chip to reach "Ready" (or the toggle to show VM active) within ~30 s.
3. Open the Terminal panel (the xterm PTY renders — assert `.xterm` present).
4. Focus the terminal, `page.keyboard.type("python3 -c 'print(6*7)'\n")`; wait for `42` to appear in the xterm buffer (read `term.buffer` via `page.evaluate`, or match on the rendered DOM text).
5. `page.keyboard.type("ls /\n")`; assert workspace entries render.
6. Switch back to "Browser kernel"; assert it's active again.
Print `RESULT ALL_PASS` iff all checks pass; exit 0 iff so. Clean up the dev server + browser in a `finally`.

- [ ] **Step 2: The gated vitest wrapper**

`apps/web/src/app-vm.e2e.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const assetPresent = existsSync(join(here, "..", "..", "..", "packages", "runtime-vm", "assets", "state.zst"));
const chromium = ["/usr/bin/chromium-browser", "/usr/bin/chromium"].find(existsSync);
const RUN = assetPresent && process.env.ERDOU_VM_E2E === "1" && !!chromium;

describe.skipIf(!RUN)("app + VM kernel e2e (gated)", () => {
  it("switches to the VM kernel, runs a command in the xterm PTY, switches back", () => {
    const out = execFileSync("node", [join(here, "..", "scripts", "app-vm-e2e", "run.mjs")], {
      encoding: "utf8", timeout: 170_000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, CHROMIUM: chromium! },
    });
    expect(out).toMatch(/RESULT ALL_PASS/);
  }, 180_000);
});
```

- [ ] **Step 3: Run the gated app e2e**

Run: `ERDOU_VM_E2E=1 pnpm vitest run apps/web/src/app-vm.e2e.test.ts` (with assets baked/linked).
Expected: **RESULT ALL_PASS** — the app boots on the browser kernel, switches to the VM (~2 s boot after the ~40 MB state loads), the xterm PTY runs `python3 -c 'print(6*7)'` → 42 in the real Alpine guest, `ls /` shows the (copied) workspace, and switching back to the browser kernel works.

> Debugging (from the spikes): if the toggle→VM hangs, check the `/vm-assets/*` symlinks exist (`link-vm-assets.mjs`) and the `?url` wasm resolves; if the PTY shows nothing, the openPtySession subscribe-before-launch/deadline (11b) or the guest devpts mount is the suspect; if the app import fails at boot, the runtime-vm default entry isn't browser-clean (Task 1).

- [ ] **Step 4: Confirm the default suite stays hermetic + commit**

Run: `pnpm test`
Expected: the app e2e SKIPS (no `ERDOU_VM_E2E`); green.
Run: `git status --short` — no gitignored asset/bundle staged.

```bash
git add apps/web/src/app-vm.e2e.test.ts apps/web/scripts/app-vm-e2e apps/web/package.json pnpm-lock.yaml
git commit -m "test(web): gated app e2e — toggle to the Linux VM kernel + run in the xterm PTY (real Chromium)"
```

---

### Task 8: Fold in the cheap Round-11b cleanups (browser-assets robustness)

Two Round-11b final-review deferrals that harden the browser boot and are cheap here: **poisoned-cache invalidation** (a truncated/corrupt cached state currently breaks every boot forever) and **`state:<version>` eviction** (each re-bake leaks ~40 MB in IndexedDB).

**Files:**
- Modify: `packages/runtime-vm/src/browser-assets.ts`
- Test: `packages/runtime-vm/src/browser-assets.test.ts` (extend)

**Interfaces:** no signature changes — `loadBrowserInputs` self-heals a corrupt cache and evicts stale versions.

- [ ] **Step 1: Write the failing tests**

Append to `packages/runtime-vm/src/browser-assets.test.ts`:

```ts
  it("re-fetches when the cached blob is corrupt (decompress fails), then repairs the cache", async () => {
    const idb = fakeIdb();
    idb.store.set("state:v1", new Uint8Array([0, 1, 2, 3])); // not valid gzip
    const inputs = await loadBrowserInputs({
      baseUrl: "https://x/assets", wasmUrl: "https://x/v86.wasm", version: "v1",
      fetchImpl: fakeFetch(assets), idb, // fakeFetch returns the REAL gzip for state.zst
    });
    expect(new Uint8Array(inputs.state!)).toEqual(STATE_RAW); // recovered from the network
    expect(idb.store.get("state:v1")).toEqual(STATE_GZ);      // cache repaired
  });

  it("evicts stale state:<version> keys on put", async () => {
    const idb = fakeIdb();
    idb.store.set("state:old", new Uint8Array([9]));
    await loadBrowserInputs({ baseUrl: "https://x/assets", wasmUrl: "https://x/v86.wasm", version: "v1", fetchImpl: fakeFetch(assets), idb });
    expect(idb.store.has("state:old")).toBe(false); // old version evicted
    expect(idb.store.has("state:v1")).toBe(true);
  });
```

> Extend the fake IDB with `has`/`keys`/`delete` if not present, and give `IdbBlobStore` a `keys(): Promise<string[]>` + `delete(key): Promise<void>` so eviction has a portable API (implement both on `openIdbBlobStore`).

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run packages/runtime-vm/src/browser-assets.test.ts`
Expected: FAIL — no invalidation; no eviction.

- [ ] **Step 3: Implement**

In `browser-assets.ts` `loadBrowserInputs`: wrap the cached-blob decompress in a try/catch — on failure, delete the key, re-fetch, re-cache. After a successful fetch+put, delete any other `state:*` key. Add `keys()`/`delete()` to `IdbBlobStore` + `openIdbBlobStore`.

```ts
  let stateGz = await idb.get(stateKey);
  let state: Uint8Array | undefined;
  if (stateGz) {
    try { state = await decompressGzip(stateGz); }
    catch { await idb.delete(stateKey).catch(() => {}); stateGz = null; } // poisoned — re-fetch
  }
  if (!stateGz) {
    stateGz = await fetchBytes(f, `${opts.baseUrl}/state.zst`);
    state = await decompressGzip(stateGz);
    await idb.put(stateKey, stateGz).catch(() => {});
    for (const k of await idb.keys().catch(() => [])) { // evict other versions
      if (k.startsWith("state:") && k !== stateKey) await idb.delete(k).catch(() => {});
    }
  }
  const [bios, vga, kernel] = await Promise.all([ /* …bios/vga/kernel fetch… */ ]);
  // state is set above
```

- [ ] **Step 4: Run to verify pass + gates + commit**

Run: `pnpm vitest run packages/runtime-vm && pnpm typecheck && pnpm lint:deps && pnpm test`
Expected: PASS.

```bash
git add packages/runtime-vm/src/browser-assets.ts packages/runtime-vm/src/browser-assets.test.ts
git commit -m "fix(runtime-vm): browser-assets self-heals a corrupt state cache + evicts stale versions"
```

---

### Task 9: Final gates, README, memory

**Files:**
- Modify: `packages/runtime-vm/README.md` (correct the Vite integration section — `?url` wasm, `public/vm-assets` symlinks, the `/node` subpath for Node loaders) + `apps/web` README/notes if any.

- [ ] **Step 1: Docs** — in `packages/runtime-vm/README.md`, add/fix a "Using it in a Vite app" section documenting the verified recipe: `import wasmUrl from "v86/build/v86.wasm?url"`, `loadBrowserInputs({ baseUrl: "/vm-assets", wasmUrl, version })`, the `public/vm-assets` symlink approach, and that Node consumers import `@erdou/runtime-vm/node` for `loadNodeInputs`/`defaultAssets`/`assetsPresent`. Note the browser-clean default entry.

- [ ] **Step 2: Final gates**

Run: `pnpm test && pnpm typecheck && pnpm lint:deps && pnpm build`
Expected: all clean; default `pnpm test` hermetic (Node VM conformance + browser e2e + app e2e all gated/skipped).
Run: `ERDOU_VM_E2E=1 pnpm vitest run packages/runtime-vm/src/vm-runtime.conformance.test.ts` — 24/24.
Run: `ERDOU_VM_E2E=1 pnpm vitest run apps/web/src/app-vm.e2e.test.ts` — RESULT ALL_PASS.

- [ ] **Step 3: Commit**

Run: `git status --short` — clean (no artifacts).

```bash
git add packages/runtime-vm/README.md
git commit -m "docs(runtime-vm): Vite integration recipe + /node subpath; Round 11c complete — in-browser kernel toggle to a real Linux VM"
```

---

## Self-Review (performed while writing)

**Spec coverage (§ of the dual-kernel design, Round-11c-relevant):** the browser wiring the spec/11b deferred to "Round 11c" — `Kernel.kind` union (Task 2), `createVmKernel` wiring `SyncFs9pFs` as `Kernel.fs` (Task 3), apps/web Studio kernel toggle + VmRuntime construction (Tasks 4–5), xterm.js PTY terminal beside the request/response `RpcShellSession` (Task 6, with `createExecShell` giving the VM a block/preview shell too), live in-app browser e2e with the kernel switch (Task 7). The locked UX decisions (copy-workspace-on-switch; lazy VM boot) are Task 4.

**Spike-grounded:** every Vite-integration fact (browser-clean entry, `public/vm-assets` symlinks, `?url` wasm, zero-config v86 import, xterm wiring) is from the verified Spike G. Each browser/app-only piece names its gated verification (Task 7).

**Round-11b deferrals:** the two cheap browser-robustness ones (poisoned-cache invalidation, version eviction) → Task 8; the double-emit invariant → resolved by `VmRuntime.syncFs()` sharing the runtime bus (Task 3, benign create-only duplicate documented). Deferred further (not this round): ENOTDIR on file-as-dir traversal, `chmod`/`symlink` guardSkeleton, late-bridge reap, `SpawnOptions.stdin` — none block the app integration.

**Placeholder scan:** the two e2e/driver harnesses (Task 7 `run.mjs`; Spike G's `drive.mjs`) are "port the verified Spike G driver" rather than fully transcribed — acceptable (the Spike G original is verified + on disk this session); all other code is complete. The `exec-shell` and `switchKernel` test fakes are sketched with an explicit "adjust the fake to your impl's exact sentinel/fs" note — the assertions are the requirement.

**Type consistency:** `Kernel.kind: "browser" | "vm"` + optional `openPty` (Task 2) is produced by `createVmKernel` (Task 3) + consumed by `Studio`/`KernelToggle`/`TerminalPanel` (Tasks 4–6). `RpcShellSession` unchanged (browser `openShell` + `createExecShell` both return it). `PtySession` (from `@erdou/runtime-vm`) flows `VmRuntime.openPty` → `Kernel.openPty` → `PtyTerminal`. `VmRuntime.syncFs()` (Task 3) returns a `SyncFs9pFs` (implements `FileSystemApi`) = `Kernel.fs`. `copyWorkspace(FileSystemApi, FileSystemApi)` (Task 4) works over both the browser `Vfs` and the VM `SyncFs9pFs` (both `FileSystemApi`). The `@erdou/runtime-vm/node` subpath (Task 1) is imported only by Node consumers (conformance, scripts), never the browser/app path.

**Known risk to flag for the plan review:** the double-emit of `file.changed` on a page-side *create* (bridge coalesced + `SyncFs9pFs` sync) — benign (the app's `file.changed` handler bumps `fsVersion`/debounces saves/dedups the diff-capture Set by path), but if any consumer counts events it would over-count; noted in `VmRuntime.syncFs()`. The `switchKernel` event re-subscription + `startPreviewProxy` re-point is the most integration-sensitive step (Task 4) — its correctness is verified by Task 7's switch-and-run e2e.
