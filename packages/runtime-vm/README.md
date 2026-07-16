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

`VmRuntime` takes a loader callback that produces v86's boot inputs — in a browser, that's `loadBrowserInputs`:

```typescript
import { loadBrowserInputs, VmRuntime } from "@erdou/runtime-vm";

const vm = new VmRuntime(
  () => loadBrowserInputs({
    baseUrl: "/vm-assets",                                    // dir serving seabios.bin/vgabios.bin/kernel.bin/state.zst
    wasmUrl: new URL("v86/build/v86.wasm", import.meta.url).href,
    version: "v1",                                            // cache key for state.zst; bump on re-bake
    memoryMB: 512,                                             // must equal the baked state's (default 512)
  }),
  { bootTimeoutMs: 30_000 },                                  // optional; also accepts `clock`
);
await vm.boot();
```

`loadBrowserInputs` fetches `state.zst` cache-first from IndexedDB (keyed by `version`; on a miss it
fetches over the network and caches the result best-effort), decompresses it with the native
`DecompressionStream`, fetches bios/vga/kernel fresh every boot, and returns the `V86BootInputs`
`VmRuntime`'s loader must resolve to. The `memoryMB` and asset set must match whatever backed
`assets/state.zst`.

To drive v86 directly below `VmRuntime` (as `browser-entry.ts`'s self-test does, to reach `fs9p` and
the raw PTY channel), construct `V86Host` yourself — its constructor takes no arguments:

```typescript
import { V86Host } from "@erdou/runtime-vm";

const host = new V86Host();
await host.boot(inputs, { bootTimeoutMs: 30_000 });   // inputs: V86BootInputs, e.g. from loadBrowserInputs
host.run();
```

## Filesystem & PTY (Round 11b)

**Sync filesystem:** `SyncFs9pFs` is a SYNCHRONOUS `FileSystemApi` directly over v86's in-memory fs9p —
no framing, no request/response round trip, no timeout. It reads and writes `fs9p.inodedata` in the
same process as the emulator, so host writes are immediately guest-visible (and guest writes are
immediately host-visible) with no polling. This is the synchronous `Kernel.fs` Round 11c wires into
apps/web's Studio kernel.

```typescript
import { SyncFs9pFs } from "@erdou/runtime-vm";

const fs = new SyncFs9pFs(host.fs9p, (event) => { /* RuntimeEvent, e.g. file.changed */ });
fs.writeFile("/hello.txt", "hi");
fs.readFile("/hello.txt");   // Uint8Array, returned synchronously
```

**Interactive PTY sessions:** `VmRuntime.openPty` streams shell I/O over one of 3 virtio-console ports:

```typescript
const pty = await vm.openPty({ cols: 80, rows: 24 });
pty.onData((data: Uint8Array) => console.log(new TextDecoder().decode(data)));
pty.write(new TextEncoder().encode("ls -la\n"));   // write() takes Uint8Array, not a string
pty.resize(100, 30);
await pty.dispose();                                // NOT pty.kill()
```

Opening a session subscribes to the console channel *before* launching the guest's PTY bridge, so the
bridge's `PTYBRIDGE_READY` banner can never race ahead of a listener; it resolves once both the banner
and the bridge's pid are known, and rejects (reaping the bridge) if that doesn't happen within the
deadline — 15s by default. Writes issued before READY and output that arrives before `onData` is
registered are buffered, not dropped. `dispose()` detaches the console listener and kills the bridge
process, so a port (1-3) freed by one session's `dispose()` is safe to reuse for another.

## Gated test suites (Round 11b)

The default `pnpm test` skips two slow suites, keeping CI hermetic (315 passed, 26 skipped: Node
conformance + browser e2e).

Run the Node conformance suite (24 tests: contract ops — spawn/kill/ps/chdir — workspace snapshotting,
live 9p sync, and PTY open/write/close) against the real Alpine guest:

```
rm -f packages/runtime-vm/assets/state.bin   # drop a stale decompressed-state cache, if one exists
ERDOU_VM_E2E=1 pnpm vitest run packages/runtime-vm/src/vm-runtime.conformance.test.ts
```

Run the browser e2e suite (headless Chromium): it esbuild-bundles `browser-entry.ts`, serves it plus
the baked assets, boots the real guest in Chromium, and drives a smoke test (`python3`), a `SyncFs9pFs`
round trip, and a live PTY session against it. It runs from a fresh Chromium profile each time, so
IndexedDB is always empty — every run fetches `state.zst` over the network — and it does not call
`shutdown()`, so it doesn't exercise teardown:

```
ERDOU_VM_E2E=1 pnpm vitest run packages/runtime-vm/src/browser.e2e.test.ts
```

Both require the baked asset (`pnpm --filter @erdou/runtime-vm bake`) and are CI-verified by the
controller before each round; these commands are for local development.

## Status (Round 11b)

**Complete:** browser boot (`loadBrowserInputs` + `V86Host`), `SyncFs9pFs` (synchronous fs9p access,
no framing/timeout), interactive PTY (`VmRuntime.openPty`, streaming with pre-launch buffering and
removable listeners so ports are safe to reuse), and gated Node conformance (24/24) + browser e2e
(ALL_PASS). `GuestdClient.dispose()` settles every in-flight request (including `kill`/`ps`/`ptyOpen`
issued after dispose) so nothing awaiting it can hang.

**Round 11c (kernel + UI):** apps/web Studio kernel toggle (`Kernel.kind` union + `createVmKernel`);
xterm.js terminal panel (`RpcShellSession` streaming); live in-app e2e with a kernel switch. Deferred
to Round 12: real guest-server preview (`dispatch` into a guest TCP listener) and the package-registry
network gateway (`networkEgress` is `"none"` today).
