<p align="center">
  <img src="docs/assets/erdou-logo.png" alt="Erdou" width="180" />
</p>

<h1 align="center">Erdou</h1>

<p align="center">
  <em>An open-source browser operating environment where AI agents can build, run, test and ship software without local setup.</em><br />
  <em>一个让 AI Agent 能够在浏览器中自由开发、运行、测试和交付软件的开源操作环境。</em>
</p>

<p align="center">
  <sub>Named after <b>二豆 (Erdou)</b> — a very good dog. 🐕</sub>
</p>

Erdou builds a browser-native operating environment — a virtual filesystem, processes, a shell, snapshots and virtual ports — that AI coding agents drive as if it were a real OS, with zero local install. See [`proposal_v1.md`](./proposal_v1.md) for the full vision.

**It works end to end today:** open the web app, paste a model key, describe a task, and an AI agent operates the browser-native OS — reading/writing files, running shell commands, verifying its work — with a live trace, a file browser, and an interactive terminal.

**Environments & real packages (Round 13):** code runs either in the browser-native kernel or in a real 32-bit Alpine **Linux VM** (v86), which now ships as multiple baked profiles — `base` (Python), `node` (Node.js + npm), and `sci` (NumPy/Pandas). Real `pip install`/`npm install` work from inside the VM — guest HTTP rides the browser's own `fetch` out to PyPI/npm, with no local proxy or custom gateway — installs persist in the project workspace, and the browser kernel installs pure-Python wheels via micropip. The agent knows the whole collection and can `switch_environment` mid-task (approval-gated) when a step needs a different toolchain.

## Try it

```bash
pnpm install
pnpm --filter @erdou/web dev     # open the printed URL, click "Settings", set a model + API key
```

Everything runs in your browser; only the model API call leaves it (proxied in dev to avoid CORS). See [`apps/web`](./apps/web).

### Enable the Linux VM (optional)

The browser-native kernel works out of the box — nothing to bake. The Alpine **Linux VM** environments do **not**: their machine images are baked artifacts (gitignored, never committed), so on a fresh clone every VM option in the environment picker shows "— not baked" until you bake it yourself:

```bash
pnpm --filter @erdou/runtime-vm bake --profile base   # or: node | sci | --all
```

The bake needs two inputs:

1. **Network access to the Alpine CDN** (`dl-cdn.alpinelinux.org`) — it fetches the pinned Alpine 3.24.1 x86 minirootfs plus each profile's apk packages (a few MiB for `base`, tens of MiB for `node`/`sci`).
2. **Three boot blobs in `packages/runtime-vm/assets/`** — `kernel.bin`, `seabios.bin`, `vgabios.bin` (the v86 buildroot bzImage + SeaBIOS/VGABIOS). These have **no pinned public download URL yet**: `pnpm --filter @erdou/runtime-vm download-assets` only verifies files already staged there, so for now you must copy the three files from an existing checkout that has them (sha256 pins live in `packages/runtime-vm/assets/manifest.json`). Once URLs are filled into that manifest, `download-assets` can fetch them from scratch.

Each bake takes well under a minute and writes `assets/state-<profile>.zst` (roughly 48–84 MB per profile, downloaded once by the browser and then cached).

## Architecture invariant

Erdou follows a strict bottom-up layering (see [`notice.md`](./notice.md)). **Agent depends on Runtime; Runtime never depends on Agent.** Agents bind to the Runtime *Contract*, never to a concrete Runtime.

```
browser APIs → runtime-contract → runtime implementations → agent-tools → agent-core → app
```

This is **enforced in CI**, not merely documented — `pnpm lint:deps` fails the build on any upward or cross-layer dependency.

## Packages

| Package | Role |
| --- | --- |
| [`@erdou/runtime-contract`](./packages/runtime-contract) | The frozen boundary: pure types/interfaces every Runtime implements. Zero dependencies. |
| [`@erdou/runtime-browser`](./packages/runtime-browser) | The reference browser-native kernel: VFS, process table + in-process executor, POSIX-ish shell + built-ins, snapshots, virtual ports. |
| [`@erdou/conformance`](./packages/conformance) | A runtime-agnostic contract test suite. Any adapter that passes it satisfies the contract. |
| [`@erdou/model-gateway`](./packages/model-gateway) | A thin BYO-key connector to OpenAI-compatible and Anthropic chat APIs, incl. tool calling. Independent of the runtime. |
| [`@erdou/agent-tools`](./packages/agent-tools) | The Coding Agent's toolset (read/write/list/shell…) defined over the Runtime **contract**. |
| [`@erdou/agent-core`](./packages/agent-core) | The reference **Coding Agent** — drives a Runtime with a model in a plan→act→observe loop. |
| [`@erdou/lang-python`](./packages/lang-python) | A `python`/`python3` runtime via Pyodide (CPython/WASM) — a language pack over the executor contract. |
| [`apps/web`](./apps/web) | The web app: task composer, live agent trace, file browser, terminal, persistence. |

## Languages

Languages are a first-class extension point. The contract defines an `Executor` (`ExecContext → exit code`); a language runtime is just an `Executor` you register under a command name:

```ts
runtime.registerProgram("python", createPythonRunner({ load: loadPyodide }));
// now the shell, exec, and the agent can all run: python app.py
```

**JavaScript/TypeScript** (built-in) and **Python** (Pyodide, verified running real CPython in-browser) ship today. The same pattern adds **Ruby** (ruby.wasm), **Lua**, **SQLite**, or — via a WASI host — any `wasm32-wasi` binary from **Rust/C/C++/Zig/TinyGo**. Language packs depend only on the contract, never on a concrete Runtime.

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

License: [MIT](./LICENSE).
