# Erdou

> An open-source browser operating environment where AI agents can build, run, test and ship software without local setup.
>
> 一个让 AI Agent 能够在浏览器中自由开发、运行、测试和交付软件的开源操作环境。

Erdou builds a browser-native operating environment — a virtual filesystem, processes, a shell, snapshots and virtual ports — that AI coding agents drive as if it were a real OS, with zero local install. See [`proposal_v1.md`](./proposal_v1.md) for the full vision.

**It works end to end today:** open the web app, paste a model key, describe a task, and an AI agent operates the browser-native OS — reading/writing files, running shell commands, verifying its work — with a live trace, a file browser, and an interactive terminal.

## Try it

```bash
pnpm install
pnpm --filter @erdou/web dev     # open the printed URL, click "Model", paste your key
```

Everything runs in your browser; only the model API call leaves it (proxied in dev to avoid CORS). See [`apps/web`](./apps/web).

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
| [`apps/web`](./apps/web) | The web app: task composer, live agent trace, file browser, terminal, persistence. |

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
