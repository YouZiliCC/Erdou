# Erdou Architecture

Erdou is a browser-first coding-agent OS: the runtime kernels, the agent, and the app all run
inside a browser tab. This document is the map for a contributor who just cloned the repo — what
the layers are, where the hard boundaries sit, and how to extend the system without breaking them.

## The core invariant

The project is layered strictly bottom-up. **The agent binds to the Runtime contract, never to a
concrete Runtime; a Runtime never depends on — or emits the semantics of — anything above it.**

```text
Browser APIs / WebAssembly / Web Worker / IndexedDB
                      ↓
        @erdou/runtime-contract          the frozen boundary (interfaces + errno errors only)
                      ↓
  @erdou/runtime-browser  @erdou/runtime-vm      Runtime implementations ("kernels")
  @erdou/lang-python  @erdou/runtime-wasi        contract-only adapters (executors, tools)
  @erdou/tool-git     @erdou/bundler
                      ↓
          @erdou/agent-tools             tools over the contract
                      ↓
          @erdou/agent-core              the agent loop  (+ @erdou/model-gateway for model I/O)
                      ↓
             apps/web                    the Studio app (UI, kernel switching, preview, approvals)
```

Concretely:

- A Runtime knows about files, processes, ports, snapshots, capabilities — never about models,
  prompts, tasks, or tools. Its events state facts ("process 4 exited with code 1"); deciding what
  a fact *means* is the agent's job.
- The agent negotiates behavior via `getCapabilities()` flags, never `instanceof` a concrete
  Runtime.
- Business concepts (task plans, token budgets, approvals, "the fix failed") exist only in
  agent-core and above.

