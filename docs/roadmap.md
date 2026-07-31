# Roadmap — honestly not built yet

What Erdou ships today is in the [README](../README.md) and the [user guide](./user-guide.md). This page is the opposite: the parts of the original vision (formerly `proposal_v1.md`) and the known deferrals that are **not built**. One line each — what it is and why it waits. No dates, no promises.

## Runtime & kernel

- **64-bit VM engine (qemu-wasm)** — v86 only emulates 32-bit x86, so no x86-64 guests; qemu-wasm is tracked as a possible second engine but rides an experimental GPL QEMU fork with a single maintainer.
- **WISP relay for raw TCP** — pip/npm egress rides browser `fetch` (HTTP-only, CORS-bound); runtime `apk`, `git clone` over smart HTTP/SSH, and arbitrary sockets from the guest need a WISP-style relay server, which breaks the "no server" line and so waits.
- **Pyodide in a worker** — browser-kernel Python runs on the main thread today, so a long compute loop janks the UI; moving it to a Web Worker needs an async FS bridge across the worker boundary.
- **Go toolchain in-browser** — TinyGo-compiled `wasm32-wasi` binaries already run on the WASI host, but the real Go compiler doesn't target it usefully; a Go dev loop needs the VM plus a much bigger image.
- **WASIX / full POSIX layer** — the WASI host implements `wasi_snapshot_preview1` only; threads, sockets and fork-ish semantics for compiled binaries are out of scope until something needs them.

## Preview & serving

- **WebSockets on the browser kernel** — only the WS half is missing. SSE (contract `HttpResponse.stream`, piped through the Service Worker as a real `ReadableStream`) works on **both** kernels: the browser kernel produces it from Python via `erdou.serve` and the browser conformance suite asserts the head-time resolve plus ordered chunks through `dispatch`. WebSockets (contract `Runtime.upgrade` + the injected page shim, tunneled to the guest) reach the preview iframe on `vm:*` kernels only — the browser kernel deliberately implements no `upgrade` and declines every handshake, so HMR-over-WS and WS apps need the VM.
- **ASGI/FastAPI bridge** — the browser kernel serves WSGI apps (Flask-class) only; async ASGI needs a new bridge into Pyodide's event loop.
- **Separate preview origin** — the preview iframe is same-origin with the app (sandboxed, but CSP-level isolation of generated code from the model key wants a second origin in production).
- **Screenshots / visual assertions in the preview** — the agent already queries the DOM (`preview_read`), clicks (`preview_click`) and reads console errors (`preview_logs`) inside the preview iframe; what is missing is the pixel half of the proposal's loop — capturing the rendered frame and asserting on it, which no page-level API gives you for a live iframe (it needs a rasterization path of its own, e.g. DOM-to-canvas).

## Agent

- **Deeper multi-agent orchestration** — one level of it ships: `delegate` fans out up to 3 sub-agents in parallel, each on a throwaway runtime restored from one parent snapshot, and merges their byte-exact diffs back with wholesale conflict rejection. Unbuilt: nesting (children get `createTools()` only, so depth is capped at 1 by construction), children on anything but the browser kernel, and per-child approval (the single `pendingApproval` slot would have concurrent prompts overwrite each other, so the fan-out is approved once as a whole).
- **Streaming tool-use (incl. Anthropic parity)** — both providers' streaming paths yield text deltas only and the agent loop runs non-streaming turns; token-level streaming of tool-calling turns (and Anthropic tool-use event parity) is unbuilt.
- **Checkpoint branching** — per-run diff + per-file revert exist; named checkpoints, project branches and "open snapshot X in a new tab" don't.
- **Model capability probing (streaming / JSON-schema)** — the Settings dialog's Test button already probes an endpoint with `probeModel`: a minimal chat round-trip for reachability and latency, then a ping-tool round-trip that catches a provider silently dropping or 400-ing the `tools` field ("tool calling did not work — the agent cannot act without it"). Auto-detecting an endpoint's *streaming* and *JSON-schema* support is what remains unbuilt.

## Ecosystem & product

- **npm ecosystem on the browser kernel** — real `npm install` with lockfiles and lifecycle scripts in-tab (today: bundler inlines npm deps from a CDN at build time; real npm lives in the VM).
- **Multi-tab process/VM mapping** — the proposal's tabs-as-processes design (BroadcastChannel/SharedWorker scheduling, cross-tab task migration); single-tab today.
- **Package compatibility registry** — the community database of "runs in browser / needs VM / needs a shim"; nothing exists beyond the per-kernel docs.
- **Hosted mode** — guest quota, accounts, cloud sync, deploy targets; Erdou is strictly local-first BYO-key today.
- **Plugin marketplace / Runtime SDK packaging** — the extension points (Executor, Runtime contract) are real and CI-enforced, but there is no discovery, packaging or distribution story for third-party packs.
