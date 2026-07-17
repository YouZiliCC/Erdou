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

## Browser usage

`VmRuntime` takes a loader callback that produces v86's boot inputs — in a browser, that's `loadBrowserInputs`:

```typescript
import { loadBrowserInputs, VmRuntime } from "@erdou/runtime-vm";

const vm = new VmRuntime(
  () => loadBrowserInputs({
    baseUrl: "/vm-assets",   // dir serving seabios.bin/vgabios.bin/kernel.bin/state.zst
    wasmUrl,                 // resolved URL to v86.wasm — see "Using it in a Vite app" below
    version: "v1",           // cache key for state.zst; bump on re-bake
    memoryMB: 512,            // must equal the baked state's (default 512)
  }),
  { bootTimeoutMs: 30_000 },  // optional; also accepts `clock`
);
await vm.boot();
```

`loadBrowserInputs` fetches `state.zst` cache-first from IndexedDB (keyed by `version`; on a miss it
fetches over the network and caches the result best-effort), decompresses it with the native
`DecompressionStream`, fetches bios/vga/kernel fresh every boot, and returns the `V86BootInputs`
`VmRuntime`'s loader must resolve to. The `memoryMB` and asset set must match whatever backed
`assets/state.zst`.

### Using it in a Vite app

This is the verified recipe (Spike G) — the naive `new URL("v86/build/v86.wasm", import.meta.url).href`
does **not** work under Vite (it resolves relative to the wrong origin/base and 404s). Instead:

1. **Add `v86` as a direct dependency of the app**, pinned to the same range as `@erdou/runtime-vm`'s
   (currently `^0.5.424`), so pnpm's dedupe collapses it to a single on-disk instance shared with
   `@erdou/runtime-vm`. Then import the wasm with Vite's `?url` suffix, which emits a hashed,
   build-safe URL instead of an inline blob:

   ```typescript
   import wasmUrl from "v86/build/v86.wasm?url";

   const inputs = loadBrowserInputs({ baseUrl: "/vm-assets", wasmUrl, version: "v1" });
   ```

2. **Serve the boot assets from `public/vm-assets/`.** `kernel.bin`, `seabios.bin`, `vgabios.bin`, and
   `state.zst` live in `packages/runtime-vm/assets/` (gitignored — built locally via `download-assets`
   + `bake`, never committed). A `predev`/`prebuild` script (e.g. `scripts/link-vm-assets.mjs` in
   `apps/web`) symlinks each of them into the app's `public/vm-assets/` with `symlinkSync` (idempotent,
   `ln -sfn`-style). **The symlink targets are gitignored — never commit them or their contents.** Vite's
   dev server serves `public/` following symlinks as-is; `vite build` dereferences them into real files
   in the output, so both dev and prod see the same `/vm-assets/*` paths.

3. **`import { V86 } from "v86"` needs zero `vite.config` changes.** Vite's dependency optimizer
   prebundles the `v86` package for the browser, and its Node-ish internal references are behind
   runtime guards that never execute in a browser context — no `optimizeDeps.exclude`, no alias, no
   `define` shims required.

If you're on a non-Vite bundler that resolves `new URL(asset, import.meta.url)` against the built
asset's own location (e.g. plain esbuild with `--bundle`, as `browser-entry.ts`'s self-test build
does), that recipe is still valid there — it's specifically Vite's asset URL handling that the `?url`
suffix works around. When in doubt, prefer the Vite recipe above; it's the one this repo verified
end-to-end against a real browser boot.

### Node subpath (`@erdou/runtime-vm/node`)

The default entry (`@erdou/runtime-vm`, i.e. `index.ts`) is **browser-clean**: no top-level `node:*`
import and no bare Node global (`Buffer`, `process`, `__dirname`, …) anywhere in its import graph —
enforced by `index.browser-clean.test.ts`, which statically walks the graph and fails the build if a
node-only module (or one that references a bare Node global) becomes reachable from it. Browser/app
code must only ever import from `"@erdou/runtime-vm"`.

Node-only consumers (the conformance suite, build/bake scripts, anything running under `node`) that
need the file-based asset loaders import them from the `/node` subpath instead:

```typescript
import { loadNodeInputs, defaultAssets, assetsPresent } from "@erdou/runtime-vm/node";
```

`node.ts` is the one place `node:fs`/`node:path`/etc. are allowed — it's excluded from the
browser-clean sweep by design.

To drive v86 directly below `VmRuntime` (as `browser-entry.ts`'s self-test does, to reach `fs9p` and
the raw PTY channel), construct `V86Host` yourself — its constructor takes no arguments:

