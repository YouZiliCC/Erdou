# Round 11b — `@erdou/runtime-vm` browser-ready + PTY + hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@erdou/runtime-vm` run in a real browser (fetch + IndexedDB-cached + decompressed assets, fail-fast boot), expose a synchronous workspace filesystem and an interactive PTY terminal, and pay down the Round-11a final-review hardening debt — so Round 11c can wire the VM kernel into apps/web with a kernel toggle and an xterm terminal.

**Architecture:** Split asset *loading* from V86 *construction*: `V86Host` takes pre-loaded `V86BootInputs` (ArrayBuffers + a `wasmUrl`), with a boot timeout that turns v86's silent-wasm-hang into a thrown error. A Node loader keeps the gated conformance green; a browser loader fetches, `DecompressionStream("gzip")`-decompresses, and IndexedDB-caches the ~41 MB state. `SyncFs9pFs` reads/writes v86's in-memory `fs9p` synchronously (verified guest-visible) to satisfy the app's sync `FileSystemApi`. An interactive PTY runs a `forkpty` shell in the guest on a second virtio-console port (`/dev/hvc1`), streamed to a `PtySession`. Everything is verified headless (Node gated conformance stays green; a new gated Chromium e2e proves the browser path, sync-fs, and PTY).

**Tech Stack:** TypeScript strict, pnpm workspaces, Vitest. `v86` (already a dep). New devDep `playwright-core` in runtime-vm for the gated browser e2e (system Chromium; no browser download). Guest daemon additions in Python 3 (baked into the image via a re-bake).

## Global Constraints

- Node ≥ 22, pnpm ≥ 11.
- **Layering (`pnpm lint:deps`):** `@erdou/runtime-vm` src imports ONLY `@erdou/runtime-contract` (+ the `v86` dep + node/browser built-ins). Tests may import `@erdou/conformance`.
- **Zero regression + hermetic default:** `pnpm test` stays green and fast; the Node gated conformance (`ERDOU_VM_E2E=1`) stays **24/24 green** after every task, including after the re-bake; the new browser e2e is gated (skipped unless its asset + `ERDOU_VM_E2E=1` + a system Chromium are present).
- **Repo clean:** the baked `state.zst` + kernel/BIOS stay gitignored build artifacts (Task 8 re-bakes them; never commit binaries).
- Fail fast, no silent fallbacks: the silent wasm-hang and a never-answering guest become thrown, contextual errors. FS errors are `ErrnoError`s.
- TDD per task. v86/guest-touching pieces (browser loader, PtySession, ptybridge.py) are verified by the **gated e2e** (Task 10), not pure units — each such task states which gated check proves it.
- All commits on branch `feat/round11b-browser-vm` (already checked out, off merged main containing Round 11a).
- Gates: `pnpm test`, `pnpm typecheck`, `pnpm lint:deps`, `pnpm build`; Node gated: `ERDOU_VM_E2E=1 pnpm vitest run packages/runtime-vm/src/vm-runtime.conformance.test.ts`; browser gated: `ERDOU_VM_E2E=1 pnpm vitest run packages/runtime-vm/src/browser.e2e.test.ts` (Task 10).

## Verified foundation (3 hands-on browser/v86 spikes — see `.superpowers/sdd/r11b-spike-notes.md` + `r11-b spikes/{d,e,f}/REPORT.md` + PoC scripts)

1. **Browser boot (Spike D, 4/4 PASS in headless Chromium):** whole stack boots, READY ~2 s. `wasm_path: new URL(".../v86.wasm", import.meta.url).href` (used verbatim as an XHR URL, no MIME/streaming) — **omitting/mis-pointing it = infinite Fibonacci-backoff retry, `emulator-ready` never fires, nothing rejects** (the ONE silent-hang trap → boot timeout). `DecompressionStream("gzip")` native (41→99 MB, ~370 ms), pako not needed. **No COOP/COEP** (zero SharedArrayBuffer in v86). IndexedDB caching of the 41 MB compressed blob feasible (put 40 ms/get 57 ms). `memory_size` must equal the baked state's (512 MB). Under a bundler, v86.wasm (+v86-fallback.wasm) must be an untransformed asset URL.
2. **Sync fs over fs9p (Spike E, 36/36 PASS incl. guest-visible writes):** sync write recipe = `CreateFile` (sync) then set `inodedata[idx]=exact-length copy; inode.size; inode.mtime; inode.qid.version++`. NO page-Vfs mirror (fs9p is the shared store). Traps: read must slice to `inode.size` (Write over-allocates to 3/2×); readdir from `direntries` (dirs have bogus inodedata/size); `qid.version++` required for the guest to see overwrites; host rm must `delete inodedata[idx]`; store a copy, return `slice()`. Overwrites bypass the wrapped `Write` → SyncFs must emit `modify` itself.
3. **PTY (Spike F, 8/8 PASS):** second virtio-console port `/dev/hvc1` (v86 is already 4-port; state carries the handshake). Host: `bus.send("virtio-console1-input-bytes"|"…-resize")` / `add_listener("virtio-console1-output-bytes")`. Guest `ptybridge.py`: double-fork+setsid → open hvc1 (ctty) + setraw → `forkpty` → `execv("/bin/sh")` → `select` pump; SIGWINCH copies winsize. **Prereq: `mount -t devpts devpts /dev/pts` inside the chroot** (re-bake). Gate hvc1 writes on the bridge's `PTYBRIDGE_READY`.

## File Structure

```
packages/runtime-vm/
  package.json              # + devDep playwright-core (gated e2e)
  src/
    v86-host.ts             # REFACTOR: takes V86BootInputs (buffers + wasmUrl) + boot timeout; add terminal(port)
    assets.ts               # REFACTOR: loadNodeInputs(assets) → V86BootInputs (read files + gunzip + node wasm path)
    browser-assets.ts       # NEW: loadBrowserInputs(baseUrl, opts) — fetch + DecompressionStream + IndexedDB cache
    sync-fs.ts              # NEW: SyncFs9pFs implements FileSystemApi over fs9p (Spike E recipe)
    pty.ts                  # NEW: PtyChannel + PtySession (host side, over virtio-consoleN)
    fs-bridge.ts            # MODIFY: skeleton-dir page-write rejection (EACCES); empty-file readFile returns 0 bytes
    guestd-client.ts        # MODIFY: dispose() (clear ping interval, reject pending, end streams) + ready() deadline
    workspace-snapshot.ts   # MODIFY: restore file modes + symlinks
    vm-runtime.ts           # MODIFY: loader-based boot; full shutdown() teardown; openPty(); syncFs accessor
    assets.ts / vm-runtime.conformance.test.ts  # MODIFY factory to the loader form
    guest/guestd.py         # MODIFY: add a pty-open op (launch ptybridge on a free port, return pid)
    guest/ptybridge.py      # NEW: the forkpty bridge (baked into the image)
    sync-fs.test.ts, browser-assets.test.ts, pty.test.ts, guestd-client.test.ts (extend), workspace-snapshot.test.ts (extend)
    browser.e2e.test.ts     # NEW gated: boot VmRuntime in headless Chromium; smoke + sync-fs + PTY
    test-support/fake-fs9p.ts  # EXTEND: inodedata + sync-write semantics (shared by sync-fs + snapshot tests)
  scripts/
    lib/preload.mjs         # MODIFY: GUEST_SETUP_CMD += devpts mount; ship ptybridge.py; pycache warmup += pty/fcntl/select
    bake-image.mjs          # (unchanged mechanics; re-run to re-bake)
    browser-e2e/            # NEW: static server + page harness + playwright driver (productionized Spike D)
```

---

### Task 1: Host refactor — `V86BootInputs`, boot timeout, Node loader (keep Node conformance green)

Separate asset LOADING from V86 CONSTRUCTION so a browser loader can feed the same `V86Host`. `V86Host.boot()` takes pre-loaded buffers + a `wasmUrl` and gains a **boot timeout** (the silent-wasm-hang → a thrown error). The Node-specific `createRequire` wasm path and file reads move into a `loadNodeInputs` in `assets.ts`. `VmRuntime` takes an async inputs loader. The Node gated conformance factory is updated; it must stay 24/24 green.

**Files:**
- Modify: `packages/runtime-vm/src/v86-host.ts`, `assets.ts`, `vm-runtime.ts`, `vm-runtime.conformance.test.ts`
- Test: `packages/runtime-vm/src/v86-host.symbols.test.ts` stays; add a boot-timeout unit test where practical

**Interfaces:**
- Produces:
  - `interface V86BootInputs { bios: ArrayBuffer; vgaBios: ArrayBuffer; kernel: ArrayBuffer; state?: ArrayBuffer; wasmUrl: string; memoryMB: number }`
  - `V86Host` constructed with `()` (no args); `boot(inputs: V86BootInputs, opts?: { bootTimeoutMs?: number }): Promise<void>`; still exposes `fs9p`, `channel()`, `serial()`, `run()`, `saveState`/`restoreState`, `destroy`.
  - `loadNodeInputs(assets: V86Assets): Promise<V86BootInputs>` in `assets.ts` (reads files, gunzips `state.zst`, sets `wasmUrl` to the createRequire path).
  - `VmRuntime` constructed with `(loadInputs: () => Promise<V86BootInputs>, opts?: { clock?: () => number; bootTimeoutMs?: number })`.
- Consumed by: Task 2 (browser loader produces `V86BootInputs`), Task 10 (browser e2e).

- [ ] **Step 1: Write the boot-timeout failing test**

Add to `packages/runtime-vm/src/v86-host.symbols.test.ts` (hermetic — no real boot needed; use a fake emulator via a seam). Since `V86Host` news `V86` internally, extract the emulator factory to an injectable seam for testability: add a protected `protected makeEmulator(opts): any` the test can override. The test:

```ts
import { describe, it, expect } from "vitest";
import { V86Host, type V86BootInputs } from "./v86-host.js";

const inputs: V86BootInputs = {
  bios: new ArrayBuffer(8), vgaBios: new ArrayBuffer(8), kernel: new ArrayBuffer(8),
  wasmUrl: "file:///nope/v86.wasm", memoryMB: 512,
};

describe("V86Host.boot timeout", () => {
  it("rejects with a clear error if emulator-ready never fires (the silent wasm hang)", async () => {
    // A fake emulator that NEVER emits emulator-ready — simulates the wasm 404 hang.
    class HangHost extends V86Host {
      protected makeEmulator(): any {
        return { add_listener() {}, bus: { send() {} } };
      }
    }
    const host = new HangHost();
    await expect(host.boot(inputs, { bootTimeoutMs: 50 })).rejects.toThrow(/v86.*not.*ready|wasm|asset/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/runtime-vm/src/v86-host.symbols.test.ts`
