# Erdou Round 9 — In-browser HTTP server + preview overhaul, multi-turn, and UX polish

**Date:** 2026-07-15
**Status:** Design — awaiting review
**Branch:** `feat/round9-browser-server` (off Round 8 `feat/round8-codex-shell` @ e929ffe)
**Depends on:** Rounds 1–8.

## 1. Context & goals

Six items, one combined round. The centerpiece (S1) is a real in-browser HTTP server that replaces the restrictive Service-Worker static preview; the rest are UX/agent improvements.

1. **In-browser HTTP server + flexible preview (S1).** Today's preview bundles a *forced* entry (`/src/main.tsx` or an `index.html`) and serves static files via a Service Worker under `/__preview__/<id>/`. It can't run a backend and forces an entry convention. Replace it: virtual ports become **real in the browser** — a program registers an HTTP **handler** on a port; a new preview SW is a **reverse proxy** that routes the iframe's requests to it. Flask apps run (WSGI-per-request), static sites serve from any directory, and **multiple ports** are addressable. No forced entry.
2. **Multi-turn conversation.** `CodingAgent.run(task)` starts fresh every time and the composer always opens a new thread. Make each thread a real multi-turn conversation: the agent keeps context; the composer **replies into the selected thread**; **+ New task** starts a new one.
3. **Collapsed tool calls.** The transcript renders tool args + result output inline. Collapse each tool call to a one-line summary, expandable on click.
4. **Custom components.** Replace native `<select>` and checkboxes with a custom Select + toggle; style scrollbars via CSS.
5. **File tree.** `FilePanel` renders fully-expanded and folders aren't clickable. Add per-folder expand/collapse and minimal **inline-SVG** folder/file icons (not emoji).
6. **Folder-synced session state.** When a folder is mounted, dump session state — chat/thread history + config (incl. the model API key, per decision) — to `<folder>/.erdou/`, loaded on mount (folder is source of truth). Makes a project self-contained on disk.

