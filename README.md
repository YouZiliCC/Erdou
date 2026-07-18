<p align="center">
  <img src="docs/assets/erdou-logo.png" alt="Erdou" width="180" />
</p>

<h1 align="center">Erdou</h1>

<p align="center">
  <em>An open-source browser operating environment where AI agents build, run, test and ship software — with zero local setup.</em><br />
  <em>一个让 AI Agent 能够在浏览器中自由开发、运行、测试和交付软件的开源操作环境。</em>
</p>

<p align="center">
  <b>English</b> | <a href="./docs/README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <sub>Named after <b>二豆 (Èrdòu)</b> — a very good dog. 🐕</sub>
</p>

---

Erdou is a browser-native operating environment — a virtual filesystem, processes, a POSIX-ish shell, snapshots and virtual ports — that an AI coding agent drives as if it were a real machine. Everything runs inside your browser tab: your code, the shell, the language runtimes, even a full Linux VM. Only the model API call leaves it.

📖 **Docs:** [User guide](./docs/user-guide.md) · [Architecture](./docs/architecture.md) · [Roadmap](./docs/roadmap.md)

**It works end to end today:** open the web app, paste a model key, describe a task — and the agent reads and writes files, runs commands, verifies its work and shows you a reviewable diff, live.

## Highlights

- **Two kernels, one contract.** A fast browser-native kernel (VFS, process table, shell, virtual ports) and a real 32-bit **Alpine Linux VM** (v86/WASM) implement the same runtime contract. The agent adapts through capability discovery and can `switch_environment` mid-task (approval-gated) — its files follow it across kernels.
- **A serious coding agent.** Plan → act → observe loop with a live syscall-style trace, per-run **diff review and one-click revert**, multi-turn threads, Auto/Confirm approval modes, and a Stop button that actually aborts mid-call.
- **Real packages.** `pip install` / `npm install` work from *inside the VM* — guest HTTP rides the browser's own `fetch` out to PyPI/npm, no proxy server, and installs persist in the workspace. The browser kernel installs pure-Python wheels via micropip/Pyodide.
- **A real dev server, in the tab.** Programs bind ports in the sandbox; a Service Worker reverse-proxies the preview iframe onto them. Static sites, Python WSGI apps and bundled React apps all render in the Preview panel — the agent can start a server and open the preview for you.
- **Languages as plug-ins.** JavaScript/TypeScript built in; **Python** via Pyodide (real CPython in-browser); any `wasm32-wasi` binary (Rust/C/C++/Zig/TinyGo) via the WASI host. A language pack is just an `Executor` registered under a command name.
- **Git in the browser — including the network.** A `git` executor over isomorphic-git: init/add/commit/log/status/branch fully client-side, plus **clone / fetch / pull / push** over smart-HTTP (token auth with redacted logging; browsers need a CORS proxy for github.com — `--cors-proxy` / `GIT_CORS_PROXY`, Node needs none).
- **Your disk, safely.** Mount a local folder (File System Access API): two-way sync with external-edit conflict detection, an explicit mirror push, and fail-safes that refuse destructive writes.
- **Private by construction.** Projects live in IndexedDB or your mounted folder. Nothing but the model API request ever leaves the browser.

## Try it

```bash
pnpm install
pnpm --filter @erdou/web dev     # open the printed URL, click "Settings", set a model + API key
```

Everything runs in your browser; only the model API call leaves it (proxied in dev to avoid CORS). See [`apps/web`](./apps/web).

**Deploying?** `pnpm build` produces a static `apps/web/dist`. If your model provider blocks browser CORS (api.openai.com does), front it with the zero-dependency relay: `node scripts/model-proxy.mjs --target https://api.openai.com` — it streams SSE, passes `Authorization` through untouched, and stores nothing.

### Enable the Linux VM (optional)

The browser-native kernel works out of the box — nothing to bake. The Alpine **Linux VM** environments do **not**: their machine images are baked artifacts (gitignored, never committed), so on a fresh clone every VM option in the environment picker shows "— not baked" until you bake it yourself:

```bash
pnpm --filter @erdou/runtime-vm download-assets       # once: fetch + sha256-verify the boot blobs
pnpm --filter @erdou/runtime-vm bake --profile base   # or: node | sci | --all
```