Expected: FAIL — `V86BootInputs`/the new `boot(inputs)` signature / `makeEmulator` seam don't exist yet.

- [ ] **Step 3: Refactor `v86-host.ts`**

```ts
import { V86 } from "v86";
import type { GuestChannel } from "./guestd-client.js";
import type { Fs9p } from "./fs-bridge.js";

/** Pre-loaded boot assets — produced by a Node or browser loader, consumed by V86Host.
 *  Separating loading from construction lets one host boot in either environment. */
export interface V86BootInputs {
  bios: ArrayBuffer;
  vgaBios: ArrayBuffer;
  kernel: ArrayBuffer;
  state?: ArrayBuffer;
  /** Where v86.wasm is fetched from — a file URL/path (Node) or a served URL (browser).
   *  Passed to v86 verbatim; a wrong value hangs boot silently, hence the timeout. */
  wasmUrl: string;
  memoryMB: number;
}

const REQUIRED_FS9P = [
  "GetInode", "CreateFile", "CreateDirectory", "CreateSymlink", "CreateBinaryFile",
  "Write", "ChangeSize", "Unlink", "Rename", "Search", "SearchPath", "GetFullPath", "read_file",
] as const;

export function assertFs9pSymbols(fs9p: unknown): void {
  const o = fs9p as Record<string, unknown> | null;
  if (!o || !Array.isArray((o as { inodes?: unknown }).inodes)) {
    throw new Error("v86 fs9p missing or has no `inodes` array — construct V86 with `filesystem: {}`");
  }
  const missing = REQUIRED_FS9P.filter((m) => typeof o[m] !== "function");
  if (missing.length) throw new Error(`v86 fs9p missing required method(s): ${missing.join(", ")} — v86 upgrade may have renamed them`);
}

const DEFAULT_BOOT_TIMEOUT_MS = 60_000;

export class V86Host {
  // v86 ships a .d.ts, but it's incomplete/inaccurate (e.g. restore_state is typed
  // ArrayBuffer when the runtime wants a typed-array view) — `any` is the honest boundary.
  private emulator: any;
  readonly fs9p!: Fs9p;

  /** Seam for tests — override to inject a fake emulator. */
  protected makeEmulator(opts: Record<string, unknown>): any {
    return new V86(opts);
  }

  async boot(inputs: V86BootInputs, opts: { bootTimeoutMs?: number } = {}): Promise<void> {
    const opt: Record<string, unknown> = {
      wasm_path: inputs.wasmUrl,
      bios: { buffer: inputs.bios },
      vga_bios: { buffer: inputs.vgaBios },
      bzimage: { buffer: inputs.kernel },
      memory_size: inputs.memoryMB * 1024 * 1024,
      filesystem: {},
      virtio_console: true,
      autostart: false,
      disable_keyboard: true,
      disable_speaker: true,
      disable_mouse: true,
      cmdline: "console=ttyS0 tsc=reliable mitigations=off random.trust_cpu=on",
    };
    if (inputs.state) opt.initial_state = { buffer: inputs.state };
    this.emulator = this.makeEmulator(opt);

    const timeoutMs = opts.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(
          `v86 did not become ready in ${timeoutMs}ms — the wasm/asset load likely failed silently ` +
          `(check wasmUrl=${inputs.wasmUrl}); v86 retries a bad wasm URL forever without throwing.`,
        )),
        timeoutMs,
      );
      this.emulator.add_listener("emulator-ready", () => { clearTimeout(timer); resolve(); });
    });
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

  async saveState(): Promise<Uint8Array> { return new Uint8Array(await this.emulator.save_state()); }
  async restoreState(buf: Uint8Array): Promise<void> { await this.emulator.restore_state(buf); }
  async destroy(): Promise<void> { if (this.emulator) await this.emulator.destroy(); }
}
```

(`V86Assets` moves to `assets.ts`, below.)

- [ ] **Step 4: `assets.ts` — `loadNodeInputs`**

Replace `assets.ts` with (keeps `assetsPresent`/`defaultAssets`, adds the Node loader that produces `V86BootInputs`):

```ts
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import type { V86BootInputs } from "./v86-host.js";

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
const files = ["kernel.bin", "seabios.bin", "vgabios.bin", "state.zst"];

export interface V86Assets {
  biosPath: string; vgaBiosPath: string; kernelPath: string; statePath: string; memoryMB: number;
}

export function assetsPresent(): boolean {
  return files.every((f) => existsSync(join(assetsDir, f)));
}

export function defaultAssets(): V86Assets {
  return {
    biosPath: join(assetsDir, "seabios.bin"),
    vgaBiosPath: join(assetsDir, "vgabios.bin"),
    kernelPath: join(assetsDir, "kernel.bin"),
    statePath: join(assetsDir, "state.zst"),
    memoryMB: 512,
  };
}

const exactBuffer = (b: Buffer): ArrayBuffer => new Uint8Array(b).buffer;

/** Node inputs loader: read files, gunzip state.zst, resolve v86.wasm via the package. */
export async function loadNodeInputs(assets: V86Assets): Promise<V86BootInputs> {
  const wasmUrl = pathToFileURL(join(dirname(createRequire(import.meta.url).resolve("v86")), "v86.wasm")).href;
  const stateGz = readFileSync(assets.statePath);
  return {
    bios: exactBuffer(readFileSync(assets.biosPath)),
    vgaBios: exactBuffer(readFileSync(assets.vgaBiosPath)),
    kernel: exactBuffer(readFileSync(assets.kernelPath)),
    state: exactBuffer(gunzipSync(stateGz)),
    wasmUrl,
    memoryMB: assets.memoryMB,
  };
}
```

> v86 in Node fetches `wasm_path` via XHR; a `file://` URL works under Node's XHR shim used by v86, matching the pre-refactor `createRequire` path. If the gated conformance boot regresses on the URL form, fall back to the bare filesystem path string (what the pre-refactor code passed) — verify in Task 1's gated re-run.

- [ ] **Step 5: `vm-runtime.ts` — loader-based boot**

Change the constructor + `boot()`:

```ts
// constructor
constructor(private readonly loadInputs: () => Promise<import("./v86-host.js").V86BootInputs>, opts: { clock?: () => number; bootTimeoutMs?: number } = {}) {
  this.host = new V86Host();
  this.clock = opts.clock ?? (() => Date.now());
  this.bootTimeoutMs = opts.bootTimeoutMs;
}
// in boot(): replace `await this.host.boot()` with:
const inputs = await this.loadInputs();
await this.host.boot(inputs, this.bootTimeoutMs ? { bootTimeoutMs: this.bootTimeoutMs } : {});
```

Add the `bootTimeoutMs` private field and adjust the `V86Host` construction (now no-arg).

- [ ] **Step 6: Update the conformance factory**

In `vm-runtime.conformance.test.ts`, change the factory + VM-test constructions from `new VmRuntime(defaultAssets(), ...)` to the loader form:

```ts
import { assetsPresent, defaultAssets, loadNodeInputs } from "./assets.js";
const makeInputs = () => loadNodeInputs(defaultAssets());
// runConformance("VmRuntime", () => new VmRuntime(makeInputs, { clock: () => 0 }));
// and each `new VmRuntime(defaultAssets())` → `new VmRuntime(makeInputs)`
```

- [ ] **Step 7: Run hermetic + gated to verify**

Run: `pnpm vitest run packages/runtime-vm && pnpm typecheck && pnpm lint:deps`
Expected: hermetic green (incl. the new boot-timeout test); typecheck clean.
Run: `ERDOU_VM_E2E=1 pnpm vitest run packages/runtime-vm/src/vm-runtime.conformance.test.ts`
Expected: **still 24/24 green** — the refactor is behavior-preserving for Node.

- [ ] **Step 8: Full suite + commit**

Run: `pnpm test`
Expected: green.

```bash
git add packages/runtime-vm
git commit -m "refactor(runtime-vm): split asset loading from V86 construction (V86BootInputs) + boot timeout; Node loader"
```

---

### Task 2: Browser asset loader — fetch + DecompressionStream + IndexedDB cache

`browser-assets.ts` produces `V86BootInputs` in the browser: fetch bios/kernel/state.zst, `DecompressionStream("gzip")` the state, and cache the compressed 41 MB blob in IndexedDB keyed by a version tag so a reboot skips the network. The `wasmUrl` is a served URL the caller passes. Pure cache/version logic is unit-tested with a fake IndexedDB; fetch/DecompressionStream are verified by the Task 10 browser e2e.

**Files:**
- Create: `packages/runtime-vm/src/browser-assets.ts`, `browser-assets.test.ts`

**Interfaces:**
- Produces:
  - `interface BrowserAssetOptions { baseUrl: string; wasmUrl: string; version: string; memoryMB?: number; fetchImpl?: typeof fetch; idb?: IdbBlobStore }`
  - `loadBrowserInputs(opts: BrowserAssetOptions): Promise<V86BootInputs>` — cache-first for `state.zst` (by `version`), gzip-decompress, fetch bios/kernel fresh (small).
  - `interface IdbBlobStore { get(key: string): Promise<Uint8Array | null>; put(key: string, data: Uint8Array): Promise<void> }` + `openIdbBlobStore(dbName?: string): IdbBlobStore` (real IndexedDB).
  - `decompressGzip(gz: Uint8Array): Promise<Uint8Array>` (DecompressionStream wrapper).
- Consumed by: Round 11c's `createVmKernel` + Task 10's browser e2e.

- [ ] **Step 1: Write the failing test (fake IDB + fake fetch)**