**Decisions locked (via brainstorming):** browser-first (no host processes); cross-port routing **from day one**; run surface = **auto-detect + a Run-config field**; **one combined spec**; the API key **is** written to `.erdou/` (with a `.erdou/.gitignore` guard so a commit can't leak it).

**Guiding principles:** browser-first is non-negotiable (`notice.md`); no over-engineering / YAGNI within each chosen scope; minimize fallbacks; fail-fast with detailed errors. The layering invariant holds (agent → contract; runtime never imports agent).

## 2. Non-goals / deferred

- **Host/OS processes or real OS ports.** Everything stays in the browser; "ports" are virtual.
- **WebSockets, SSE, streaming responses, chunked/duplex.** Request→response only this round.
- **True concurrency / blocking servers.** Handlers are request-driven; `app.run()`-style blocking servers are not supported (Pyodide is main-thread — a blocking loop would freeze the UI).
- **ASGI / async frameworks (FastAPI).** **WSGI (Flask, plain WSGI) first.** ASGI is a follow-up.
- **Moving Pyodide to a Web Worker.** It stays main-thread this round (a slow request briefly blocks the UI — acceptable for a dev preview).
- **True process backgrounding.** Serving is a *handler registration* decoupled from the (exiting) process, so we don't need it.
- **Multi-turn agent memory/summarization beyond resending the transcript.** A thread just resends its accumulated messages.
- No new runtime backend; no change to Round 8's Codex layout beyond these items.

## 3. Architecture & layering

| Layer | Package | Change |
|---|---|---|
| Contract | `@erdou/runtime-contract` | **S1** `HttpRequest`/`HttpResponse` types; `Runtime.dispatch(port, req)`; an `ExecContext` server-registration surface (`ctx.serve`). Conformance tests. |
| Kernel | `@erdou/runtime-browser` | **S1** real `PortRegistry` (handler registration + `dispatch` + `port.closed`); wiring `ctx.serve`. |
| Language | `@erdou/lang-python` | **S1** an `erdou` Python module (`erdou.serve(app, port)`) + WSGI-per-request bridge. |
| Agent | `@erdou/agent-core` | **#2** conversation continuation (`run(task, priorMessages?)`). |
| App | `apps/web` | **S1** new preview SW (reverse proxy) + static server + Preview panel; **#2** reply-in-thread; **#3** collapse; **#4** components; **#5** tree; **#6** folder state. |

**Contract expansion is the sensitive part.** `runtime-contract` is the sacred layer with a conformance suite. S1 adds a small, generic HTTP surface (no agent semantics) and must ship with conformance tests proving any Runtime that implements it behaves correctly.

---

## 4. S1 — In-browser HTTP server + preview

### 4.1 The model

A program registers a request **handler** on a virtual **port**. The preview is a **browser-side reverse proxy**: the iframe's HTTP traffic is intercepted by a Service Worker and dispatched to the handler; the response is piped back. Nothing binds a real OS socket.

```
 preview iframe ──fetch/navigate──▶ preview SW ──MessageChannel──▶ app page
      ▲                                                               │
      │                                          runtime.dispatch(port, HttpRequest)
      │                                                               │
      └────────────── HttpResponse ◀── port handler (Pyodide WSGI · static · JS)
```

Because Pyodide is **persistent on the main thread**, a Flask `app` object registered via `erdou.serve(app, port)` stays alive in Python globals and is invoked per request — no worker marshalling, no blocked process.

### 4.2 Contract additions (`runtime-contract`)

Neutral, Node-testable HTTP shapes (not the Fetch `Request`/`Response`, to keep the contract environment-agnostic and conformance-testable):

```ts
export interface HttpRequest {
  method: string;
  /** Path + query, e.g. "/api/users?q=1". */
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;      // empty for GET/HEAD
}
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}
export type HttpHandler = (req: HttpRequest) => Promise<HttpResponse> | HttpResponse;

// Runtime gains:
dispatch(port: number, req: HttpRequest): Promise<HttpResponse>;   // used by the SW bridge

// ExecContext gains a server-registration surface (the extension point for servers):
interface ExecContext {
  // …existing…
  serve(port: number, handler: HttpHandler): void;   // register; fires "port.opened"
}
```

`RuntimeEvent` gains `{ type: "port.closed"; port }`. `dispatch` on an unbound port → a 502/`ErrnoError`-style typed failure (fail-fast).

### 4.3 Kernel (`runtime-browser`)

`PortRegistry` becomes real:
- `serve(port, handler)` — register (reject `EADDRINUSE` if bound), emit `port.opened` with a preview URL.
- `dispatch(port, req)` — invoke the handler; if none, a 502.
- `close(port)` — remove + emit `port.closed`.
- `ExecContext.serve` is wired to `PortRegistry.serve` so any executor (python shim, the static server, a JS program) can register. The *process that called `serve` may exit* — the handler persists until `close` (or reset). This decouples serving from process lifetime (no backgrounding needed).

### 4.4 Python WSGI bridge (`lang-python`)

An importable `erdou` module inside Pyodide:
```python
import erdou
erdou.serve(app, port=8000)     # app is a WSGI callable (Flask app, etc.)
```
- `erdou.serve` calls a JS-exposed registration function (bound into Pyodide globals by the python executor via `ctx.serve`). It stores the `app` callable and returns immediately; the `python app.py` process exits 0.
- Per request, the registered handler (JS side) invokes Python: build a **WSGI `environ`** from the `HttpRequest` (`REQUEST_METHOD`, `PATH_INFO`, `QUERY_STRING`, `CONTENT_LENGTH`, `wsgi.input`, headers → `HTTP_*`), call `app(environ, start_response)`, collect status/headers/body → `HttpResponse`. FS is synced so file reads reflect the VFS.
- Errors in the app → a 500 with the traceback in the body (fail-fast, visible).

### 4.5 Static server + JS handlers

- Built-in **`erdou serve <dir> [port]`** (a shell builtin/executor): registers a static-file handler over the VFS `<dir>` with content-type detection (reuse Round-7's table) and an **SPA fallback** flag (`--spa`) that serves `index.html` for unmatched routes. Covers any frontend structure — no forced entry.
- A TS/React SPA flow: bundle with esbuild-wasm (existing) into a dir, then `erdou serve ./dist --spa`. The bundle step stays; the entry is whatever you point at.
- (JS in-process handlers are possible via the same `ctx.serve`, but no user-facing JS-server command this round — YAGNI.)

### 4.6 Preview SW reverse proxy (`apps/web`)

Replaces `preview-sw.ts` / `public/preview-sw.js` / `buildSite` / the srcdoc fallback:
- A SW scoped to a preview path serves the iframe and **intercepts all its requests**, forwarding each to the controlling app page over a `MessageChannel`; the page calls `runtime.dispatch(port, req)` and returns the `HttpResponse`.
- **Multi-port routing (day one):** the iframe views a **primary port**. A **relative** request (`/api/…`) → the primary port. A **cross-origin** request the SW recognizes as targeting another virtual port is routed there via a host/prefix map: the app rewrites the previewed app's knowledge of sibling services to a proxied prefix (`/__port__/<n>/…`) that the SW maps to `dispatch(<n>, …)`, and/or maps a synthetic host (`<n>.localhost`-style) → port. (Concrete scheme finalized in the plan; the SW owns the mapping.)
- Same-origin gotcha (Round 7): the iframe must be same-origin + under SW scope, so it uses `allow-same-origin` (production isolation via a separate origin is a noted follow-up).

### 4.7 Preview panel (`apps/web`)

- A **Run** field (command) + **auto-detect**: on open, scan the VFS and suggest a command — a WSGI `app` in a `.py` (→ `python <file>` that ends with `erdou.serve`), an `index.html` (→ `erdou serve . --spa`), a built `dist/` (→ `erdou serve dist --spa`). The user can edit/override.
- **Open-ports list** (from `port.opened`/`port.closed`): each open port with its label; click to view (iframe) or **open in new tab**; a stop (×) closes the port.
- Errors (run failures, dispatch 5xx) shown inline. `live` re-runs on change.

### 4.8 Removed

`buildSite`, `publishSite`, `previewUrl`, the `/__preview__/<id>/` SW static server, the srcdoc fallback, and `findEntry`'s role as the forced preview entry (the bundler keeps `findEntry` for its own use, but the preview no longer requires it).

---

## 5. #2 — Multi-turn conversation

- **agent-core:** `CodingAgent.run(task, priorMessages?: ChatMessage[])` — when `priorMessages` is provided, the loop is seeded with them + the new user turn instead of a fresh `[system, user]`; otherwise behaviour is unchanged. Returns the updated transcript.
- **Studio:** `Run` stores its `messages: ChatMessage[]` (the model transcript) alongside `trace`. New method `replyToRun(runId, task, model)` appends a user turn and continues the agent with the run's stored messages; `startRun` (new thread) unchanged. On finish, persist updated messages + trace + changes.
- **UI:** the composer, when a thread is selected and **not currently running**, sends a **reply** into it (Conversation shows the new user bubble + the continued agent turns). **+ New task** calls `startRun`. A running thread's composer is disabled (or "stop") — no concurrent turns.
- Diff capture (Round 9): each reply is a new "turn"; per-turn change capture can reuse Round 8's snapshot-around-a-run — snapshot around each turn. (Keep it simple: capture around the whole reply like a run.)

## 6. #3 — Collapsed tool calls

In `Conversation`, a `tool`+`result` pair renders as a collapsible block: a one-line header (status dot · tool name · short arg summary · a chevron), collapsed by default; clicking expands the full args and the full `result` output. Thoughts/user/done/error unchanged. Keyboard/aria: the header is a `button` with `aria-expanded`.

## 7. #4 — Custom components

- **`Select`** (`apps/web/src/components/ui/Select.tsx`): a button showing the value + a popover list; keyboard (↑/↓/Enter/Esc), click-outside close, token-styled. Replaces the Auto/Confirm `<select>` (and any other native selects).
- **`Toggle`/`Checkbox`**: a custom switch replacing the `live` checkbox and any others.
- **Scrollbars:** CSS `::-webkit-scrollbar*` — thin, `var(--faint)`/`var(--border)` thumb, transparent track — applied globally. Chromium-only, which matches Erdou's target; other engines fall back to native (acceptable).

## 8. #5 — File tree

- `FilePanel` gains per-folder **expand/collapse** state (a `Set<path>` of expanded dirs; root expanded by default, nested collapsed). Clicking a folder row toggles it; clicking a file opens it (unchanged).
- **Inline-SVG icons** (`apps/web/src/components/ui/icons.tsx`): a `Folder`/`FolderOpen` glyph and a `File` glyph, `currentColor`, ~14px, minimal line style — no emoji. A chevron indicates expand state.

## 9. #6 — Folder-synced session state

- **Written directly to the mounted folder handle, NOT through the VFS** — so session state never appears in the file tree or pollutes per-run file diffs. The state layer owns `<folder>/.erdou/` via the `DirHandleLike` directly:
  - `runs.json` — the run/thread history (same shape as the IndexedDB store).
  - `config.json` — theme, approval mode, model config **including the API key** (per decision).
  - `.erdou/.gitignore` — written with `config.json` (and anything secret) so a `git commit` in the folder can't leak the key; the file still lives on disk for local portability.
- **Folder is source of truth when mounted:** on mount, if `.erdou/` exists on the handle, hydrate runs + config from it (overriding IndexedDB/localStorage for that session); otherwise seed `.erdou/` from current state.
- **Debounced writes** on runs/config change (a dedicated debounce mirroring the folder file-sync; independent of `mountMtimes`, which stays for project files).
- `.erdou/` is never loaded into the VFS by the mount loader (add to `local-mount`'s `SKIP` set) — it's session metadata, not project files.
- On unmount, stop syncing state to the folder (revert to IndexedDB/localStorage).

## 10. Testing strategy

- **Contract/conformance (S1):** `HttpRequest`/`HttpResponse` round-trips; a Runtime `serve`+`dispatch` path (register a trivial handler, dispatch a request, assert the response); `port.opened`/`port.closed`; `dispatch` on an unbound port fails typed. Node-runnable in `@erdou/conformance`.
- **Kernel (S1):** `PortRegistry` serve/dispatch/close + EADDRINUSE.
- **Python WSGI (S1):** a tiny WSGI `app` (no framework) served via `erdou.serve`, dispatched, asserts the response — real Pyodide (gated/live like the existing python test) or a pure JS-side environ-builder unit test for the marshalling.
- **Static server (S1):** serves a VFS dir, content-types, SPA fallback.
- **agent-core (#2):** continuation seeds prior messages; a two-turn stub-gateway test shows turn 2 sees turn 1's context.
- **Diff/tree/components (#3–#5):** pure-logic where possible (tree expand state); build + headless smoke for the rest.
- **#6:** mock-handle test — mount seeds `.erdou/`, a runs/config change writes it, remount hydrates from it, `.erdou/.gitignore` written.
- **E2E (headless):** run a Flask hello-world via the Run field → the preview shows the served page; a static SPA with client routing; a cross-port fetch (SPA calling an API port); a multi-turn conversation; the collapsed tool calls; the file tree; folder-state round-trip. Keep the full suite + `pnpm lint:deps` green.

## 11. Risks & open questions

- **Contract expansion.** The HTTP surface is the sacred layer — keep it minimal and generic; conformance-test it; no agent semantics.
- **Main-thread Pyodide blocks the UI on a slow request.** Acceptable for dev preview; a worker move is a future round. Note in the env brief.
- **WSGI edge cases** (streaming responses, `wsgi.file_wrapper`, large bodies). Support the common path; document unsupported bits; fail visibly.
- **Multi-port cross-origin routing** is the trickiest UX — the exact host/prefix scheme is finalized in the plan; the fallback (serve from one port) always works.
- **Secret on disk (#6).** The `.erdou/.gitignore` guard reduces—not eliminates—leak risk (a user can still copy/share the folder). Documented; user opted in.
- **Scope.** This is a large round; §12 sequences it so each phase is shippable and independently testable.

## 12. Rollout / sequencing (phased, each shippable)

1. **S1a — Contract + kernel + conformance:** HTTP types, `serve`/`dispatch`/`close`, `PortRegistry`, `port.closed`, conformance + kernel tests. (No UI yet.)
2. **S1b — Static server + preview SW reverse proxy + Preview panel (single port):** `erdou serve`, the new SW, the open-ports list + Run field + auto-detect; remove the old preview. Static SPA works end-to-end.
3. **S1c — Python WSGI bridge:** `erdou.serve(app, port)` + per-request marshalling; Flask hello-world works.
4. **S1d — Multi-port cross-origin routing:** the SW host/prefix map; SPA-on-:8080 → API-on-:8000.
5. **#2 Multi-turn:** agent-core continuation + reply-in-thread UI.
6. **#5 File tree** + **#3 collapsed tool calls** + **#4 custom components** (independent UI; can interleave).
7. **#6 Folder-synced state.**
8. **verify** end-to-end; full Vitest + `lint:deps` green.

Nothing here changes Round 8's Codex layout beyond these items, and the layering invariant is preserved throughout.
