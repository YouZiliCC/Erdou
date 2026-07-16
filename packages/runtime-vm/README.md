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
