# Roadmap — honestly not built yet

What Erdou ships today is in the [README](../README.md) and the [user guide](./user-guide.md). This page is the opposite: the parts of the original vision (formerly `proposal_v1.md`) and the known deferrals that are **not built**. One line each — what it is and why it waits. No dates, no promises.

## Runtime & kernel

- **64-bit VM engine (qemu-wasm)** — v86 only emulates 32-bit x86, so no x86-64 guests; qemu-wasm is tracked as a possible second engine but rides an experimental GPL QEMU fork with a single maintainer.
- **WISP relay for raw TCP** — pip/npm egress rides browser `fetch` (HTTP-only, CORS-bound); runtime `apk`, `git clone` over smart HTTP/SSH, and arbitrary sockets from the guest need a WISP-style relay server, which breaks the "no server" line and so waits.
- **Pyodide in a worker** — browser-kernel Python runs on the main thread today, so a long compute loop janks the UI; moving it to a Web Worker needs an async FS bridge across the worker boundary.
- **Go toolchain in-browser** — TinyGo-compiled `wasm32-wasi` binaries already run on the WASI host, but the real Go compiler doesn't target it usefully; a Go dev loop needs the VM plus a much bigger image.
- **WASIX / full POSIX layer** — the WASI host implements `wasi_snapshot_preview1` only; threads, sockets and fork-ish semantics for compiled binaries are out of scope until something needs them.

## Preview & serving

- **WebSockets/SSE through the preview** — the Service-Worker proxy is strictly request→response, so HMR-over-WS and streaming endpoints don't reach the preview iframe; needs a duplex bridge over the SW boundary.
- **ASGI/FastAPI bridge** — the browser kernel serves WSGI apps (Flask-class) only; async ASGI needs a new bridge into Pyodide's event loop.
- **Separate preview origin** — the preview iframe is same-origin with the app (sandboxed, but CSP-level isolation of generated code from the model key wants a second origin in production).
- **Agent-driven preview testing** — the proposal's "agent clicks the page, queries the DOM, screenshots, reads console errors" loop; today the agent can start/open the preview but not observe inside it.

## Agent

- **Multi-agent orchestration** — the proposal's main-agent-spawns-implementer/tester/reviewer tree, parallel workspaces and result merging; today there is exactly one agent loop per thread, and it stays that way until the single-agent loop stops being the bottleneck.
- **Streaming tool-use (incl. Anthropic parity)** — both providers' streaming paths yield text deltas only and the agent loop runs non-streaming turns; token-level streaming of tool-calling turns (and Anthropic tool-use event parity) is unbuilt.
- **Checkpoint branching** — per-run diff + per-file revert exist; named checkpoints, project branches and "open snapshot X in a new tab" don't.
- **Model capability probing** — the proposal's auto-detection of an endpoint's streaming/tool-call/JSON-schema support; today a misconfigured endpoint just fails loudly on first use.

## Ecosystem & product

- **npm ecosystem on the browser kernel** — real `npm install` with lockfiles and lifecycle scripts in-tab (today: bundler inlines npm deps from a CDN at build time; real npm lives in the VM).
- **Multi-tab process/VM mapping** — the proposal's tabs-as-processes design (BroadcastChannel/SharedWorker scheduling, cross-tab task migration); single-tab today.
- **Package compatibility registry** — the community database of "runs in browser / needs VM / needs a shim"; nothing exists beyond the per-kernel docs.
- **Hosted mode** — guest quota, accounts, cloud sync, deploy targets; Erdou is strictly local-first BYO-key today.
- **Plugin marketplace / Runtime SDK packaging** — the extension points (Executor, Runtime contract) are real and CI-enforced, but there is no discovery, packaging or distribution story for third-party packs.