```typescript
import { V86Host } from "@erdou/runtime-vm";

const host = new V86Host();
await host.boot(inputs, { bootTimeoutMs: 30_000 });   // inputs: V86BootInputs, e.g. from loadBrowserInputs
host.run();
```

## Filesystem & PTY

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

## Networking & live preview (Round 12)

The baked state is **networked**: the bake brings up a virtio NIC, DHCPs `eth0` to `192.168.86.100`, and brings `lo` up *before* `save_state`, so a restore boots with live, addressed interfaces and zero per-boot network setup — a `127.0.0.1`-default server can bind inside the guest immediately. The bake **asserts** both (quote-split `ETH_OK`/`LO_OK` markers checked host-side) and fails loudly rather than saving a broken-networking image. This required a **re-bake** — adding `net_device` only at restore time crashes v86's per-device `set_state`, and the frozen kernel only creates `eth0` when the NIC is present at boot.

Restore MUST pass both v86 options (both are set in `v86-host.ts`):

- `net_device: { relay_url: "fetch", type: "virtio" }` — v86's in-JS `FetchNetworkAdapter` (a NAT, `router_ip=192.168.86.1`, `vm_ip=192.168.86.100`).
- `preserve_mac_from_state_image: true` — **critical.** Without it, the restored adapter never learns the guest MAC and every `connect`/`tcp_probe` hangs forever.

**Live preview.** `VmRuntime.dispatch(port, req)` reverse-proxies an HTTP request into a real guest server via `V86Host.networkAdapter()`: it `tcp_probe`s the port (a closed/loopback-only bind → a fast `502`, never a hang), opens a per-request `connect(port)`, writes the request as HTTP/1.1 bytes (`http-codec.ts`), accumulates the response, and finishes on Content-Length / chunked-terminator / a 600ms idle timer / `close` / a 15s hard cap. It then releases the connection via `TcpConn.close()` so v86's `tcp_conn` table can't leak across many sequential previews. **Servers must bind `0.0.0.0`** — a `127.0.0.1` bind is on the guest loopback (not eth0) and is unreachable through the NAT; the app surfaces this as a "bind 0.0.0.0" hint (see below).

**Port detection.** A daemon thread in `guestd.py` polls `/proc/net/tcp(6)` for LISTEN sockets, classifies each as reachable (`0.0.0.0`/eth0 IP) vs loopback-only, and pushes `"L"` port-event frames over hvc0. `VmRuntime` turns them into `port.opened` / `port.closed` (`url: "/__port__/<port>/"`), plus the existing `resource.warning` contract event for a loopback-only bind (a "bind 0.0.0.0" hint — no new contract event). Because the watcher lives in `guestd.py`, changing it requires a re-bake.

**Kernel-aware serve (apps/web).** The app's serve flow branches on the runtime's `realOs` capability. For a `realOs` runtime (the VM) it spawns the server **detached** (`runtime.exec`, which resolves on process *start*, not exit) and then awaits `port.opened` — a real `python app.py` blocks forever, so a synchronous ports-list read would never return. The browser runtime (`realOs: false`) keeps its existing synchronous path.

**Re-bake + version bump.** After any change to the bake or `guestd.py`:

```
rm -f packages/runtime-vm/assets/state.bin
pnpm --filter @erdou/runtime-vm bake
```

Then **bump `version` in `apps/web/src/lib/vm-assets.ts` AND `STATE_VERSION` in `scripts/bake-image.mjs`** (same string) so IndexedDB-cached clients re-fetch the new state (currently `alpine-3.24.1-r12-lo-baked`). The bake stamps that version into `assets/state.meta.json`, and `loadBrowserInputs` verifies it on every cache-miss fetch (`expectedStateVersion`), so a stale on-disk `state.zst` from an older bake fail-fasts with a re-bake instruction instead of being silently cached under the new key. The `state.zst`/kernel/bios binaries stay gitignored — never commit them.

**Deferred to a later round (out of scope this round):** the npm/pip network-egress gateway (spec §7) and WISP — `networkEgress` is still `"none"`. This round is preview-only; the fetch-NAT is used solely for the host→guest dispatch reverse-proxy.

## Gated test suites

The default `pnpm test` skips four slow suites, keeping CI hermetic: Node conformance, the
package's own browser e2e, apps/web's in-app PTY e2e, and apps/web's in-app preview e2e are all
`describe.skipIf`-gated off by default and report as skipped rather than run.