A fresh clone bootstraps with **zero manual staging**: `download-assets` fetches the three boot blobs (`kernel.bin` — v86's buildroot bzImage; `seabios.bin`/`vgabios.bin` — pinned by immutable commit in the v86 repo), sha256-verifies every byte against `assets/manifest.json` (a mismatched download is deleted and the script fails loudly), and is idempotent — re-runs double as an integrity check. The bake itself additionally needs network access to the Alpine CDN (`dl-cdn.alpinelinux.org`) for the pinned Alpine 3.24.1 x86 minirootfs + each profile's apk packages.

Each bake takes well under a minute and writes `assets/state-<profile>.zst` (roughly 48–84 MB per profile, downloaded once by the browser and then cached).

## Architecture

Erdou follows a strict bottom-up layering (see [`docs/architecture.md`](./docs/architecture.md)). **Agent depends on Runtime; Runtime never depends on Agent.** Agents bind to the Runtime *Contract*, never to a concrete Runtime.

```
browser APIs → runtime-contract → runtime implementations → agent-tools → agent-core → app
```

This is **enforced in CI**, not merely documented — `pnpm lint:deps` fails the build on any upward or cross-layer dependency.

## Packages

| Package | Role |
| --- | --- |
| [`@erdou/runtime-contract`](./packages/runtime-contract) | The frozen boundary: pure types/interfaces every Runtime implements. Zero dependencies. |
| [`@erdou/runtime-browser`](./packages/runtime-browser) | The browser-native kernel: VFS, process table + in-process executor, POSIX-ish shell + built-ins (incl. honest `sed`/`awk` subsets and trailing-`&` background jobs), snapshots, virtual ports. |
| [`@erdou/runtime-vm`](./packages/runtime-vm) | The second kernel: a real 32-bit Alpine Linux guest in a v86 WASM emulator, behind the same contract. Multi-profile images, package egress, PTY. |
| [`@erdou/runtime-wasi`](./packages/runtime-wasi) | A `wasi_snapshot_preview1` host over the executor contract — runs `wasm32-wasi` binaries from Rust/C/C++/Zig/TinyGo. |
| [`@erdou/conformance`](./packages/conformance) | A runtime-agnostic contract test suite. Any adapter that passes it satisfies the contract. |
| [`@erdou/bundler`](./packages/bundler) | esbuild-wasm project bundling with npm imports inlined from esm.sh at build time — the TS/React preview path. |
| [`@erdou/lang-python`](./packages/lang-python) | `python`/`python3`/`pip` via Pyodide (CPython/WASM) — a language pack over the executor contract. |
| [`@erdou/tool-git`](./packages/tool-git) | A `git` executor via isomorphic-git over the VFS — local version control fully in-browser. |
| [`@erdou/model-gateway`](./packages/model-gateway) | A thin BYO-key connector to OpenAI-compatible and Anthropic chat APIs, incl. tool calling. Independent of the runtime. |
| [`@erdou/agent-tools`](./packages/agent-tools) | The Coding Agent's toolset (read/write/list/shell…) defined over the Runtime **contract**. |
| [`@erdou/agent-core`](./packages/agent-core) | The reference **Coding Agent** — drives a Runtime with a model in a plan→act→observe loop, with a capability-aware system prompt. |
| [`apps/web`](./apps/web) | Erdou Studio: task threads, live agent trace, diff review, file browser, terminal, preview, themes, persistence. |

## Languages

Languages are a first-class extension point. The contract defines an `Executor` (`ExecContext → exit code`); a language runtime is just an `Executor` you register under a command name:

```ts
runtime.registerProgram("python", createPythonRunner({ load: loadPyodide }));
// now the shell, exec, and the agent can all run: python app.py
```

**JavaScript/TypeScript** and **Python** ship today; the WASI host runs real Rust/C binaries. The same pattern adds Ruby (ruby.wasm), Lua, SQLite, or any other toolchain that targets `wasm32-wasi`. Language packs depend only on the contract, never on a concrete Runtime — CI enforces it.

## Development

```bash
pnpm install
pnpm test         # unit tests + conformance suite (Vitest)
pnpm typecheck    # strict TypeScript across all packages
pnpm lint:deps    # enforce the layering invariant (dependency-cruiser)
pnpm build        # emit dist/ + .d.ts for every package (tsup)
pnpm conformance  # run the conformance suite against BrowserRuntime
```

Requires Node ≥ 22 and pnpm ≥ 11. Everything is Node-runnable — the kernel needs no browser to be tested.

## Design principles

- **Fail fast, no silent fallbacks.** Every failure throws a typed errno error (`ENOENT: no such file or directory, open '/foo'`) carrying the offending path — never a swallowed default.
- **No over-engineering.** Only what the current round needs; deferred capabilities are pre-seeded by the layering, not built speculatively.
- **Keep the agent's self-image current.** The agent's system prompt — its `ABOUT ERDOU` environment brief, capability catalog and tool guidance (`packages/agent-core/src/prompt.ts`) — is a single source of truth. Any change that adds or alters a capability must update it in the same change: an agent with a stale world-model builds the wrong thing.

## License

[Apache-2.0](./LICENSE).