**Enforcement:** `pnpm lint:deps` runs [dependency-cruiser](https://github.com/sverweij/dependency-cruiser)
over `packages/` with the rules in [`.dependency-cruiser.cjs`](../.dependency-cruiser.cjs) at the
repo root. The rules are the machine-readable form of this section: `contract-stays-pure`
(runtime-contract imports no other `@erdou` package), `runtime-never-imports-model-or-agent`,
`runtime-browser-only-contract` / `runtime-vm-only-contract`, `adapters-are-lean` (lang-*/
runtime-wasi/bundler/tool-* see only the contract), `agent-tools-is-lean`,
`agent-core-binds-to-contract`, `conformance-suite-only-contract`, and `no-circular`. Change the
architecture ⇒ change that file in the same PR.

## The Runtime contract (`packages/runtime-contract`)

The contract is plain interfaces plus one error class; it has **zero** dependencies. Key concepts,
one file each under `src/`:

- **`Runtime`** (`runtime.ts`) — the interface every kernel implements: `boot`/`shutdown`;
  `spawn`/`exec`/`kill`/`wait`/`getProcesses`; async file ops (`readFile`, `writeFile`, `readdir`,
  `mkdir`, `rm`, `rename`, `stat`); snapshots; ports; `getCapabilities`; `subscribe`.
  `exec(commandLine)` runs a shell command line and returns a handle with a **real pid** — the
  command shows up in `getProcesses()` and can be `wait()`ed/`kill()`ed like any spawn.
- **`FileSystemApi` + `Executor`** (`execution.ts`) — the extension point. `FileSystemApi` is the
  *synchronous* filesystem surface any kernel's FS satisfies. An `Executor` is a program:
  `(ctx: ExecContext) => Promise<exit code>`, where `ExecContext` is a POSIX-like surface
  (argv/env/cwd/stdio/`fs`/`serve`). A language runtime is just an Executor registered under a
  command name; because the shape maps closely to WASI, a WASI host is an Executor too.
- **Events** (`events.ts`) — `process.started/stdout/stderr/exited`, `file.changed`,
  `port.opened/closed`, `resource.warning`. Facts only, no agent semantics. Delivery may be
  asynchronous, with a hard bound: events caused by a runtime API call arrive **no later than one
  macrotask after that call's promise resolves**. Consumers needing a barrier await the call plus
  one `setTimeout(0)`; the conformance suite polls (`until`) instead of asserting same-tick arrival.
- **Snapshots** (`snapshot.ts`) — a snapshot captures the **workspace** filesystem (the
  user-visible project tree) only, never machine state; a VM kernel excludes its guest system dirs.
  File bytes are base64 so a snapshot is JSON/structured-clone-safe. `SnapshotStore` abstracts
  persistence (memory in tests, IndexedDB in the browser).
- **Virtual ports + HTTP dispatch** (`port.ts`, `http.ts`) — `listen`/`closePort` manage the bind
  table; a program serves HTTP by calling `ExecContext.serve(port, handler)` with plain
  `HttpRequest → HttpResponse` data; `Runtime.dispatch(port, req)` routes a request to whatever
  serves that port. `exposePort(port)` returns the preview URL (`/__port__/<port>/` — apps/web's
  Service Worker rewrites preview iframe fetches through `dispatch`).
- **Capabilities** (`capabilities.ts`) — `RuntimeCapabilities`: `nativeProcesses`, `virtualPorts`,
  `persistentStorage`, `threads`, `nativeAddons`, `realOs`, `interpreters`, `packageManagers`,
  `networkEgress` (`"none" | "cors-only" | "full"`), `memoryLimitMB`, `snapshotCost`. This is how
  the agent learns what world it is in.
- **Errors** (`errors.ts`) — POSIX-style `ErrnoError` (`ENOENT`, `EEXIST`, …) with the offending
  path and syscall attached. Kernels throw these instead of returning silent defaults: fail fast,
  loudly, debuggable at the call site.

## The two kernels

Both implement the same `Runtime` contract and pass the same conformance suite; they differ in
what is real.

**`@erdou/runtime-browser`** — the in-page simulated kernel. An in-memory VFS (with IndexedDB
snapshot persistence), a process table running registered `Executor`s in-process, a POSIX-ish
shell (tokenizer → parser → interpreter: pipes, redirection, `&&`/`||`/`;`, `cd`/`export` state),
shell built-ins (`ls cat grep find head tail mkdir rm cp mv touch echo pwd env which ps kill true
false`, plus `erdou serve` — a static file server on a virtual port), and a port registry backing
`serve`/`dispatch`. Instant boot, `realOs: false`; languages arrive via `registerProgram` (see
"How to add" below).

Three properties of the shell's redirection worth knowing before you use it:

- **Redirects fold left to right, per fd.** `>`/`>>`/`<` plus fd duplication — `2>&1`, `1>&2`,
  `>&2`, `&>file`, `&>>file` — resolve to one final sink per fd, in source order, so
  `cmd > log 2>&1` (both streams to the file) and `cmd 2>&1 > log` (stderr to the terminal) differ
  as POSIX says they must. Every target is opened before the command runs, as in bash: an
  overridden one is still created and truncated (`> a > b` leaves `a` empty), an unopenable one
  fails the command instead of letting it run, and a command that never starts still truncates its
  log rather than leaving the previous run's output to be read as this one's. Only fds 0/1/2 exist;
  anything else (`3> f`, `2>&3`, `2>&-`, csh `>&file`) is a loud `EINVAL` rather than a silently
  dropped redirect. Everything the shell does NOT implement — `$(...)`, backticks, `${X:-d}`,
  positional parameters, `$((…))` — likewise raises a syntax error instead of degrading to empty
  text. The behaviour is pinned against real bash: see the redirect cases in
  `packages/runtime-browser/src/shell/interpreter.test.ts`.
- **When two fds share a destination they share a stream.** `2>&1`, `&>f` and `1>&2` are a real
  `dup2`: the process is spawned with one `PipeStream` serving both fds (`mergeOutput`), so the
  writes land in the order the program made them. Merging two separate streams afterwards cannot
  do this — they carry no common ordering, so a pump on each consumes them round-robin and a
  program that printed three lines then a two-line stack trace comes back interleaved.
- **A `>` buffers the whole stream before it lands.** `drainToFile` collects the output and writes
  once, so `cmd > big.log` peaks at the size of what `cmd` printed. This is deliberate: `Vfs`
  files are single `Uint8Array`s and `appendFile` reallocates the entire file per call, so a
  chunk-by-chunk write would make one linear write quadratic. The file is in memory either way;
  the buffer only doubles the peak. Redirecting a very chatty command (`npm install &> log`) is
  bounded by the tab's heap, not by disk.

One known gap, predating the above: the `cd` / `export` / `jobs` builtins are dispatched before the
redirect machinery, so a redirect on one of them is discarded — `jobs > jobs.log` prints to the
terminal and writes no file. Redirect a builtin's output and it goes nowhere you asked.

**`@erdou/runtime-vm`** — a real 32-bit Alpine Linux guest in a [v86](https://github.com/copy/v86)
WebAssembly emulator. The Erdou VFS backs the guest's `/workspace` over 9p (the contract `/`);
the Alpine system lives outside the workspace, so snapshots stay workspace-scoped. A resident
guest daemon (`guestd`, Python) runs `exec`/`spawn`/`kill`/`ps` inside the workspace chroot over a
virtio-console channel and watches `/proc/net/tcp` to emit `port.opened`/`port.closed`.
`dispatch` reverse-proxies preview HTTP into real guest servers through v86's fetch-based NAT
(servers must bind `0.0.0.0`). The whole machine state is **baked** ahead of time into per-profile
images (`base`/`node`/`sci` — differing in apk-installed toolchains), so boot is a ~1 s state
restore. Guest `pip`/`npm` reach the real registries through the NAT plus a small egress shim
(`networkEgress: "cors-only"`); arbitrary hosts are not reachable. `realOs: true`, emulated-x86
slow. Details: [`packages/runtime-vm/README.md`](../packages/runtime-vm/README.md).

## The agent stack

- **`@erdou/agent-tools`** — `ToolDef`s that operate on the Runtime **contract** only, so one
  toolset works against any kernel: `read_file`, `write_file`, `list_dir`, `make_dir`,
  `remove_path`, `run_shell`. Tool failures return `{ ok: false, output }` rather than throw —
  the model must be able to observe and react. `createSwitchEnvironmentTool` builds the
  `switch_environment` tool from an app-provided callback + environment id list; the actual switch
  is app business, so agent-tools stays contract-only.
- **`@erdou/agent-core`** — `CodingAgent`: the plan → act → observe loop. Each step sends the
  transcript plus tool specs through the model gateway, executes returned tool calls against the
  Runtime, and finishes when the model replies without tools (or the step budget / an abort signal
  ends the run). **Gated tools:** `run_shell`, `remove_path`, `switch_environment`, and
  `open_preview` go through the optional `approve` callback before executing; a `"deny"` becomes a
  tool result the model sees. All task-level judgment lives here — the runtime only reports facts.
- **The capability-aware prompt** (`agent-core/src/prompt.ts`) — `buildSystemPrompt(env, caps)`
  branches on `caps.realOs`: the simulated kernel gets a precise "this is NOT a real Linux; these
  things do not exist" brief, the VM gets a real-but-slow-machine brief; both share the
  `ERDOU_ABOUT` orientation (bind `0.0.0.0`, relative URLs, `/workspace` persistence) and render
  the app-supplied environments catalog (interpreters, package managers, install recipes per
  `switch_environment` target). This file is the single source of truth for the agent's
  environment self-image; `ERDOU_MD_TEMPLATE` (the `/ERDOU.md` seeded into fresh workspaces by the
  app) also lives here.
- **`@erdou/model-gateway`** — a thin BYO-key connector for OpenAI-compatible and Anthropic chat
  endpoints (streaming + tool calls). Config is passed per call; non-2xx fails loudly.
- **`apps/web`** — the Studio app: kernel selector (browser / VM profiles), runs + approvals UI,
  xterm.js PTY terminal, Service-Worker preview, local-folder mounting. App-level tools are
  defined here, not in agent-tools, because they are app business: `open_preview` (opens the
  Preview panel, optionally starting a server the sanctioned detached way) is a `ToolDef` inline
  in `src/lib/studio.ts`, and the `switch_environment` callback + environments catalog
  (`src/lib/environments.ts`, derived from runtime-vm's `profiles.data.json`) are wired up there.
  In Confirm mode the app supplies the `approve` callback (Allow / Always allow / Deny; a bare
  `open_preview` without a `command` auto-allows since it runs nothing).

## Testing

Tests are Vitest, one workspace at the root (`vitest.workspace.ts` → `packages/*` + `apps/*`).
Root `pnpm test` runs everything hermetically — network- or asset-dependent suites are
`describe.skipIf`-gated and report as **visible skips**, never failures. Scope with
`pnpm --filter <pkg> test` or `pnpm exec vitest run <file>`; `pnpm typecheck` and `pnpm lint:deps`
are the other repo-wide gates.

**Conformance** (`packages/conformance`) is the compatibility bar for Runtime implementations:
`runConformance(name, makeRuntime)` runs shared filesystem/process/shell/snapshot/port/capabilities
suites that depend on the contract alone. Each kernel has a glue test that imports the concrete
class: `browser-runtime.conformance.test.ts` (always on; `pnpm conformance`) and runtime-vm's
`vm-runtime.conformance.test.ts` (gated — boots a real VM per test).

**Writing a browser-driven test: the preview Service Worker sees everything.** `startPreviewProxy`
registers `public/preview-sw.js` at ROOT scope `/`, not at `/__preview__/` — it has to, because a
previewed guest's absolute-path resources (`/assets/app.js`) resolve against the app origin and
escape the preview prefix. `routePreviewRequest` is the gate that keeps this safe (app-origin
traffic that is neither in-scope nor referred by a preview iframe passes through untouched), so
this is correct, not a bug. But it has one consequence that costs real debugging time: **the worker
intercepts before any page-level network mock**, so Playwright's `page.route` / `context.route`
never sees a request the worker handles, and the response comes from the worker (or, for
out-of-scope app traffic, from the real dev server it passes through to) no matter what the route
handler was told to return. Any driver that mocks the network at the page level must opt out at
context creation:

```js
const context = await browser.newContext({ serviceWorkers: "block" });
```

The drivers in `apps/web/scripts/*/run.mjs` do NOT block it — they exercise the worker on purpose.
Block it only when the worker is not what you are testing.

Gated suites and their env vars (all also require their assets/keys to be present):

| Gate | Suites | What it runs |
| --- | --- | --- |
| `ERDOU_VM_E2E=1` | `packages/runtime-vm/src/vm-runtime.conformance.test.ts`; `packages/runtime-vm/src/browser.e2e.test.ts`; `apps/web/src/app-vm.e2e.test.ts`; `apps/web/src/app-vm-preview.e2e.test.ts` | Full conformance against the real Alpine guest (Node); VM boot + sync-fs + PTY in headless Chromium; the Studio UI end-to-end: kernel toggle + PTY, and Preview via SW → `dispatch`. All need baked VM assets; the browser-legged three also need a `chromium` binary. |
| `ERDOU_NET_E2E=1` | `packages/runtime-vm/src/net.e2e.test.ts`; `packages/tool-git/src/net.e2e.test.ts` | Real `pip`/`npm` installs through the fetch-NAT against live registries (pypi.org, registry.npmjs.org), per baked profile, plus the two egress-dependent preview legs on the `base` image — the Flask acceptance loop and the SSE stream (`pip install flask` → head-first `dispatch` + progressive chunks); and live `git` clone/fetch/pull against github.com through isomorphic-git's `http/web` client. Both Node-legged; the runtime-vm one needs baked assets, the tool-git one needs none. **The WebSocket leg of the same file is gated differently** — `(ERDOU_VM_E2E=1 \|\| ERDOU_NET_E2E=1) && assetsPresent("node")` — because the guest WS server is dependency-free and needs no egress at all, so the VM profile alone unlocks it. |
| `ERDOU_WHEELS_E2E=1` | `apps/web/src/pip-wheels.e2e.test.ts` | Browser kernel only, headless Chromium: boots the real Vite dev server, `pip install`s openpyxl from the bundled local wheel index (no PyPI round-trip) and generates a real `.xlsx`. Needs a `chromium` binary, no VM assets. |
| `ERDOU_TWO_TAB_E2E=1` | `apps/web/src/preview-two-tab.e2e.test.ts` | Preview OWNERSHIP across tabs, browser kernel only: TWO Studio pages in ONE Chromium context (one origin ⇒ one Service Worker), each serving a differently-marked project on THE SAME port 8080. Asserts each preview renders its own project, that the `<owner>` segment in `/__preview__/<owner>/<port>/` — not the tab that asked — decides where a request dispatches, that a closed owner tab makes its preview URL 503 instead of being answered by the surviving tab, and that Studio's own traffic still passes through the root-scoped worker untouched. The only artifact that can exercise `clients.matchAll` + the `erdou:whoami` handshake + real dispatch (`preview-sw-parity.test.ts` pins only the pure routing core). Needs a `chromium` binary, no VM assets; runs in seconds. |
| `ERDOU_LIVE_KEY` (opt. `ERDOU_LIVE_BASE`, `ERDOU_LIVE_MODEL`) | `packages/agent-core/src/live.e2e.test.ts` | The CodingAgent completing a real multi-step task against a live OpenAI-compatible endpoint. |

**The bake pipeline**, in one paragraph: the VM's boot assets are built locally, never committed.
`pnpm --filter @erdou/runtime-vm download-assets` fetches the pinned kernel + BIOS; `pnpm --filter
@erdou/runtime-vm bake --profile <base|node|sci>` (or `--all`) runs `scripts/bake-image.mjs`, which
fetches the Alpine minirootfs + per-profile apk sets, boots v86 under Node, sets up the split
filesystem, networking (`eth0` DHCP'd, `lo` up) and package-manager config, **asserts** per-profile
smoke and config markers (`ETH_OK`/`LO_OK`, `PIP_OK`, `NODE_OK`/`NPM_OK`, `SCI_OK`, …) — failing
loudly rather than saving a broken image — and `save_state`s to `assets/state-<profile>.zst` + a
meta file stamped with the version from `src/profiles.data.json`. That JSON is the single source
of truth: bump the profile's version on every re-bake so browser caches refetch; a stale on-disk
state fail-fasts at load with a re-bake instruction. apps/web symlinks the assets into
`public/vm-assets/` via a `predev` script.

## How to add things

**A language pack (executor registration).** Model it on `packages/lang-python`: export an
`Executor` built against `ExecContext` only (argv/env/cwd/stdio/`fs`/`serve`) — the
`adapters-are-lean` depcruiser rule holds you to the contract. The app registers it on the browser
kernel with `BrowserRuntime.registerProgram("python", executor)` (see
`apps/web/src/lib/languages.ts`); registered names automatically surface in
`capabilities.interpreters`, which the agent prompt renders. `@erdou/runtime-wasi` shows the same
pattern for "any wasm32-wasi binary"; `@erdou/tool-git` for a tool command. Note the VM kernel
does not use executors — its languages are apk-baked into a profile (edit `profiles.data.json`,
re-bake, bump the version).

**A runtime.** Implement the `Runtime` interface importing **only** `@erdou/runtime-contract`
(depcruiser enforces this; add a rule for your package). Honor the contract's fine print: errno
errors with path + syscall, event delivery within the one-macrotask bound, workspace-scoped
snapshots, real pids from `exec`. Then write a conformance glue test calling
`runConformance("YourRuntime", () => new YourRuntime(...))` with a fresh instance per test —
passing it is the definition of "is an Erdou Runtime". `vm-runtime.conformance.test.ts` is the
template, including how to gate if booting is expensive.

**A shell built-in** (browser kernel only — the VM has real coreutils). Write a `Program` (an
alias of the contract `Executor`) in `packages/runtime-browser/src/builtins/` and add it to the
`programs` map in `createBuiltins()` (`builtins/index.ts`); `which` and the shell pick it up from
the registry. If agents should use it, also update `SHELL_BUILTINS` in
`packages/agent-core/src/prompt.ts` — the prompt is kept in sync with real capabilities by hand.