Run the Node conformance suite (32 tests: contract ops — spawn/kill/ps/chdir — workspace snapshotting,
live 9p sync, PTY open/write/close, a `syncFs()`/async-bridge shared-fs9p check, and the Round 12
networking checks — networked-state restore (`eth0` = 192.168.86.100), a live `networkAdapter()`, the
`dispatch` reverse-proxy into a real 0.0.0.0 guest server, and `port.opened`/`port.closed` plus the
loopback-only `resource.warning`) against the real Alpine guest:

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

Run the app-level e2e (apps/web, headless Chromium): it drives the real Studio UI end to end — toggles
the kernel selector from browser to the Linux VM, waits for the lazy boot to finish, and runs a command
in the xterm.js PTY terminal, asserting the output round-trips through the real guest:

```
ERDOU_VM_E2E=1 pnpm vitest run apps/web/src/app-vm.e2e.test.ts
```

Run the app-level **preview** e2e (apps/web, headless Chromium): it drives the real Studio UI, switches
to the VM kernel, writes a marker `index.html` into the guest and serves it with `python3 -m http.server
--bind 0.0.0.0`, then asserts the Preview panel's iframe renders the guest-served marker through the
Service Worker → `dispatch` reverse-proxy (`RESULT ALL_PASS`):

```
ERDOU_VM_E2E=1 pnpm vitest run apps/web/src/app-vm-preview.e2e.test.ts
```

All four require the baked asset (`pnpm --filter @erdou/runtime-vm bake`) and are CI-verified by the
controller before each round; these commands are for local development.

## Status (Round 11c)

**Complete:** browser boot (`loadBrowserInputs` + `V86Host`), `SyncFs9pFs` (synchronous fs9p access,
no framing/timeout), interactive PTY (`VmRuntime.openPty`, streaming with pre-launch buffering and
removable listeners so ports are safe to reuse), and gated Node conformance (30/30) + package browser
e2e (ALL_PASS). `GuestdClient.dispose()` settles every in-flight request (including `kill`/`ps`/
`ptyOpen` issued after dispose) so nothing awaiting it can hang.

**Round 11c (kernel + UI) — complete:** apps/web's Studio now has a real in-browser kernel toggle
between the existing browser runtime and this VM: `Kernel.kind` union + `createVmKernel` wire
`SyncFs9pFs` in as the VM's synchronous `Kernel.fs`; toggling lazily boots the VM on first use and
copies the workspace across (`copyWorkspace`, mirror semantics — see Known limitations); a xterm.js
`TerminalPanel` drives an interactive PTY session beside the existing request/response
`RpcShellSession` shell. Verified end-to-end by the gated app e2e above (real Chromium, real toggle,
real PTY).

**Round 12 (networking + live preview) — complete:** the baked state is now networked (`eth0` =
192.168.86.100), `VmRuntime.dispatch` reverse-proxies the preview Service Worker into a real guest
server (probe-first, HTTP/1.1 codec, connection released), and a `guestd` port watcher emits
`port.opened`/`port.closed` (+ a loopback-only `resource.warning` hint); apps/web's serve flow is
kernel-aware (detached spawn + await `port.opened` for the VM). Verified by the gated Node conformance
(30/30, incl. dispatch + port-event tests) and the gated app preview e2e (`RESULT ALL_PASS`). Deferred:
the package-registry network-egress gateway + WISP (`networkEgress` is `"none"` today).

## Known limitations

**Kernel-switch workspace copy skips the VM skeleton mount points.** `copyWorkspace` (used by apps/web's
`Studio.switchKernel`) mirrors the *user's* workspace between the browser `Vfs` and the VM's
`SyncFs9pFs`, but at the workspace root it deliberately skips the six directory names v86's guest image
bind-mounts its own system onto: `bin`, `lib`, `usr`, `proc`, `dev`, `tmp` (`SKELETON_DIRS`, exported
from this package). This is necessary — those names are the VM's own system dirs, not user content, and
copying over/into them would corrupt the guest — but it means a user project that happens to have a
**top-level** directory with one of those exact six names will never have that directory cross between
kernels: it's neither copied, deleted, nor overwritten, it's just silently skipped every switch. Nested
directories with those names (e.g. `src/lib/`) are unaffected; this only applies at workspace root.

This is inherent to the single-9p-export-with-bind-mounts design (there's no separate "user files"
export distinct from the guest's root), not a bug to fix in isolation — flagged here as a candidate for
a future round (e.g. remapping the workspace export path so skeleton dirs live outside the user's root
namespace entirely).