`packages/runtime-vm/src/browser-assets.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { loadBrowserInputs, type IdbBlobStore } from "./browser-assets.js";

function fakeIdb(): IdbBlobStore & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  return { store, async get(k) { return store.get(k) ?? null; }, async put(k, d) { store.set(k, d); } };
}

// A tiny gzip of "STATE" so DecompressionStream has something real to inflate.
// (Built once with node:zlib in the test setup — see below.)
import { gzipSync } from "node:zlib";
const STATE_RAW = new TextEncoder().encode("STATE-BYTES");
const STATE_GZ = new Uint8Array(gzipSync(STATE_RAW));

function fakeFetch(map: Record<string, Uint8Array>): typeof fetch {
  return (async (url: string) => {
    const key = String(url);
    const body = map[key.slice(key.lastIndexOf("/") + 1)];
    if (!body) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) } as Response;
    return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) } as Response;
  }) as unknown as typeof fetch;
}

describe("loadBrowserInputs", () => {
  const assets = {
    "seabios.bin": new Uint8Array([1, 2]),
    "vgabios.bin": new Uint8Array([3, 4]),
    "kernel.bin": new Uint8Array([5, 6]),
    "state.zst": STATE_GZ,
  };

  it("fetches + gzip-decompresses the state and returns V86BootInputs", async () => {
    const idb = fakeIdb();
    const inputs = await loadBrowserInputs({
      baseUrl: "https://x/assets", wasmUrl: "https://x/v86.wasm", version: "v1",
      fetchImpl: fakeFetch(assets), idb,
    });
    expect(new Uint8Array(inputs.state!)).toEqual(STATE_RAW);
    expect(new Uint8Array(inputs.kernel)).toEqual(assets["kernel.bin"]);
    expect(inputs.wasmUrl).toBe("https://x/v86.wasm");
    expect(inputs.memoryMB).toBe(512);
    // the compressed state got cached under the version key
    expect(idb.store.get("state:v1")).toEqual(STATE_GZ);
  });

  it("serves the state from IndexedDB on a second load without fetching state.zst", async () => {
    const idb = fakeIdb();
    idb.store.set("state:v1", STATE_GZ);
    const fetchSpy = vi.fn(fakeFetch({ ...assets, "state.zst": new Uint8Array() })); // state fetch would give empty
    const inputs = await loadBrowserInputs({
      baseUrl: "https://x/assets", wasmUrl: "https://x/v86.wasm", version: "v1",
      fetchImpl: fetchSpy as unknown as typeof fetch, idb,
    });
    expect(new Uint8Array(inputs.state!)).toEqual(STATE_RAW); // decompressed from cache, not the empty fetch
    const fetchedState = fetchSpy.mock.calls.some((c) => String(c[0]).endsWith("state.zst"));
    expect(fetchedState).toBe(false);
  });
});
```

> `DecompressionStream` exists in Node ≥ 18 and in vitest's node env, so the test runs hermetically. If unavailable in the runner, the test skips via `describe.skipIf(typeof DecompressionStream === "undefined")`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/runtime-vm/src/browser-assets.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `browser-assets.ts`**

```ts
import type { V86BootInputs } from "./v86-host.js";

export interface IdbBlobStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, data: Uint8Array): Promise<void>;
}

export interface BrowserAssetOptions {
  baseUrl: string;      // dir holding seabios.bin/vgabios.bin/kernel.bin/state.zst
  wasmUrl: string;      // served v86.wasm (pass new URL("...v86.wasm", import.meta.url).href)
  version: string;      // cache key for the state blob; bump on re-bake
  memoryMB?: number;    // default 512 (must equal the baked state's)
  fetchImpl?: typeof fetch;
  idb?: IdbBlobStore;   // default openIdbBlobStore()
}

/** Inflate a gzip blob using the native DecompressionStream. */
export async function decompressGzip(gz: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function fetchBytes(f: typeof fetch, url: string): Promise<Uint8Array> {
  const r = await f(url);
  if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** Load browser boot inputs: state.zst is cache-first (IndexedDB, by version) then
 *  gzip-decompressed; bios/kernel are small and fetched fresh each boot. */
export async function loadBrowserInputs(opts: BrowserAssetOptions): Promise<V86BootInputs> {
  const f = opts.fetchImpl ?? fetch;
  const idb = opts.idb ?? openIdbBlobStore();
  const stateKey = `state:${opts.version}`;

  let stateGz = await idb.get(stateKey);
  if (!stateGz) {
    stateGz = await fetchBytes(f, `${opts.baseUrl}/state.zst`);
    await idb.put(stateKey, stateGz).catch(() => {}); // caching is best-effort
  }
  const [bios, vga, kernel, state] = await Promise.all([
    fetchBytes(f, `${opts.baseUrl}/seabios.bin`),
    fetchBytes(f, `${opts.baseUrl}/vgabios.bin`),
    fetchBytes(f, `${opts.baseUrl}/kernel.bin`),
    decompressGzip(stateGz),
  ]);
  const ab = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
  return { bios: ab(bios), vgaBios: ab(vga), kernel: ab(kernel), state: ab(state), wasmUrl: opts.wasmUrl, memoryMB: opts.memoryMB ?? 512 };
}

/** A real IndexedDB-backed blob store (browser only). */
export function openIdbBlobStore(dbName = "erdou-vm-assets"): IdbBlobStore {
  const STORE = "blobs";
  const open = (): Promise<IDBDatabase> =>
    new Promise((res, rej) => {
      const r = indexedDB.open(dbName, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  const tx = <T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
    open().then((db) => new Promise<T>((res, rej) => {
      const t = db.transaction(STORE, mode);
      const rq = run(t.objectStore(STORE));
      let out: T;
      rq.onsuccess = () => (out = rq.result);
      t.oncomplete = () => { db.close(); res(out); };
      t.onerror = () => rej(t.error);
    }));
  return {
    async get(key) { const v = await tx<ArrayBuffer | undefined>("readonly", (s) => s.get(key)); return v ? new Uint8Array(v) : null; },
    async put(key, data) { await tx("readwrite", (s) => s.put(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), key)); },
  };
}
```

- [ ] **Step 4: Run to verify pass + gates + commit**

Run: `pnpm vitest run packages/runtime-vm/src/browser-assets.test.ts && pnpm typecheck && pnpm lint:deps`
Expected: PASS (2 tests); typecheck clean (uses browser lib types — ensure `packages/runtime-vm/tsconfig.json` includes DOM lib OR guard the IndexedDB code; see note).

> **tsconfig note:** `browser-assets.ts` uses `indexedDB`/`IDBDatabase`/`DecompressionStream`/`Blob`/`Response`/`fetch`. Add `"lib": ["ES2022", "DOM"]` to `packages/runtime-vm/tsconfig.json`'s compilerOptions (extending the base) so these types resolve without pulling `@types/node`-only. Verify the Node-only files (assets.ts, v86-host.ts) still typecheck (they use node built-ins, which the base lib already covers).

```bash
git add packages/runtime-vm
git commit -m "feat(runtime-vm): browser asset loader — fetch + DecompressionStream(gzip) + IndexedDB-cached state"
```

---

### Task 3: `SyncFs9pFs` — synchronous `FileSystemApi` over fs9p

Spike E verified a synchronous `FileSystemApi` over v86's in-memory fs9p, including writes the guest sees. Build `SyncFs9pFs implements FileSystemApi` (contract's sync FS surface) in runtime-vm, sharing `Fs9pBridge`'s `workspace/` prefix mapping and `file.changed` emission. Round 11c exposes it as the VM kernel's `Kernel.fs`. Unit-tested with an extended fake fs9p (adds `inodedata` + the sync semantics).

**Files:**
- Create: `packages/runtime-vm/src/sync-fs.ts`, `sync-fs.test.ts`
- Modify: `packages/runtime-vm/src/test-support/fake-fs9p.ts` (add `inodedata`, faithful sync-write/read semantics)
- Modify: `packages/runtime-vm/src/fs-bridge.ts` — export the workspace-path helpers `SyncFs9pFs` needs (`WORKSPACE`, `SKELETON_DIRS` already exported); add a shared `contractPathOf`/`ws` if not already reusable, OR `SyncFs9pFs` re-derives them (keep it self-contained to avoid coupling).

**Interfaces:**
- Consumes: `Fs9p` + `Fs9pInode` (from fs-bridge.ts), `WORKSPACE`, `SKELETON_DIRS`; contract `FileSystemApi`, `ErrnoError`, `RuntimeEvent`.
- Produces: `class SyncFs9pFs implements FileSystemApi` constructed with `(fs9p: Fs9p, emit: (e: RuntimeEvent) => void)` — all methods synchronous; page mutations emit `file.changed` synchronously; skeleton-dir + sys-root paths rejected `EACCES`.
- Consumed by: Round 11c `createVmKernel`.

**The `Fs9p` interface must gain `inodedata`** — add to the `Fs9p` interface in `fs-bridge.ts`: `inodedata: Record<number, Uint8Array | undefined>;` (real v86 has it; the fake must too).

- [ ] **Step 1: Extend the fake fs9p + write the failing test**

