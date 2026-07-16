# Erdou Rounds 10–12 — Tiered dual-kernel: a real-Linux VM runtime behind the same contract

**Date:** 2026-07-16
**Status:** Design — awaiting review
**Branch:** `feat/round10-dual-kernel` (off Round 9 `feat/round9-browser-server`)
**Depends on:** Rounds 1–9.

## 1. Context & goals

The simulated browser-native kernel (`runtime-browser`) is fast and zero-install, but four pain points are now blocking (all confirmed by the user):

1. **No real toolchains** — `npm install` with native deps, `gcc`, `pip` with C extensions, `apk`/`apt` don't exist.
2. **Simulation gaps burn agent steps** — missing POSIX details (sed/awk, signals, real pipes, background processes) make the model hit walls a real shell wouldn't have.
3. **No real services** — databases, long-running daemons, real listening sockets.
4. **Host-machine reach** — the user wants agent work to land on real host files.

**Constraint (locked):** zero-install, pure-browser stays non-negotiable. That rules host-side execution out (browser security model — the ceiling for host reach *is* the existing File System Access folder mount) and leaves exactly one road to real fidelity: **a real Linux VM running in the browser via WASM**.

**Decision (locked, via brainstorming):** *tiered dual-kernel*. Keep `runtime-browser` as the default fast path; add **`@erdou/runtime-vm`** — v86 emulator + Alpine Linux (x86, 32-bit) — as the real path. Both implement the same `runtime-contract`; both share the same VFS workspace; the agent adapts via `getCapabilities()`. This is not a rewrite: `notice.md` reserved the `LinuxVmRuntime` slot and capability negotiation from day one; `proposal_v1.md` §5 mandates exactly this escalation ("当 WebAssembly 或浏览器原生运行时无法满足兼容性要求时，系统应支持浏览器内虚拟机").

**Performance expectations (locked, user accepted):** 32-bit x86 guest, 10× native at best (50–300× typical for cold interpreter-heavy work), `npm install` measured in minutes, guest RAM hard-capped just under 2 GB. The VM is the compatibility floor, not the daily driver; prebaked images + ~1 s snapshot-resume absorb most of the pain.

## 2. Research foundation (all claims verified 2026-07-16, adversarially re-checked)

Engine survey — why v86 and only v86:

| Engine | License | Arch | Perf | Verdict |
|---|---|---|---|---|
| **v86** | BSD-2 (MIT-compatible) | 32-bit x86 | 10× best, 50–300× typical | ✅ chosen |
| CheerpX/WebVM | Proprietary engine; free tier is CDN-load-only, no self-host; orgs pay £100/dev/mo | 32-bit | 2–10× (fastest) | ❌ same reason WebContainers was rejected |
| container2wasm / qemu-wasm | Apache-2.0 wrapper over GPL QEMU experimental fork (not upstream, single maintainer) | x86-64 | ≈ v86 or slower (Bochs path far slower) | ⚠️ possible future second engine |
| wasm-native Linux ports (tombl/linux, linux-wasm) | GPL-2.0 | wasm itself | near-native | 🔭 pre-alpha, busybox-only, no network; track, don't adopt |

Key verified facts the design leans on:

- **v86 is active** (multiple releases/week, 23k stars) with a bus factor of ~1 (BSD-2 + pinned version + vendorable mitigates).
- **Host JS can fully provide the guest filesystem** via 9p (`filesystem.handle9p` answers raw 9p messages) — the hinge of this design (§4). Known cost: metadata-heavy loads ~12× slower over 9p (worst case: `node_modules`).
- **Snapshot resume is ~1 s real**: measured `save_state()` 145 ms / cold restore-to-shell 641 ms; copy.sh ships a 12 MB zstd Arch state. Boot-from-scratch is seconds-to-tens-of-seconds — always ship saved states.
- **Page-initiated TCP into the guest works** on the fetch network backend (`network_adapter.tcp_probe/connect`, exercised by v86's own tests) → `dispatch()` can reverse-proxy the existing preview SW into real guest servers.
- **Guest-agent channels exist**: 4 UARTs + multiport virtio-console; v86's own image tooling drives the guest over serial.
- **Alpine 3.24 x86 (32-bit) is alive and complete**: official release arch; x86 repo carries nodejs 24.17, gcc 15.2, python3 3.14, git 2.54, postgresql17, redis 8, sqlite; minirootfs 3.4 MiB; toolchain image ≈ 80–100 MiB compressed. (Fallback if Alpine ever drops x86: Void i686. Debian dropped i386 in trixie — not viable.) Caveat: on 32-bit, Node comes from the distro (upstream and unofficial-builds both exited linux-x86) — fine, apk provides it.
- **npm registry and PyPI are CORS-open** (`ACAO: *` on metadata *and* tarballs/wheels — curl-verified) → in-browser `npm install`/`pip install` against real registries needs zero infrastructure. **apk/apt mirrors send no CORS** → relay or prebake.
- **WISP protocol** (TCP-over-WebSocket relay): spec CC-BY-4.0, v86 ships a BSD-2 client in-tree; the relay never terminates TLS (sees only host:port + ciphertext) — a strictly better trust class than the LLM CORS proxy the project already accepts.
- **Repo audit:** agent-tools/agent-core bind cleanly to the contract; the conformance suite doesn't require executor registration. But there are contract gaps (§8) and six concrete-`BrowserRuntime` touchpoints in apps/web (§8) that must be fixed *before* a second runtime — and four flagship features (diff capture, IndexedDB persistence, folder write-back, live rebuild) silently die if guest writes bypass `file.changed` (§4 prevents this by construction).
- **Prior art:** Sandpack dispatches one client API across VM/Runtime/Static/Node backends; anuraOS (AGPL — study, don't copy) proves v86 + host-JS-9p + WISP end-to-end; bolt.new proves fast-path economics; v0's retreat from browser previews to server microVMs proves users eventually demand the real path. Nobody yet ships agents-on-in-browser-Linux — the lane is open.

## 3. Non-goals / deferred

- **Full-VM replacement of the fast path** (rejected — 10–300× tax on everything, loses ms-boot and near-native esbuild/Pyodide/WASI).
- **Host execution daemon (`runtime-host`)** — conflicts with the pure-browser constraint; the contract seam (`RemoteRuntime` in notice.md) pre-seeds it for whenever that changes. Nothing this round designs against it.
- **x86-64 guests** (no open engine; qemu-wasm tracked as a future second engine), **CheerpX** (license).
- **Multi-VM scheduling / VM cloning** (proposal §5 long-term; one VM instance this arc).
- **Automatic tier escalation** (agent decides to switch kernels itself) — manual per-task selection first; observe usage before automating.
- **WebSockets/SSE/streaming through `dispatch`** — request→response only, same as Round 9.
- **apk-over-relay as a default** — the default network story is prebaked image + npm/pip gateway; WISP stays optional and off.
- **PGlite-style wasm services on the fast path** — good middle-tier idea, separate round if wanted.
- **9p perf tuning** (tmpfs node_modules tricks) — document the cost now, tune when real usage shows the hot spots.

## 4. Shared workspace — the hinge

**Erdou's existing VFS becomes the guest's filesystem server.** `runtime-vm` implements v86's `filesystem.handle9p` so the page-side VFS *is* the 9p export; the guest mounts it at `/workspace`. Guest system dirs (`/usr`, `/lib`, …) stay on the block-device image for speed.

Consequences, all by construction:

- Every guest write (`gcc -o`, `npm install`, `python app.py` output) flows through the page-side VFS → **`file.changed` fires exactly as today** → diff capture, IndexedDB persistence, folder write-back, and live rebuild keep working with zero app changes. (The audit showed all four silently die under any design where guest writes bypass the VFS.)
- Both kernels see the same project tree **live** — start a task on the fast path, switch to the VM to verify with real tools, no file copying.
- The **host folder mount stays at the VFS layer** and therefore works for the VM too: mount a host folder, and the real Linux guest reads/writes those files (via VFS ↔ File System Access sync). This is the answer to pain point #4 within the browser's security model.
- Sync `fs` access in apps/web stays viable (the workspace truth is host-side), though it goes behind a seam anyway (§8).

Known cost: 9p metadata ops are ~12× slower than the guest's root fs; `node_modules` is the worst case. Accepted and documented; mitigations (guest-local npm cache, tmpfs overlay tricks) are implementation-phase tuning.

## 5. `@erdou/runtime-vm` components

| Component | Role |
|---|---|
| `VmRuntime` | Implements all 21 contract methods. FS methods hit the shared VFS directly (same code path as `runtime-browser`); process methods RPC to the guest agent; `dispatch` speaks HTTP over page→guest TCP (§6). |
| Guest agent (`erdou-guestd`) | Small resident program in the guest, talking to the page over **virtio-console** with a length-prefixed framed protocol (qemu-guest-agent architecture). Duties: `exec` (streamed stdout/stderr chunks + real exit codes), `spawn`/`kill`/`wait`/`ps` (real `/proc`), listening-port watcher (poll `/proc/net/tcp` → `port.opened`/`port.closed` events). Conformance requires `spawn` of an unknown command to reject `ENOENT` → guestd resolves via `command -v` before starting. Written in **python3** (already in-image; it's a resident daemon started before the machine state is saved, so interpreter startup cost is paid once at image-bake time, not at resume). Rewrite in C only if memory footprint ever demands it. |
| Image pipeline (build-time tool, not shipped in the runtime) | Docker-based Alpine 3.24 x86 rootfs build — prebaked: busybox, bash, nodejs+npm, gcc/g++/make/musl-dev, python3+pip, git, sqlite — then boot once under v86 and save a zstd machine state. v86's in-tree `tools/docker/alpine/` pipeline is the template. First use downloads the state (+ lazily-fetched rootfs blocks) and caches in IndexedDB; every later start is a <1 s restore. |
| Terminal | The VM shell is a real PTY stream: xterm.js wired to the guest console. The terminal panel picks request/response (browser kernel) vs PTY (VM) per the session interface from §8. |

## 6. Ports & preview

`VmRuntime.dispatch(port, req)` = open a page→guest TCP connection to `port` (v86 fetch-backend `network_adapter.connect`), write the `HttpRequest` as HTTP/1.1, parse the response into an `HttpResponse`. The Round 9 preview Service Worker reverse-proxy then works **unchanged** against real guest servers — Flask backed by a real PostgreSQL previews in the same panel.

`port.opened`/`port.closed` come from guestd's port watcher (real sockets appear asynchronously — this is exactly the "serving is a registration / synchronous port.opened" assumption Round 10 removes, §8).

## 7. Network egress (guest → internet), three tiers

1. **Prebaked image (default):** toolchains are already installed; the common case needs no network at all.
2. **Page-side package gateway (default, zero infra):** guest npm/pip are preconfigured to a virtual plain-HTTP endpoint (`http://registry.npm.virtual`-style); the page-side TCP stack terminates it and fulfills requests via browser `fetch` to the real registries (npm + PyPI are CORS-open, verified — metadata and artifacts). Real `npm install` / `pip install`, still serverless. Plain HTTP inside the VM, real TLS browser-side; both tools accept a registry/index URL, so no TLS MITM and no guest CA.
3. **Optional WISP relay (off by default, user-suppliable URL, self-hostable):** needed for `apk add`, `git` over ssh/https to arbitrary hosts, database clients to external hosts — anything raw-TCP or CORS-blocked. v86's BSD-2 WISP client; relay never sees plaintext. Same infra class as the LLM CORS relay the project already accepts, better trust class.

The agent brief (§9) states which tier is active so the model doesn't fight the environment.

## 8. Round 10 — contract hardening + apps/web seams (prerequisite wave)

Do this while there is exactly one Runtime and 249 green tests. From the audit:

**Contract additions (with conformance tests):**
- `closePort` (or a served-port handle with `close()`) becomes contract — PreviewPanel's close-then-serve cycle currently depends on a concrete-only method.
- A defined **background-process + await-`port.opened`** idiom (`SpawnOptions.detached` semantics made real). A real `python app.py` blocks forever; "serve returns after registering" is a browser-kernel accident, not a contract guarantee. PreviewPanel must become event-driven instead of "read openPorts right after exec returns".
- **Snapshot semantics clarified: workspace-scoped** (the user-visible project FS), not "whole machine". Both kernels share the VFS, so `createSnapshot`/`restoreSnapshot` keep today's shape and implementation; guest machine state (installed packages) is a capability-flagged `runtime-vm` extra (v86 `save_state` → IndexedDB), not contract.
- **Events may be delivered asynchronously** — contract wording + the two apps/web spots that rely on same-tick delivery fixed (PreviewPanel port read; studio closePort/`port.closed`).
- `exec`-returned pids are waitable/killable — semantics pinned (BrowserRuntime returns pid 0 for shell lines today; define and conform).
- **`RuntimeCapabilities` enriched**: `realOs`, available interpreters/package managers, network egress tier, memory ceiling, snapshot cost class. Six booleans can't describe two kernels.
- A `file.changed` conformance test (the event apps/web depends on most is currently untested).

**apps/web seams (six concrete-class touchpoints):**
- Runtime construction behind a factory (`new BrowserRuntime()` at studio.ts:81 is the only construction site).
- `openShell()` → a session interface with two shapes: request/response (browser kernel) and PTY stream (VM).
- `registerLanguages(runtime)` → per-runtime provisioning (the VM has python/git natively; registering Pyodide onto it is meaningless).
- Sync `runtime.fs` consumers (folder mount, `computeRunChanges`, PreviewPanel detect/bundle) behind a capability-gated accessor (stays sync — workspace truth is host-side for both kernels — but typed against an interface, not the concrete class).
- `SnapshotReader` stops newing a throwaway `BrowserRuntime`.
- Diff capture tolerates late-arriving events (today it unsubscribes the instant `agent.run` resolves).

**Agent brief:** `buildSystemPrompt` hardcodes "a *simulated, browser-native* OS… no node/npm" — flatly wrong on the VM. The brief becomes capability-driven: fast path keeps the simulation warnings; VM path says "real Alpine Linux (32-bit, slow), apk needs the relay tier, npm/pip via gateway". `run_shell`'s hardcoded built-ins list likewise derives from capabilities.

**Acceptance:** all existing tests green (zero behavior regression on the browser kernel) + new conformance tests; `pnpm lint:deps` still enforces layering.

## 9. Tier selection & agent integration

- **Manual selection** per task/thread in the composer (default: fast path; a "VM" toggle). Persisted per thread. VM boots lazily on first use (state download, IndexedDB-cached), <1 s resume after.
- The agent never type-checks the runtime (notice.md rule); it reads `getCapabilities()` and the derived brief. No automatic fallback between kernels — kernel choice belongs to the user/agent, not the framework.

## 10. Error handling

Dev-principles apply: fail fast, no silent fallbacks.
- Guest errno → `ErrnoError` with the real code/path; guestd protocol breakage and VM boot/download failures throw explicit contextual errors.
- No auto-downgrade VM→browser kernel on failure.
- With WISP unconfigured, `apk`'s network failure surfaces as-is; the brief pre-announces the limitation so the model doesn't loop on retries.

## 11. Testing

- **Conformance against `VmRuntime` in Vitest/Node** — v86 runs under Node (verified experimentally). Same suite as the browser kernel; that is what `@erdou/conformance` exists for. Suite factory becomes pool/clone-friendly so per-test VM cost stays sane (saved-state restore per test, not cold boot).
- Image pipeline artifacts get a smoke test (boot → guestd exec → 9p read/write roundtrip → port probe).
- Headless-Chromium live E2E, as every round: in the VM, `gcc` compiles and runs a C program; `npm install` pulls a real package through the gateway; a Flask+sqlite app serves and renders in the preview panel.

## 12. Delivery — three independently mergeable rounds

| Round | Content | Acceptance |
|---|---|---|
| **10** | Contract hardening + conformance additions + apps/web seams + capability-driven agent brief (§8) | All existing tests green, zero fast-path regression |
| **11** | `runtime-vm` MVP: image pipeline, boot/1-s resume, guestd (exec/spawn/kill/ps), 9p `/workspace`, PTY terminal | Conformance suite green against `VmRuntime`; UI kernel toggle opens a real shell |
| **12** | Port watcher → preview integration, npm/pip gateway, optional WISP, machine-state persistence polish | Live E2E: real service in the VM, interactive in the preview panel |

## 13. Risks

- **v86 bus factor ≈ 1** — BSD-2, pinnable, forkable; 23k-star community; accept.
- **32-bit ecosystem erosion** — Alpine explicitly maintains x86 (3.24, 2026); Void i686 is the fallback; Node comes from apk (upstream exited 32-bit). Track per release.
- **9p metadata slowness** (~12×) — worst on `node_modules`; documented, tuning deferred.
- **`dispatch` latency into the guest** — acceptable for dev preview; streaming is already a deferred non-goal.
- **COOP/COEP** — v86 doesn't hard-require cross-origin isolation but benefits from it; prior art says build the shell COOP/COEP-clean. Verify compatibility with the preview SW during Round 11 (Round 7 learned the SW/opaque-origin interaction the hard way).
