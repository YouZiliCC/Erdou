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

## Browser usage (Round 11b)

The `VmRuntime` is browser-ready via `loadBrowserInputs` and `V86Host`:

```typescript
import { loadBrowserInputs, V86Host, VmRuntime } from '@erdou/runtime-vm';

// Load v86 WASM + BIOS from a server-provided URL
const inputs = await loadBrowserInputs({
  wasm_path: 'http://localhost:3000/lib/libv86.wasm',  // must match V86Host wasm_path
  memory_size: 512 * 1024 * 1024,                       // must match bake config
});

// Boot in browser (using IndexedDB for state snapshots)
const host = new V86Host(inputs);
const vm = new VmRuntime(host, { snapshotCache: 'indexeddb' });
await vm.ready();
```

The `memory_size` and WASM URL must match the backend that baked `assets/state.zst`. IndexedDB caching persists snapshots across sessions (when using `snapshot()` + `restore()`).

## Filesystem & PTY (Round 11b)

**Sync filesystem:** `VmRuntime` uses `SyncFs9pFs` as the default `Kernel.fs` — a synchronous 9p client wrapping the guest's `/workspace` over the v86 console. Reads/writes are framed with a request/response timeout (default 5s).

**Interactive PTY sessions:** stream shell I/O via `openPty`:

```typescript
const pty = await vm.openPty({ rows: 24, cols: 80 });
pty.onData(data => console.log(data.toString()));
pty.write('ls -la\n');
await pty.kill();
```

Sessions use virtio-console framing with a 10s ready timeout. Pre-launch data is buffered until `onData` attaches.

## Gated test suites (Round 11b)

The default `pnpm test` skips the slow gated suites, keeping CI hermetic (~315 tests, 26 skipped: Node conformance and browser e2e).

To run both suites (requires baked `assets/state.zst`):

```
ERDOU_VM_E2E=1 pnpm vitest run packages/runtime-vm
```

This runs:
- **Node conformance (24 tests):** contract ops (spawn, kill, ps, chdir) + workspace snapshotting + live 9p sync + PTY open/write/close.
- **Browser e2e (Chromium headless):** boot from IndexedDB snapshot, filesystem ops, PTY streaming, and shutdown teardown.

Both gated suites are CI-verified by the controller before each round; this command is for local development.

## Status (Round 11b)

**Complete:** browser boot (loadBrowserInputs + V86Host), SyncFs9pFs (sync 9p with timeout guards), interactive PTY (streaming with pre-launch buffering), and gated Node conformance (24/24) + browser e2e (ALL_PASS). All shutdown teardown flows hardened with deadlines.

**Round 11c (kernel + UI):** apps/web Studio kernel toggle (Kernel.kind union + createVmKernel); xterm.js terminal panel (RpcShellSession streaming); live in-app e2e with kernel switch. Deferred to Round 12: real guest-server preview (`dispatch` into a guest TCP listener) and the package-registry network gateway (`networkEgress` is `"none"` today).