In `packages/runtime-vm/src/test-support/fake-fs9p.ts`, add an `inodedata: {}` record to the fake, make `CreateBinaryFile`/`Write`/`ChangeSize` maintain BOTH `inodedata[idx]` and `inode.size` (so a sync reader sees the same store the async path leaves), and ensure `read_file` reads `inodedata[idx].slice(0, inode.size)`. (Mirror real v86: `Write` may over-allocate — to exercise the clamp trap, have the fake's `Write` allocate `inodedata[idx]` to `Math.floor(3*len/2)` while setting `inode.size = len`.)

`packages/runtime-vm/src/sync-fs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { RuntimeEvent } from "@erdou/runtime-contract";
import { SyncFs9pFs } from "./sync-fs.js";
import { WORKSPACE } from "./fs-bridge.js";
import { makeFakeFs9p, bootWorkspace } from "./test-support/fake-fs9p.js";

describe("SyncFs9pFs", () => {
  it("sync writeFile then sync readFile returns the bytes (clamped to inode.size)", () => {
    const fs9p = makeFakeFs9p(); bootWorkspace(fs9p);
    const events: RuntimeEvent[] = [];
    const sf = new SyncFs9pFs(fs9p, (e) => events.push(e));
    sf.writeFile("/a.txt", "hello");
    expect(new TextDecoder().decode(sf.readFile("/a.txt"))).toBe("hello"); // not the over-allocated tail
    expect(events).toContainEqual({ type: "file.changed", path: "/a.txt", kind: "create" });
    sf.writeFile("/a.txt", "hi");
    expect(new TextDecoder().decode(sf.readFile("/a.txt"))).toBe("hi");
    expect(events.filter((e) => e.type === "file.changed").at(-1)).toMatchObject({ path: "/a.txt", kind: "modify" });
  });

  it("mkdir + nested writeFile + readdir; rm removes; exists correct", () => {
    const fs9p = makeFakeFs9p(); bootWorkspace(fs9p);
    const sf = new SyncFs9pFs(fs9p, () => {});
    sf.mkdir("/d", { recursive: true });
    sf.writeFile("/d/x.txt", "1");
    expect(sf.readdir("/d").map((e) => e.name)).toEqual(["x.txt"]);
    expect(sf.exists("/d/x.txt")).toBe(true);
    sf.rm("/d/x.txt", {});
    expect(sf.exists("/d/x.txt")).toBe(false);
    expect(fs9p.inodedata).not.toHaveProperty(String(fs9p.SearchPath("workspace/d/x.txt").id)); // inodedata freed
  });

  it("readFile of a missing path throws ENOENT; readFile of an empty file returns 0 bytes", () => {
    const fs9p = makeFakeFs9p(); bootWorkspace(fs9p);
    const sf = new SyncFs9pFs(fs9p, () => {});
    expect(() => sf.readFile("/nope")).toThrow(/ENOENT/);
    // create with no data (mode-only) — inode exists, size 0, no inodedata
    fs9p.CreateFile("empty.txt", fs9p.SearchPath(WORKSPACE).id);
    expect(sf.readFile("/empty.txt").length).toBe(0);
  });

  it("rejects a page write under a skeleton dir with EACCES", () => {
    const fs9p = makeFakeFs9p(); bootWorkspace(fs9p);
    const sf = new SyncFs9pFs(fs9p, () => {});
    expect(() => sf.writeFile("/bin/x", "no")).toThrow(/EACCES/);
    expect(() => sf.mkdir("/tmp/y", { recursive: true })).toThrow(/EACCES/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/runtime-vm/src/sync-fs.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `sync-fs.ts`** (the Spike E recipe + traps)

```ts
import { ErrnoError } from "@erdou/runtime-contract";
import type { FileEntry, RuntimeEvent, Stat, WriteFileOptions, MkdirOptions, RmOptions } from "@erdou/runtime-contract";
import { WORKSPACE, SKELETON_DIRS, type Fs9p } from "./fs-bridge.js";

const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFLNK = 0o120000, S_IFREG = 0o100000;
type ChangeKind = "create" | "modify" | "delete";

/** A synchronous FileSystemApi over v86's in-memory fs9p (Spike E). fs9p is the
 *  single shared store (guest sees writes via 9p; host reads/writes inodedata
 *  directly) — no page-side mirror. Page mutations emit file.changed synchronously. */
export class SyncFs9pFs {
  constructor(private readonly fs9p: Fs9p, private readonly emit: (e: RuntimeEvent) => void) {}

  private ws(path: string): string {
    const norm = "/" + path.split("/").filter(Boolean).join("/");
    return norm === "/" ? WORKSPACE : WORKSPACE + norm;
  }
  private cpath(path: string): string { return "/" + path.split("/").filter(Boolean).join("/"); }
  /** Reject mutations under an image-owned mount point (bin/lib/usr/proc/dev/tmp). */
  private guardSkeleton(path: string, syscall: string): void {
    const first = path.split("/").filter(Boolean)[0];
    if (first !== undefined && SKELETON_DIRS.includes(first)) {
      throw new ErrnoError("EACCES", { path, syscall });
    }
  }
  private now(): number { return Math.round(Date.now() / 1000); }

  readFile(path: string): Uint8Array {
    const w = this.fs9p.SearchPath(this.ws(path));
    if (w.id === -1) throw new ErrnoError("ENOENT", { path, syscall: "open" });
    const inode = this.fs9p.GetInode(w.id);
    if ((inode.mode & S_IFMT) === S_IFDIR) throw new ErrnoError("EISDIR", { path, syscall: "read" });
    const data = this.fs9p.inodedata[w.id];
    if (!data) return new Uint8Array(0);                 // empty file (touch): no inodedata, size 0
    return data.slice(0, inode.size);                     // CLAMP to size (Write over-allocates 3/2×)
  }

  writeFile(path: string, data: Uint8Array | string, _opts?: WriteFileOptions): void {
    this.guardSkeleton(path, "open");
    const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const copy = new Uint8Array(buf.length); copy.set(buf);   // exact-length COPY (save_state serializes these)
    const w = this.fs9p.SearchPath(this.ws(path));
    let idx: number; let kind: ChangeKind;
    if (w.id === -1) {
      if (w.parentid === -1) throw new ErrnoError("ENOENT", { path, syscall: "open" });
      idx = this.fs9p.CreateFile(w.name, w.parentid);         // sync (goes through the bridge wrapper if attached → create event)
      kind = "create";
    } else {
      const inode = this.fs9p.GetInode(w.id);
      if ((inode.mode & S_IFMT) === S_IFDIR) throw new ErrnoError("EISDIR", { path, syscall: "write" });
      idx = w.id; kind = "modify";
    }
    this.fs9p.inodedata[idx] = copy;
    const inode = this.fs9p.GetInode(idx);
    inode.size = copy.length; inode.mtime = this.now(); inode.qid.version++; // qid bump defeats guest cache
    // create already emitted by the wrapped CreateFile if the bridge is attached;
    // overwrites bypass the wrapped Write → emit modify ourselves. Emit unconditionally
    // with the right kind; a duplicate create is harmless (consumers dedupe by path+tick).
    this.emit({ type: "file.changed", path: this.cpath(path), kind });
  }

  mkdir(path: string, opts?: MkdirOptions): void {
    this.guardSkeleton(path, "mkdir");
    const parts = path.split("/").filter(Boolean);
    let parentid = this.fs9p.SearchPath(WORKSPACE).id;
    for (let i = 0; i < parts.length; i++) {
      const existing = this.fs9p.Search(parentid, parts[i]!);
      if (existing !== -1) {
        if (i === parts.length - 1 && !opts?.recursive) throw new ErrnoError("EEXIST", { path, syscall: "mkdir" });
        parentid = existing;
      } else {
        if (i < parts.length - 1 && !opts?.recursive) throw new ErrnoError("ENOENT", { path, syscall: "mkdir" });
        parentid = this.fs9p.CreateDirectory(parts[i]!, parentid);
        this.emit({ type: "file.changed", path: "/" + parts.slice(0, i + 1).join("/"), kind: "create" });
      }
    }
  }

  readdir(path: string): FileEntry[] {
    const w = this.fs9p.SearchPath(this.ws(path));
    if (w.id === -1) throw new ErrnoError("ENOENT", { path, syscall: "scandir" });
    const inode = this.fs9p.GetInode(w.id);
    if ((inode.mode & S_IFMT) !== S_IFDIR) throw new ErrnoError("ENOTDIR", { path, syscall: "scandir" });
    const out: FileEntry[] = [];
    for (const [name, childId] of inode.direntries ?? []) {
      if (name === "." || name === "..") continue;
      const m = this.fs9p.GetInode(childId).mode & S_IFMT;
      out.push({ name, type: m === S_IFDIR ? "directory" : m === S_IFLNK ? "symlink" : "file" });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  rm(path: string, opts?: RmOptions): void {
    this.guardSkeleton(path, "unlink");
    const w = this.fs9p.SearchPath(this.ws(path));
    if (w.id === -1) { if (opts?.force) return; throw new ErrnoError("ENOENT", { path, syscall: "unlink" }); }
    const inode = this.fs9p.GetInode(w.id);
    if ((inode.mode & S_IFMT) === S_IFDIR && inode.direntries) {
      const kids = [...inode.direntries.keys()].filter((k) => k !== "." && k !== "..");
      if (kids.length && !opts?.recursive) throw new ErrnoError("ENOTEMPTY", { path, syscall: "rmdir" });
      for (const k of kids) this.rm(path.replace(/\/$/, "") + "/" + k, { recursive: true, force: true });
    }
    delete this.fs9p.inodedata[w.id];                     // free bytes (no guest CloseInode for host rm)
    this.fs9p.Unlink(w.parentid, w.name);
    this.emit({ type: "file.changed", path: this.cpath(path), kind: "delete" });
  }

  exists(path: string): boolean { return this.fs9p.SearchPath(this.ws(path)).id !== -1; }

  stat(path: string): Stat {
    const w = this.fs9p.SearchPath(this.ws(path));
    if (w.id === -1) throw new ErrnoError("ENOENT", { path, syscall: "stat" });
    const inode = this.fs9p.GetInode(w.id);
    const m = inode.mode & S_IFMT;
    return {
      type: m === S_IFDIR ? "directory" : m === S_IFLNK ? "symlink" : "file",
      size: inode.size, mode: inode.mode & 0o7777,
      mtimeMs: inode.mtime * 1000, ctimeMs: inode.mtime * 1000, birthtimeMs: inode.mtime * 1000,
    };
  }

  // FileSystemApi also declares appendFile/rename/copy/lstat/readlink/symlink/chmod.
  // Implement the ones apps/web needs now; the rest can throw a clear "not implemented
  // on the VM sync surface" until a consumer needs them (YAGNI). At minimum implement:
  lstat(path: string): Stat { return this.stat(path); } // SearchPath doesn't follow symlinks (parity with the async bridge)
  appendFile(path: string, data: Uint8Array | string): void {
    const cur = this.exists(path) ? this.readFile(path) : new Uint8Array(0);
    const extra = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const merged = new Uint8Array(cur.length + extra.length); merged.set(cur, 0); merged.set(extra, cur.length);
    this.writeFile(path, merged);
  }
}
```

> `SyncFs9pFs` implements the `FileSystemApi` surface apps/web actually uses (exists/mkdir/readdir/readFile/rm/writeFile) + stat/lstat/appendFile. Declare it `implements FileSystemApi` and add thin throwing stubs for `rename/copy/readlink/symlink/chmod` with a clear `Error("SyncFs9pFs: <m> not implemented (add when a consumer needs it)")` so the type is satisfied without over-building. (Spike E proved all 14 are sync-implementable if later needed.)

- [ ] **Step 4: Run to verify pass + gates + commit**

Run: `pnpm vitest run packages/runtime-vm/src/sync-fs.test.ts && pnpm typecheck && pnpm lint:deps`
Expected: PASS (4 tests).

```bash
git add packages/runtime-vm
git commit -m "feat(runtime-vm): SyncFs9pFs — synchronous FileSystemApi over fs9p (guest-visible writes, skeleton-guarded)"
```

---

### Task 4: Lifecycle hardening — GuestdClient `dispose()` + `ready()` deadline; VmRuntime full `shutdown()`

Round 11a's final review flagged: `shutdown()` only destroys the emulator (leaks the ping interval + flush timer, hangs pending `wait()`s), and boot can hang if the guest never answers. Add `GuestdClient.dispose()` (clear the ping interval, reject pending, end streams), a `ready()` deadline, `Fs9pBridge.dispose()` (clear the flush timer), and make `VmRuntime.shutdown()` tear everything down (idempotent, pre-boot-safe).

**Files:**
- Modify: `packages/runtime-vm/src/guestd-client.ts`, `fs-bridge.ts`, `vm-runtime.ts`
- Test: `packages/runtime-vm/src/guestd-client.test.ts` (extend)

**Interfaces:**
- Produces: `GuestdClient.dispose(): void`; `GuestdClient.ready(opts?: { deadlineMs?: number }): Promise<{ pid: number }>` (rejects after the deadline); `Fs9pBridge.dispose(): void`; `VmRuntime.shutdown()` full teardown + booted-guard.

- [ ] **Step 1: Write the failing tests**

Append to `packages/runtime-vm/src/guestd-client.test.ts`:

```ts
  it("ready() rejects after the deadline if the guest never answers", async () => {
    // a channel that swallows PINGs and never emits READY
    const channel: GuestChannel = { send() {}, subscribe() {} };
    const client = new GuestdClient(channel);
    await expect(client.ready({ deadlineMs: 50 })).rejects.toThrow(/guest.*not.*respond|ready|timeout/i);
  });

  it("dispose() stops the ping interval and rejects pending processes", async () => {
    let pings = 0;
    const channel: GuestChannel = { send: () => { pings++; }, subscribe() {} };
    const client = new GuestdClient(channel);
    void client.ready({ deadlineMs: 10_000 }).catch(() => {}); // start pinging
    const before = pings;
    client.dispose();
    await new Promise((r) => setTimeout(r, 260)); // > one ping interval
    expect(pings).toBe(before); // no further pings after dispose
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/runtime-vm/src/guestd-client.test.ts`
Expected: FAIL — `dispose` / `ready(opts)` deadline not implemented.

- [ ] **Step 3: Implement**

In `guestd-client.ts`:
- `ready(opts: { deadlineMs?: number } = {})`: keep the PING interval; add a deadline timer that rejects `new Error("guestd did not respond (READY) within <ms>ms — the baked state may be stale/corrupt")`; clear both the interval and the deadline when READY resolves OR on dispose.
- Track a `disposed` flag; `dispose()`: clear the ping interval + deadline timer, reject the ready promise if still pending, and for every entry in `pending`, `stdout.end()`/`stderr.end()` and reject its `started`/settle its exit (so no awaiter hangs). Add a `disposed` guard in `run()`/`onFrame` (ignore frames after dispose).

In `fs-bridge.ts`: add `dispose(): void { if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined; } this.pendingChanges.clear(); }`.

In `vm-runtime.ts` `shutdown()`:

```ts
async shutdown(): Promise<void> {
  if (!this.booted) { if (this.host) await this.host.destroy().catch(() => {}); return; }
  this.booted = false;
  this.guestd?.dispose();
  this.bridge?.dispose();
  for (const rec of this.procs.values()) rec.proc.stdout.end?.(); // best-effort; end open streams
  await this.host.destroy().catch(() => {});
}
```

(Adjust to the actual field names; `stdout.end` exists on the ChunkStream. Guard optional chaining since shutdown may run pre-boot.)

- [ ] **Step 4: Run to verify pass + gates + Node gated re-verify + commit**

Run: `pnpm vitest run packages/runtime-vm && pnpm typecheck && pnpm lint:deps`
Expected: PASS.
Run: `ERDOU_VM_E2E=1 pnpm vitest run packages/runtime-vm/src/vm-runtime.conformance.test.ts`
Expected: still 24/24 green (teardown must not break the per-test boot/shutdown cycle — this actually makes it cleaner).

```bash
git add packages/runtime-vm
git commit -m "fix(runtime-vm): full shutdown teardown (dispose guestd+bridge, end streams) + ready() deadline"
```

---

### Task 5: Snapshot fidelity — restore file modes + symlinks

Round 11a's `restoreWorkspace` dropped file modes and skipped symlinks (a `chmod +x` survived snapshot but not restore). `snapshotWorkspace` already records `mode` and symlink `target`; make restore honor them. Add a `symlink` write to the bridge (or write modes/symlinks directly against fs9p in the restore).

**Files:**
- Modify: `packages/runtime-vm/src/workspace-snapshot.ts`, `fs-bridge.ts` (add `symlink`/`chmod` if not present)
- Test: `packages/runtime-vm/src/workspace-snapshot.test.ts` (extend)

**Interfaces:**
- Produces: `Fs9pBridge.symlink(target: string, linkPath: string): void` and `Fs9pBridge.chmod(path: string, mode: number): void` (sync-ish over fs9p, emitting `file.changed`); `restoreWorkspace` applies `mode` to restored files/dirs and recreates symlinks.

- [ ] **Step 1: Write the failing test**

Append to `packages/runtime-vm/src/workspace-snapshot.test.ts`:

```ts
  it("restores file modes and symlinks", async () => {
    const fs9p = makeFakeFs9p(); bootWorkspace(fs9p);
    const bridge = new Fs9pBridge(fs9p, () => {}); bridge.attach();
    await bridge.writeFile("/run.sh", "#!/bin/sh\necho hi");
    // mark it executable + add a symlink (via the new bridge methods)
    bridge.chmod("/run.sh", 0o755);
    bridge.symlink("run.sh", "/link.sh");

    const snap = await snapshotWorkspace(fs9p, () => 0);
    await bridge.rm("/run.sh", { force: true });
    await bridge.rm("/link.sh", { force: true });
    await restoreWorkspace(fs9p, bridge, snap);

    expect((await bridge.stat("/run.sh")).mode & 0o777).toBe(0o755);
    const link = fs9p.SearchPath("workspace/link.sh");
    expect(fs9p.GetInode(link.id).symlink).toBe("run.sh");
  });
```

(Extend the fake fs9p if needed so `chmod` on an inode sets `mode` and `CreateSymlink` sets `inode.symlink` — the Task-6/Task-3 fake extensions likely already cover this.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/runtime-vm/src/workspace-snapshot.test.ts`
Expected: FAIL — `bridge.chmod`/`bridge.symlink` missing and/or restore doesn't apply modes/symlinks.

- [ ] **Step 3: Implement**

In `fs-bridge.ts`, add (page-side, emit `file.changed`):

```ts
symlink(target: string, linkPath: string): void {
  this.suppress++;
  try {
    const w = this.fs.SearchPath(this.ws(linkPath));
    if (w.id !== -1) throw new ErrnoError("EEXIST", { path: linkPath, syscall: "symlink" });
    const id = this.fs.CreateSymlink(w.name, w.parentid, target);
    this.paths.set(id, this.ws(linkPath));
  } finally { this.suppress--; }
  this.emitChange(this.cpath(linkPath), "create");
}

chmod(path: string, mode: number): void {
  const w = this.fs.SearchPath(this.ws(path));
  if (w.id === -1) throw new ErrnoError("ENOENT", { path, syscall: "chmod" });
  const inode = this.fs.GetInode(w.id);
  inode.mode = (inode.mode & ~0o7777) | (mode & 0o7777);
  inode.qid.version++;
  this.emitChange(this.cpath(path), "modify");
}
```

In `workspace-snapshot.ts` `restoreWorkspace`, extend the `write` walk to apply modes + create symlinks:

```ts
const write = async (node: SnapshotFsNode, prefix: string): Promise<void> => {
  if (node.type === "directory") {
    if (prefix !== "") { await bridge.mkdir(prefix, { recursive: true }); bridge.chmod(prefix, node.mode); }
    for (const [name, child] of Object.entries(node.children)) await write(child, prefix + "/" + name);
  } else if (node.type === "file") {
    await bridge.writeFile(prefix, Uint8Array.from(Buffer.from(node.data, "base64")));
    bridge.chmod(prefix, node.mode);
  } else if (node.type === "symlink") {
    bridge.symlink(node.target, prefix);
  }
};
```

- [ ] **Step 4: Run to verify pass + commit**

Run: `pnpm vitest run packages/runtime-vm/src/workspace-snapshot.test.ts && pnpm typecheck && pnpm lint:deps`
Expected: PASS.

```bash
git add packages/runtime-vm
git commit -m "feat(runtime-vm): snapshot restore honors file modes + symlinks (bridge.chmod/symlink)"
```

---

### Task 6: `Fs9pBridge` async-side hardening — skeleton-dir rejection + empty-file readFile

Two Round-11a final-review items for the ASYNC bridge (SyncFs9pFs already has these): reject page mutations under skeleton mount points (`EACCES`, so the app can't fork reality by writing to `/bin`/`/tmp` where the guest can't see it), and make `readFile` of an empty/never-written file return 0 bytes instead of `ENOENT` (Spike E: such files have no `inodedata` entry so `read_file` returns null).

**Files:**
- Modify: `packages/runtime-vm/src/fs-bridge.ts`
- Test: `packages/runtime-vm/src/fs-bridge.test.ts` (extend)

**Interfaces:** no signature changes — `writeFile`/`mkdir`/`rm`/`rename` reject skeleton-dir paths; `readFile` of an empty file returns `new Uint8Array(0)`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/runtime-vm/src/fs-bridge.test.ts`:

```ts
  it("rejects page writes under a skeleton dir with EACCES", async () => {
    const fs = makeFakeFs9p(); bootWorkspace(fs);
    const bridge = new Fs9pBridge(fs, () => {}); bridge.attach();
    await expect(bridge.writeFile("/usr/x", "no")).rejects.toThrow(/EACCES/);
    await expect(bridge.mkdir("/tmp/y", { recursive: true })).rejects.toThrow(/EACCES/);
  });

  it("readFile of an empty (never-written) file returns 0 bytes, not ENOENT", async () => {
    const fs = makeFakeFs9p(); bootWorkspace(fs);
    const bridge = new Fs9pBridge(fs, () => {}); bridge.attach();
    fs.CreateFile("empty.txt", fs.SearchPath("workspace").id); // inode, no inodedata, size 0
    expect((await bridge.readFile("/empty.txt")).length).toBe(0);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/runtime-vm/src/fs-bridge.test.ts`
Expected: FAIL — writes under `/usr`/`/tmp` currently succeed; empty-file readFile currently throws ENOENT (read_file returns null).

- [ ] **Step 3: Implement**

In `fs-bridge.ts`:
- Add a `private guardSkeleton(path, syscall)` (same as SyncFs9pFs's) and call it at the top of `writeFile`, `mkdir`, `rm`, and `rename` (both `from` and `to`).
- In `readFile`: when `read_file` returns null, check whether the inode exists (SearchPath) — if it exists (empty file), return `new Uint8Array(0)`; only throw ENOENT if the path truly doesn't resolve.

```ts
async readFile(path: string): Promise<Uint8Array> {
  const w = this.fs.SearchPath(this.ws(path));
  if (w.id === -1) throw new ErrnoError("ENOENT", { path, syscall: "open" });
  const data = await this.fs.read_file(this.ws(path));
  return data ?? new Uint8Array(0); // empty/never-written file: inode exists, no inodedata
}
```

- [ ] **Step 4: Run to verify pass + Node gated re-verify + commit**

Run: `pnpm vitest run packages/runtime-vm && pnpm typecheck && pnpm lint:deps`
Expected: PASS.
Run: `ERDOU_VM_E2E=1 pnpm vitest run packages/runtime-vm/src/vm-runtime.conformance.test.ts`
Expected: still 24/24 green (skeleton-dir writes aren't exercised by conformance, which writes to `/f.txt`, `/a/b`, etc. — all non-skeleton; the empty-file fix only broadens acceptance).

```bash
git add packages/runtime-vm
git commit -m "fix(runtime-vm): fs-bridge rejects skeleton-dir page writes (EACCES) + empty-file readFile returns 0 bytes"
```

---

### Task 7: PTY guest daemon (`ptybridge.py`) + `guestd` pty-open op + devpts mount + RE-BAKE

Spike F verified an interactive PTY shell on a second virtio-console port (`/dev/hvc1`). Bake it into the image: mount `devpts` inside the chroot (prereq for `forkpty`), ship `ptybridge.py` at `/usr/lib/erdou/`, add a `guestd` `pty-open` op that launches it on a port and returns its pid (teardown reuses `guestd.kill`), warm its pycache, and **re-bake** `state.zst`. guestd.py is baked into the state, so any guestd change needs a re-bake by definition.

**Files:**
- Create: `packages/runtime-vm/src/guest/ptybridge.py` (verified Spike F recipe)
- Modify: `packages/runtime-vm/src/guest/guestd.py` (add the `pty-open` op)
- Modify: `packages/runtime-vm/src/guestd-protocol.ts` (add `PTY_OPEN` request + `PTY_OPENED` response frame types)
- Modify: `packages/runtime-vm/scripts/lib/preload.mjs` (GUEST_SETUP_CMD += devpts; ship ptybridge.py; PYCACHE_WARMUP_CMD += pty modules)
- Modify: `packages/runtime-vm/scripts/lib/apk.mjs`/`preload.mjs` as needed to copy ptybridge.py into `sys-root/usr/lib/erdou/`

**Interfaces:**
- Produces: guestd `pty-open {port}` → `{pid, port}` (launches the bridge, returns its daemon pid); `FrameType.PTY_OPEN="t"`, `FrameType.PTY_OPENED="T"`.
- The image now has `/dev/pts` mounted in the workspace chroot and `/usr/lib/erdou/ptybridge.py`.

- [ ] **Step 1: Add the frame types + `ptybridge.py` (verified Spike F recipe)**

In `guestd-protocol.ts` `FrameType`, add: `PTY_OPEN: "t", PTY_OPENED: "T"` (and add both to `VALID_TYPES` automatically since it's `Object.values(FrameType)`).

`packages/runtime-vm/src/guest/ptybridge.py` — ported verbatim from the verified Spike F PoC (`r11b-spikes/f/pty-poc.mjs` embeds the source; read it and transcribe). It: double-forks + setsid, opens `/dev/hvc<port>` as its ctty (`tty.setraw`), `os.forkpty()` a `/bin/sh` (TERM=vt100, PS1), writes its daemon pid to `/tmp/erdou-pty-<port>.pid`, announces `PTYBRIDGE_READY` on the port, then `select([hvc, master])` 8-bit pumps both directions and copies winsize on SIGWINCH. Take `port` as `sys.argv[1]`.

```python
#!/usr/bin/env python3
# Erdou PTY bridge — runs inside chroot /workspace. Daemonizes onto /dev/hvc<port>,
# runs an interactive /bin/sh under a real pty, and pumps bytes both ways. Verified
# by Round-11b Spike F. Launched by guestd's pty-open op: python3 ptybridge.py <port>.
import os, sys, tty, termios, fcntl, select, signal, struct

port = int(sys.argv[1]) if len(sys.argv) > 1 else 1
dev = "/dev/hvc%d" % port

if os.fork() > 0:
    os._exit(0)                 # parent (guestd's child) returns immediately
os.setsid()                     # daemon: new session, no ctty
hvc = os.open(dev, os.O_RDWR)   # becomes our controlling tty (session leader, no ctty yet)
tty.setraw(hvc)                 # raw transport; fd held → sticks
try:
    fcntl.ioctl(hvc, termios.TIOCSCTTY, 0)
except OSError:
    pass

# record the daemon pid so guestd can return it (for kill-based teardown)
try:
    with open("/tmp/erdou-pty-%d.pid" % port, "w") as f:
        f.write(str(os.getpid()))
except OSError:
    pass

pid, master = os.forkpty()      # child: real tty (pts) = stdin/out/err + ctty
if pid == 0:
    os.environ["TERM"] = "vt100"
    os.environ["PS1"] = "$ "
    os.execv("/bin/sh", ["/bin/sh"])
    os._exit(127)

def winch(_sig, _frm):
    try:
        sz = fcntl.ioctl(hvc, termios.TIOCGWINSZ, bytes(8))
        rows, cols = struct.unpack("HHHH", sz)[:2]
        if rows and cols:
            fcntl.ioctl(master, termios.TIOCSWINSZ, sz)
    except OSError:
        pass
signal.signal(signal.SIGWINCH, winch)
winch(None, None)

os.write(hvc, b"PTYBRIDGE_READY\n")   # host gates its first input on this
while True:
    try:
        r, _, _ = select.select([hvc, master], [], [])
    except InterruptedError:
        continue
    if hvc in r:
        d = os.read(hvc, 4096)
        if not d:
            break
        os.write(master, d)
    if master in r:
        try:
            d = os.read(master, 4096)
        except OSError:
            break               # EIO = shell exited
        if not d:
            break
        os.write(hvc, d)
```

- [ ] **Step 2: Add the `pty-open` op to `guestd.py`**

In `guestd.py`'s `handle()`, add a `pty-open` branch: launch the bridge, poll briefly for its pid file, reply `PTY_OPENED {pid, port}` (or an error). Keep it small:

```python
    elif type_char == "t":          # PTY_OPEN {port}
        req = json.loads(body or b"{}")
        port = int(req.get("port", 1))
        pidfile = "/tmp/erdou-pty-%d.pid" % port
        try:
            os.remove(pidfile)
        except OSError:
            pass
        subprocess.Popen(["/usr/bin/python3", "/usr/lib/erdou/ptybridge.py", str(port)],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        pid = None
        for _ in range(200):        # up to ~2s for the daemon to write its pid
            try:
                with open(pidfile) as f:
                    pid = int(f.read().strip()); break
            except (OSError, ValueError):
                import time; time.sleep(0.01)
        if pid is None:
            send_json("!", ident, {"code": "EIO", "message": "pty bridge did not start"})
        else:
            send_json("T", ident, {"pid": pid, "port": port})
```

- [ ] **Step 3: Update `preload.mjs` — devpts mount, ship ptybridge, warm pycache**

In `packages/runtime-vm/scripts/lib/preload.mjs`:
- `GUEST_SETUP_CMD`: append `; mkdir -p /mnt/workspace/dev/pts; mount -t devpts devpts /mnt/workspace/dev/pts` (mount devpts inside the workspace chroot's /dev so `forkpty` works).
- In `setupSplitFs`, also copy `ptybridge.py` into `sys-root/usr/lib/erdou/ptybridge.py` (beside guestd.py), mode 0o100755.
- `PYCACHE_WARMUP_CMD`: extend the import list with `pty, fcntl, select, struct, signal, termios` so the bridge's cold-start is warmed read-write before the ro remount.

- [ ] **Step 4: RE-BAKE + verify**

Run: `pnpm --filter @erdou/runtime-vm bake`
Expected: fresh `assets/state.zst` (the bake deletes stale `state.bin` per Round 11a Fix E). Watch the markers (SETUPDONE now includes devpts, WARMED includes the pty modules).

Then re-verify the Node gated conformance against the fresh state:
Run: `ERDOU_VM_E2E=1 pnpm vitest run packages/runtime-vm/src/vm-runtime.conformance.test.ts`
Expected: **still 24/24 green** (the pty additions don't touch exec/fs/snapshot/port).

- [ ] **Step 5: Commit (scripts + guest sources + protocol; NOT the gitignored state.zst)**

Run: `git status --short` — confirm no `state.zst`/`state.bin`/`kernel.bin`/bios staged.

```bash
git add packages/runtime-vm/src/guest packages/runtime-vm/src/guestd-protocol.ts packages/runtime-vm/scripts
git commit -m "feat(runtime-vm): PTY guest daemon (ptybridge.py) + guestd pty-open op + devpts mount; re-bake"
```

> `guestd-protocol.test.ts` should still pass (new frame types don't change the codec). If a resync test's plausibility set is affected, it isn't — `VALID_TYPES` just grows.

---

### Task 8: PTY host — `V86Host.terminal(port)` + `PtySession`

Host side of the PTY: `V86Host.terminal(port)` returns a `PtyChannel` over `virtio-console<port>-*`; `VmRuntime.openPty(opts?)` allocates a free port, calls guestd's `pty-open`, waits for `PTYBRIDGE_READY` on the port channel, and returns a streaming `PtySession { write, onData, resize, dispose }` (dispose kills the bridge via `guestd.kill(pid)`). `PtySession` is unit-tested over a fake channel + fake guestd; the real guest interaction is verified by the Task 10 browser e2e.

**Files:**
- Create: `packages/runtime-vm/src/pty.ts`, `pty.test.ts`
- Modify: `packages/runtime-vm/src/v86-host.ts` (`terminal(port)`), `guestd-client.ts` (`ptyOpen(port)`), `vm-runtime.ts` (`openPty`)

**Interfaces:**
- Produces:
  - `interface PtyChannel { send(bytes: Uint8Array): void; subscribe(cb: (bytes: Uint8Array) => void): void; resize(cols: number, rows: number): void }` — `V86Host.terminal(port: 1 | 2 | 3): PtyChannel`.
  - `GuestdClient.ptyOpen(port: number): Promise<{ pid: number; port: number }>`.
  - `interface PtySession { write(data: Uint8Array): void; onData(cb: (data: Uint8Array) => void): void; resize(cols: number, rows: number): void; dispose(): Promise<void> }`.
  - `openPtySession(channel: PtyChannel, control: { pid: number; kill(pid: number): Promise<void> }): Promise<PtySession>` in `pty.ts` — gates first write on `PTYBRIDGE_READY`, buffers pre-ready writes.
  - `VmRuntime.openPty(opts?: { cols?: number; rows?: number }): Promise<PtySession>` — allocates a port (1–3, tracked), `guestd.ptyOpen`, `openPtySession`, initial resize.

- [ ] **Step 1: Write the failing test (fake channel + fake guestd)**

`packages/runtime-vm/src/pty.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { openPtySession, type PtyChannel } from "./pty.js";

function fakeChannel(): PtyChannel & { sent: Uint8Array[]; emit: (b: Uint8Array) => void; resizes: [number, number][] } {
  let cb: (b: Uint8Array) => void = () => {};
  const sent: Uint8Array[] = []; const resizes: [number, number][] = [];
  return {
    sent, resizes,
    send: (b) => sent.push(b),
    subscribe: (fn) => { cb = fn; },
    resize: (c, r) => resizes.push([c, r]),
    emit: (b) => cb(b),
  };
}

const enc = new TextEncoder();

describe("openPtySession", () => {
  it("buffers writes until PTYBRIDGE_READY, then flushes; streams onData; resize passes through", async () => {
    const ch = fakeChannel();
    const kill = vi.fn(async () => {});
    const sessionP = openPtySession(ch, { pid: 99, kill });
    // resolve once READY arrives
    ch.emit(enc.encode("PTYBRIDGE_READY\n"));
    const session = await sessionP;

    const got: Uint8Array[] = [];
    session.onData((d) => got.push(d));
    ch.emit(enc.encode("$ "));
    expect(new TextDecoder().decode(got[0]!)).toBe("$ ");

    session.write(enc.encode("ls\n"));
    expect(ch.sent.length).toBe(1);
    session.resize(80, 24);
    expect(ch.resizes.at(-1)).toEqual([80, 24]);

    await session.dispose();
    expect(kill).toHaveBeenCalledWith(99);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/runtime-vm/src/pty.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `pty.ts` + wire the host/client/runtime**

`packages/runtime-vm/src/pty.ts`:

```ts
export interface PtyChannel {
  send(bytes: Uint8Array): void;
  subscribe(cb: (bytes: Uint8Array) => void): void;
  resize(cols: number, rows: number): void;
}

export interface PtySession {
  write(data: Uint8Array): void;
  onData(cb: (data: Uint8Array) => void): void;
  resize(cols: number, rows: number): void;
  dispose(): Promise<void>;
}

const READY = new TextEncoder().encode("PTYBRIDGE_READY");

/** Wrap a PtyChannel as a streaming PtySession. Resolves once the guest bridge
 *  announces PTYBRIDGE_READY (v86 drops input sent before the guest posts a
 *  receive buffer), buffering any pre-ready writes. dispose() kills the bridge. */
export function openPtySession(channel: PtyChannel, control: { pid: number; kill(pid: number): Promise<void> }): Promise<PtySession> {
  return new Promise((resolve) => {
    let ready = false;
    let banner = new Uint8Array(0);
    const preReady: Uint8Array[] = [];
    const dataCbs = new Set<(d: Uint8Array) => void>();

    const session: PtySession = {
      write: (d) => { if (ready) channel.send(d); else preReady.push(d); },
      onData: (cb) => { dataCbs.add(cb); },
      resize: (cols, rows) => channel.resize(cols, rows),
      dispose: async () => { await control.kill(control.pid).catch(() => {}); },
    };

    channel.subscribe((bytes) => {
      if (!ready) {
        // scan for the READY banner in the leading bytes; forward the rest as data
        const merged = new Uint8Array(banner.length + bytes.length);
        merged.set(banner, 0); merged.set(bytes, banner.length);
        const idx = indexOf(merged, READY);
        if (idx === -1) { banner = merged; return; }
        ready = true;
        for (const w of preReady) channel.send(w);
        preReady.length = 0;
        resolve(session);
        // anything after the banner+newline is live terminal data
        const after = merged.subarray(idx + READY.length);
        const nl = after.indexOf(0x0a);
        const rest = nl === -1 ? new Uint8Array(0) : after.subarray(nl + 1);
        if (rest.length) for (const cb of dataCbs) cb(rest);
        return;
      }
      for (const cb of dataCbs) cb(bytes);
    });
  });
}

function indexOf(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
```

In `v86-host.ts`, add:

```ts
terminal(port: 1 | 2 | 3): { send(b: Uint8Array): void; subscribe(cb: (b: Uint8Array) => void): void; resize(c: number, r: number): void } {
  return {
    send: (b) => this.emulator.bus.send(`virtio-console${port}-input-bytes`, b),
    subscribe: (cb) => this.emulator.add_listener(`virtio-console${port}-output-bytes`, cb),
    resize: (cols, rows) => this.emulator.bus.send(`virtio-console${port}-resize`, [cols, rows]),
  };
}
```

In `guestd-client.ts`, add `ptyOpen(port)` (a control-id request/response like `ps`, awaiting the `PTY_OPENED` frame):

```ts
ptyOpen(port: number): Promise<{ pid: number; port: number }> {
  const id = this.nextId++;
  return new Promise((resolve, reject) => {
    this.control.set(id, ({ type, body }) => {
      this.control.delete(id);
      if (type === FrameType.ERROR) reject(new Error((decodeJson(body) as { message: string }).message));
      else resolve(decodeJson(body) as { pid: number; port: number });
    });
    this.channel.send(encodeJsonFrame(FrameType.PTY_OPEN, id, { port }));
  });
}
```

(Ensure the control handler is invoked for both `PTY_OPENED` and `ERROR` frames — the existing `onFrame` control path passes `{type, body}`.)

In `vm-runtime.ts`, add port tracking + `openPty`:

```ts
private readonly ptyPorts = new Set<number>();
async openPty(opts: { cols?: number; rows?: number } = {}): Promise<PtySession> {
  const port = [1, 2, 3].find((p) => !this.ptyPorts.has(p));
  if (port === undefined) throw new Error("VmRuntime: all 3 PTY ports are in use");
  this.ptyPorts.add(port);
  const { pid } = await this.guestd.ptyOpen(port);
  const channel = this.host.terminal(port as 1 | 2 | 3);
  const session = await openPtySession(channel, { pid, kill: (p) => this.guestd.kill(p, "SIGKILL") });
  session.resize(opts.cols ?? 80, opts.rows ?? 24); // hvc<port> starts 0×0 — send an initial size
  const origDispose = session.dispose;
  session.dispose = async () => { this.ptyPorts.delete(port); await origDispose(); };
  return session;
}
```

- [ ] **Step 4: Run to verify pass + gates + commit**

Run: `pnpm vitest run packages/runtime-vm && pnpm typecheck && pnpm lint:deps`
Expected: PASS.

```bash
git add packages/runtime-vm/src
git commit -m "feat(runtime-vm): PTY host — V86Host.terminal + GuestdClient.ptyOpen + VmRuntime.openPty (streaming PtySession)"
```

---

### Task 9: Gated browser e2e — VmRuntime in headless Chromium (browser loader + sync-fs + PTY)

Productionize Spike D's verified harness into a gated test that boots the **real** runtime-vm browser path (`loadBrowserInputs` → `V86Host` → `GuestdClient` → `SyncFs9pFs` → `openPty`) in headless Chromium and asserts a smoke command, a synchronous-fs roundtrip the guest sees, and an interactive PTY exchange. This is the verification for Tasks 2, 3, 7, 8 (the browser + PTY pieces that can't be unit-tested hermetically). Gated on the baked asset + `ERDOU_VM_E2E=1` + a system Chromium.

**Files:**
- Create: `packages/runtime-vm/src/browser-entry.ts` (a tiny browser boot+self-test entry that exercises the real modules)
- Create: `packages/runtime-vm/scripts/browser-e2e/{server.mjs, run.mjs, page.html}` (static server + playwright driver + page shell — ported from Spike D's `server.mjs`/`run-browser.mjs`/`web/index.html`)
- Create: `packages/runtime-vm/src/browser.e2e.test.ts` (gated vitest that esbuild-bundles browser-entry, runs the server + driver, asserts ALL_PASS)
- Modify: `packages/runtime-vm/package.json` (devDeps: `playwright-core`, `esbuild`)

**Interfaces:**
- Produces: `bootAndSelfTest(baseUrl: string, wasmUrl: string): Promise<string>` in `browser-entry.ts` — boots VmRuntime via `loadBrowserInputs`, runs the checks, returns a `"ALL_PASS ..."` / `"FAIL ..."` string the page prints to the console for the driver to assert.
- Consumed by: the gated test (and, later, a reference for Round 11c's app wiring).

- [ ] **Step 1: `browser-entry.ts` — boot the real modules + self-test**

```ts
// Browser self-test entry: exercises the REAL runtime-vm browser path.
// esbuild-bundled and loaded by the e2e page; not part of the package's Node API.
import { loadBrowserInputs } from "./browser-assets.js";
import { V86Host } from "./v86-host.js";
import { GuestdClient } from "./guestd-client.js";
import { Fs9pBridge } from "./fs-bridge.js";
import { SyncFs9pFs } from "./sync-fs.js";
import { openPtySession } from "./pty.js";

const dec = new TextDecoder();

export async function bootAndSelfTest(baseUrl: string, wasmUrl: string): Promise<string> {
  const results: string[] = [];
  const inputs = await loadBrowserInputs({ baseUrl, wasmUrl, version: "e2e", memoryMB: 512 });
  const host = new V86Host();
  await host.boot(inputs, { bootTimeoutMs: 30_000 });
  host.run();
  const guestd = new GuestdClient(host.channel());
  await guestd.ready({ deadlineMs: 20_000 });
  results.push("READY");

  // 1) smoke: python3 → 42
  const p = await guestd.exec("python3 -c 'print(6*7)'");
  const out = (await p.stdout.text()).trim();
  results.push(out === "42" ? "PASS python-42" : `FAIL python-42 got=${out}`);

  // 2) sync-fs write the guest sees: SyncFs9pFs.writeFile then guest cat
  const sync = new SyncFs9pFs(host.fs9p, () => {});
  sync.writeFile("/sync.txt", "sync-visible");
  const cat = await guestd.exec("cat /sync.txt");
  const catOut = (await cat.stdout.text()).trim();
  results.push(catOut === "sync-visible" ? "PASS sync-fs" : `FAIL sync-fs got=${catOut}`);
  // and read a guest-written file back synchronously
  await (await guestd.exec("echo from-guest > /g.txt")).wait();
  results.push(dec.decode(sync.readFile("/g.txt")).trim() === "from-guest" ? "PASS sync-read" : "FAIL sync-read");

  // 3) PTY: open, see the prompt/echo, run a command
  const { pid, port } = await guestd.ptyOpen(1);
  const channel = host.terminal(port as 1 | 2 | 3);
  const session = await openPtySession(channel, { pid, kill: (x) => guestd.kill(x, "SIGKILL") });
  let ptyOut = "";
  session.onData((d) => { ptyOut += dec.decode(d); });
  session.resize(80, 24);
  session.write(new TextEncoder().encode("echo pty-live\n"));
  await new Promise((r) => setTimeout(r, 1500));
  results.push(ptyOut.includes("pty-live") ? "PASS pty" : `FAIL pty out=${JSON.stringify(ptyOut.slice(-80))}`);
  await session.dispose();

  const ok = results.every((r) => !r.startsWith("FAIL"));
  return (ok ? "ALL_PASS " : "SOME_FAIL ") + results.join(" | ");
}

// expose for the page
(globalThis as unknown as { bootAndSelfTest: typeof bootAndSelfTest }).bootAndSelfTest = bootAndSelfTest;
```

- [ ] **Step 2: The harness (server + page + driver) — port Spike D's verified files**

Read Spike D's `r11b-spikes/d/{server.mjs, run-browser.mjs, web/index.html, web/main.js}` and port them into `packages/runtime-vm/scripts/browser-e2e/`:
- `server.mjs`: static server serving `page.html`, the esbuild bundle, `v86.wasm`+`v86-fallback.wasm` (from node_modules), and `assets/{seabios.bin,vgabios.bin,kernel.bin,state.zst}` — parameterized by a bundle path + port (verbatim structure from Spike D's server.mjs, which already handles MIME + range).
- `page.html`: imports the bundle as `<script type="module">`, calls `bootAndSelfTest(assetsBase, wasmUrl)`, and `console.log`s the returned string (prefix `RESULT `).
- `run.mjs`: playwright-core driver (system `/usr/bin/chromium-browser`, headless, `--no-proxy-server` because this box sets `http_proxy`), captures console, exits 0 iff a `RESULT ALL_PASS` line appears — verbatim structure from Spike D's `run-browser.mjs`.

- [ ] **Step 3: The gated vitest wrapper**

`packages/runtime-vm/src/browser.e2e.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const assetsPresent = existsSync(join(here, "..", "assets", "state.zst"));
const chromium = ["/usr/bin/chromium-browser", "/usr/bin/chromium"].find(existsSync);
const RUN = assetsPresent && process.env.ERDOU_VM_E2E === "1" && !!chromium;

describe.skipIf(!RUN)("VmRuntime browser e2e (gated)", () => {
  it("boots in headless Chromium and passes smoke + sync-fs + PTY", () => {
    // The driver esbuild-bundles browser-entry.ts, serves it + assets, runs Chromium,
    // and exits 0 iff RESULT ALL_PASS. Delegating to a script keeps vitest out of the
    // browser process lifecycle.
    const out = execFileSync("node", [join(here, "..", "scripts", "browser-e2e", "run.mjs")], {
      encoding: "utf8", timeout: 120_000, env: { ...process.env, CHROMIUM: chromium! },
    });
    expect(out).toMatch(/RESULT ALL_PASS/);
  }, 120_000);
});
```

(`run.mjs` does the esbuild bundling of `browser-entry.ts` at start — `esbuild.build({ entryPoints:[browser-entry], bundle:true, format:"esm", outfile:<tmp>, platform:"browser" })` — then starts the server and Chromium. Port Spike D's structure; add the esbuild step.)

- [ ] **Step 4: Add devDeps + run the gated browser e2e**

Add to `packages/runtime-vm/package.json` devDependencies: `"playwright-core": "^1.61.1"`, `"esbuild": "^0.27.7"` (versions matching node_modules). Run `pnpm install`.

Run: `ERDOU_VM_E2E=1 pnpm vitest run packages/runtime-vm/src/browser.e2e.test.ts`
Expected: **RESULT ALL_PASS** — VmRuntime boots in Chromium via the browser loader, python3→42, SyncFs9pFs writes the guest reads (and reads guest writes), and the PTY echoes `pty-live`. Boot-to-READY ~2 s (Spike D measured 1.9–2.1 s).

- [ ] **Step 5: Confirm the default suite stays hermetic + commit**

Run: `pnpm test`
Expected: the browser e2e SKIPS (no `ERDOU_VM_E2E`); green.
Run: `git status --short` — no gitignored asset staged (the bundle goes to a temp/gitignored dir; add `scripts/browser-e2e/.gitignore` for any build output).

```bash
git add packages/runtime-vm/src/browser-entry.ts packages/runtime-vm/src/browser.e2e.test.ts packages/runtime-vm/scripts/browser-e2e packages/runtime-vm/package.json pnpm-lock.yaml
git commit -m "test(runtime-vm): gated headless-Chromium e2e — browser loader + sync-fs + PTY against the real Alpine guest"
```

---

### Task 10: Final gates, README, memory

**Files:**
- Modify: `packages/runtime-vm/README.md` (browser usage + PTY + the gated browser e2e)

- [ ] **Step 1: README** — document the browser path (`loadBrowserInputs` + `V86Host` + `wasm_path` URL + `memory_size` must match; IndexedDB caching), `SyncFs9pFs` as the sync `Kernel.fs`, `openPty` streaming sessions, and how to run the two gated suites. State what Round 11c does (apps/web kernel toggle + xterm terminal + live app e2e).

- [ ] **Step 2: Final gates**

Run: `pnpm test && pnpm typecheck && pnpm lint:deps && pnpm build`
Expected: all clean; default `pnpm test` hermetic (both gated suites skip).
Run: `ERDOU_VM_E2E=1 pnpm vitest run packages/runtime-vm` (with assets baked)
Expected: BOTH gated suites green — Node conformance 24/24 + the browser e2e ALL_PASS.

- [ ] **Step 3: Commit**

Run: `git status --short` — clean (no artifacts).

```bash
git add packages/runtime-vm/README.md
git commit -m "docs(runtime-vm): browser + PTY usage; Round 11b complete — VmRuntime browser-ready, sync-fs, interactive PTY"
```

---

## Self-Review (performed while writing)

**Spike coverage:** browser boot (Spike D) → Tasks 1/2 (host refactor + browser loader) + Task 9 (headless e2e). Sync fs (Spike E) → Task 3 (`SyncFs9pFs`, exact recipe + all 7 traps). PTY (Spike F) → Tasks 7 (guest daemon + devpts + re-bake) + 8 (host `PtySession`) + 9 (e2e). Each v86/guest-touching piece names its gated verification.

**Round-11a final-review deferrals covered:** shutdown teardown → Task 4; boot fail-fast deadlines → Tasks 1 (emulator-ready timeout) + 4 (ready() deadline); snapshot mode/symlink restore → Task 5; skeleton-dir page-write rejection → Tasks 3 (sync) + 6 (async bridge); `SpawnOptions.stdin` → **deferred to 11c** (needs a conformance-test + a decision on semantics; noted, not in this round's scope). The accumulated 11a minors (FrameReader/pathOf O(n²), MAX_PAYLOAD→64KiB, getProcesses live-pid consistency, fake-fs9p name fidelity, manifest guestd.path drift) are **not** re-listed here — they're tracked in the Round-11a ledger for a future cleanup and don't block browser-readiness.

**Explicitly out of scope (Round 11c):** `Kernel.kind` union, `createVmKernel`, apps/web Studio kernel toggle + VmRuntime construction, the xterm.js terminal panel (streaming vs the browser kernel's request/response `RpcShellSession`), and the live in-app browser e2e with the kernel switch. Task 9's `browser-entry.ts` is the reference 11c wires from.

**Placeholder scan:** the harness files in Task 9 (`server.mjs`/`run.mjs`/`page.html`) are "port the verified Spike D files + add the esbuild bundling and the sync-fs/PTY checks" rather than fully transcribed — acceptable because the Spike D originals are verified, runnable, and on disk this session; the NEW logic (`browser-entry.ts`, the gated vitest wrapper) is given complete. All other code is complete.

**Type consistency:** `V86BootInputs` (Task 1) is produced by `loadNodeInputs` (Task 1) + `loadBrowserInputs` (Task 2) and consumed by `V86Host.boot` (Task 1) + `VmRuntime` (Task 1). `Fs9p` gains `inodedata` (Task 3) — the fake fs9p (test-support) and real v86 both have it; consumed by `SyncFs9pFs` (Task 3). `PtyChannel`/`PtySession` (Task 8) produced by `V86Host.terminal` + `openPtySession` and consumed by `VmRuntime.openPty` + `browser-entry.ts` (Task 9). `FrameType.PTY_OPEN/PTY_OPENED` (Task 7) used by `guestd.py` (Task 7) + `GuestdClient.ptyOpen` (Task 8). `SyncFs9pFs`/`SKELETON_DIRS` guard shared between Tasks 3 and 6. The re-bake (Task 7) changes `state.zst` that Tasks 8/9 + the Node conformance boot from — Task 7 re-verifies the Node conformance stays 24/24, and Tasks 9/10 exercise the re-baked image.

