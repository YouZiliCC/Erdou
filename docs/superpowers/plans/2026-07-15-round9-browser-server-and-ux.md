# Round 9 — In-browser HTTP server + preview overhaul, multi-turn, UX polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the restrictive Service-Worker static preview with a real in-browser HTTP server (virtual ports → registered handlers → SW reverse proxy; Flask via WSGI, static via `erdou serve`, multi-port), plus multi-turn conversations, collapsible tool calls, custom components, an expand/collapse file tree, and folder-synced session state.

**Architecture:** Bottom-up. `runtime-contract` gains a minimal generic HTTP surface (`HttpRequest`/`HttpResponse`, `Runtime.dispatch`, `ExecContext.serve`, `port.closed`) with conformance tests; `runtime-browser` makes `PortRegistry` real; `lang-python` adds a WSGI bridge; `agent-core` gains conversation continuation; `apps/web` gets the new preview SW + panel and the UX items. Browser-first is preserved (no host processes, no real OS ports). Layering invariant holds (agent → contract; runtime never imports agent).

**Tech Stack:** TypeScript, Vitest, React 18 + Vite, Pyodide (WSGI), Service Worker, esbuild-wasm, `@erdou/*` workspace packages.

**Spec:** `docs/superpowers/specs/2026-07-15-round9-browser-server-and-ux.md`

## Global Constraints

- **Browser-first (non-negotiable, `notice.md`):** no host/OS processes, no real OS ports. "Ports" are virtual, in-browser. Data never leaves the browser (except LLM inference + thin CORS relays).
- **Layering (CI-enforced `pnpm lint:deps` over `packages/`):** agent → contract; runtime never imports agent; language packs depend on the contract only. No new cross-layer edges.
- **Contract discipline:** the `runtime-contract` HTTP surface is generic (no agent semantics: no `task`, `run`, etc.). Every contract addition ships with a `@erdou/conformance` test.
- **Dev principles:** no over-engineering / YAGNI within each chosen scope; minimize fallbacks (one correct path); fail-fast with detailed errors (`ErrnoError`/typed HTTP 5xx carrying context — never a swallowed default).
- **Non-goals (do NOT build):** WebSockets, SSE/streaming/chunked responses, true concurrency / blocking servers, ASGI/FastAPI (WSGI first), moving Pyodide to a worker, true process backgrounding, multi-turn summarization (just resend the transcript).
- **Repo gotchas:** `apps/web/tsconfig.json` sets `noUncheckedIndexedAccess: true`. `lint:deps` cruises `packages/` (not `apps/`).
- **Tests** run under Vitest, Node-runnable. Keep the whole suite + `pnpm lint:deps` green after every task. Single file: `pnpm vitest run <path>`. Web build gate: `pnpm --filter @erdou/web build`.
- **Commits:** one per task, TDD order. Branch: `feat/round9-browser-server` (already created off Round 8).

---

# Phase S1a — Contract + kernel + conformance (the HTTP surface)

## Task 1: Contract — HTTP types, `dispatch`, `ExecContext.serve`, `port.closed`

**Files:**
- Modify: `packages/runtime-contract/src/execution.ts` (add `HttpRequest`/`HttpResponse`/`HttpHandler`; add `serve` to `ExecContext`)
- Create: `packages/runtime-contract/src/http.ts` (the HTTP types) — or inline in execution.ts; prefer a dedicated `http.ts`.
- Modify: `packages/runtime-contract/src/runtime.ts` (add `dispatch`)
- Modify: `packages/runtime-contract/src/events.ts` (add `port.closed`)
- Modify: `packages/runtime-contract/src/index.ts` (export the new types)
- Test: `packages/runtime-contract/src/contract.test.ts` (type-level assertions, mirroring existing style)

**Interfaces (Produces):**
```ts
// http.ts
export interface HttpRequest { method: string; url: string; headers: Record<string,string>; body: Uint8Array; }
export interface HttpResponse { status: number; headers: Record<string,string>; body: Uint8Array; }
export type HttpHandler = (req: HttpRequest) => Promise<HttpResponse> | HttpResponse;
// runtime.ts (Runtime interface): dispatch(port: number, req: HttpRequest): Promise<HttpResponse>;
// execution.ts (ExecContext): serve(port: number, handler: HttpHandler): void;
// events.ts (RuntimeEvent union): | { type: "port.closed"; port: number }
```

- [ ] **Step 1: Add the types** — create `http.ts` with the three types; add `serve` to `ExecContext` (import `HttpHandler`); add `dispatch` to the `Runtime` interface (import `HttpRequest`/`HttpResponse`); add `port.closed` to the `RuntimeEvent` union; export all from `index.ts`.

- [ ] **Step 2: Add a type-level test** — in `contract.test.ts`, add assertions mirroring the existing `port.opened` test:
```ts
it("carries HTTP request/response + port.closed shapes", () => {
  const req: HttpRequest = { method: "GET", url: "/", headers: {}, body: new Uint8Array() };
  const res: HttpResponse = { status: 200, headers: { "content-type": "text/plain" }, body: new Uint8Array() };
  const ev: RuntimeEvent = { type: "port.closed", port: 8000 };
  expect(req.method).toBe("GET");
  expect(res.status).toBe(200);
  expect(ev.type).toBe("port.closed");
});
```

- [ ] **Step 3: Run** — `pnpm vitest run packages/runtime-contract` → green. `pnpm -w typecheck` will fail in `runtime-browser` (doesn't implement `dispatch`/`serve` yet) — that's expected and fixed in Task 2. Confirm only `runtime-contract`'s own tests/types pass here.

- [ ] **Step 4: Commit**
```bash
git add packages/runtime-contract/src
git commit -m "feat(contract): HTTP request/response types, Runtime.dispatch, ExecContext.serve, port.closed"
```

---

## Task 2: Kernel — real `PortRegistry` + `dispatch` + `ExecContext.serve` wiring

**Files:**
- Modify: `packages/runtime-browser/src/port/registry.ts` (handler registration + dispatch + close)
- Modify: `packages/runtime-browser/src/browser-runtime.ts` (`dispatch`; pass `serve` into ExecContext when spawning)
- Modify: `packages/runtime-browser/src/process/process-table.ts` (thread `serve` into the `ExecContext` it builds)
- Test: `packages/runtime-browser/src/port/registry.test.ts` (extend)

**Interfaces (Produces):**
```ts
// PortRegistry:
serve(port: number, handler: HttpHandler): void;         // EADDRINUSE if bound
dispatch(port: number, req: HttpRequest): Promise<HttpResponse>;  // 502 if unbound
close(port: number): void;                                // emits port.closed
// BrowserRuntime: dispatch(port, req) delegates to PortRegistry.
// ExecContext.serve(port, handler) → PortRegistry.serve (so executors register servers).
```

- [ ] **Step 1: Failing test** — extend `registry.test.ts`:
```ts
it("serve + dispatch invokes the handler", async () => {
  const bus = new EventBus();
  const ports = new PortRegistry(bus);
  ports.serve(8000, (req) => ({ status: 200, headers: { "content-type": "text/plain" }, body: new TextEncoder().encode("hi " + req.url) }));
  const res = await ports.dispatch(8000, { method: "GET", url: "/x", headers: {}, body: new Uint8Array() });
  expect(res.status).toBe(200);
  expect(new TextDecoder().decode(res.body)).toBe("hi /x");
});
it("dispatch on an unbound port is a 502", async () => {
  const ports = new PortRegistry(new EventBus());
  const res = await ports.dispatch(9999, { method: "GET", url: "/", headers: {}, body: new Uint8Array() });
  expect(res.status).toBe(502);
});
it("serve twice on a port throws EADDRINUSE; close frees it", () => {
  const ports = new PortRegistry(new EventBus());
  const h: HttpHandler = () => ({ status: 200, headers: {}, body: new Uint8Array() });
  ports.serve(8000, h);
  expect(() => ports.serve(8000, h)).toThrow(/EADDRINUSE/);
  ports.close(8000);
  expect(() => ports.serve(8000, h)).not.toThrow();
});
```

- [ ] **Step 2: Run to fail** — `pnpm vitest run packages/runtime-browser/src/port/registry.test.ts` → FAIL (methods missing).

- [ ] **Step 3: Implement `PortRegistry`** — replace with a handler map:
```ts
import { ErrnoError } from "@erdou/runtime-contract";
import type { HttpHandler, HttpRequest, HttpResponse } from "@erdou/runtime-contract";
import type { EventBus } from "../core/event-bus.js";

export class PortRegistry {
  private readonly handlers = new Map<number, HttpHandler>();
  constructor(private readonly bus: EventBus) {}

  serve(port: number, handler: HttpHandler): void {
    if (this.handlers.has(port)) throw new ErrnoError("EADDRINUSE", { syscall: "serve", path: String(port) });
    this.handlers.set(port, handler);
    this.bus.emit({ type: "port.opened", port, url: this.urlFor(port) });
  }
  async dispatch(port: number, req: HttpRequest): Promise<HttpResponse> {
    const handler = this.handlers.get(port);
    if (!handler) {
      return { status: 502, headers: { "content-type": "text/plain" },
               body: new TextEncoder().encode(`No server listening on port ${port}`) };
    }
    return handler(req);
  }
  close(port: number): void {
    if (this.handlers.delete(port)) this.bus.emit({ type: "port.closed", port });
  }
  isBound(port: number): boolean { return this.handlers.has(port); }
  ports(): number[] { return [...this.handlers.keys()]; }
  private urlFor(port: number): string { return `/__port__/${port}/`; }
}
```
(Keep `listen`/`exposePort` only if other code uses them; grep — if unused now, remove them and their contract methods are out of scope, so leave the contract's `listen`/`exposePort` but the app won't use them. If nothing references `listen`, you may drop it here; confirm via grep and note it.)

- [ ] **Step 4: `BrowserRuntime.dispatch` + thread `serve` into ExecContext** — add `dispatch(port, req) { return this.ports.dispatch(port, req); }`. Where the process table builds the `ExecContext` for a spawned program, add `serve: (port, handler) => this.ports.serve(port, handler)` (pass a `serve` callback from BrowserRuntime into `ProcessTable`, then into the `ExecContext`). Read `process-table.ts` to find where the context object is constructed and add the field.

- [ ] **Step 5: Run** — `pnpm vitest run packages/runtime-browser` green; `pnpm -w typecheck` green (contract now satisfied); `pnpm lint:deps` clean.

- [ ] **Step 6: Commit**
```bash
git add packages/runtime-browser/src
git commit -m "feat(runtime): real PortRegistry (serve/dispatch/close) + Runtime.dispatch + ExecContext.serve"
```

---

## Task 3: Conformance — serve/dispatch/close

**Files:**
- Modify: `packages/conformance/src/*` (add an HTTP-serving conformance case to the runtime-agnostic suite; read the existing suite structure first)
- Test: runs via `packages/runtime-browser/src/browser-runtime.conformance.test.ts` (existing harness)

- [ ] **Step 1: Add a conformance case** — in the shared suite, a test that: registers a handler via a spawned trivial program OR directly via the runtime's exposed path used by the suite, then `runtime.dispatch(port, req)` returns the handler's response; dispatch on an unbound port → 502; `port.closed` fires on close. Follow the suite's existing `it(...)`/helper conventions (the suite receives a `makeRuntime()` factory).

- [ ] **Step 2: Run** — `pnpm vitest run packages/conformance packages/runtime-browser` green.

- [ ] **Step 3: Commit**
```bash
git add packages/conformance/src packages/runtime-browser
git commit -m "test(conformance): serve/dispatch/close HTTP surface"
```

---

# Phase S1b — Static server + preview SW reverse proxy + Preview panel

## Task 4: `erdou serve` — static server executor

**Files:**
- Create: `packages/runtime-browser/src/builtins/serve.ts` (an executor: `erdou serve <dir> [port] [--spa]`)
- Modify: `packages/runtime-browser/src/builtins/index.ts` (register `erdou`)
- Test: `packages/runtime-browser/src/builtins/serve.test.ts`

**Interfaces (Produces):** an `erdou` builtin whose `serve` subcommand registers a static-file `HttpHandler` (over `ctx.fs` at `<dir>`) on `[port]` (default 8080), content-type by extension (reuse the Round-7 table — extract a shared `contentType(path)` helper if it lives in apps/web; if so, copy a small map into runtime-browser to avoid an app→runtime dep), `--spa` serves `index.html` for unmatched non-file routes. The process registers then **exits 0** (handler persists).

- [ ] **Step 1: Failing test**
```ts
it("erdou serve registers a static handler that serves files", async () => {
  const rt = new BrowserRuntime(); await rt.boot();
  rt.fs.mkdir("/site", { recursive: true });
  rt.fs.writeFile("/site/index.html", "<h1>hi</h1>");
  const p = await rt.exec("erdou serve /site 8080");
  expect((await p.wait()).code).toBe(0);
  const res = await rt.dispatch(8080, { method: "GET", url: "/index.html", headers: {}, body: new Uint8Array() });
  expect(res.status).toBe(200);
  expect(new TextDecoder().decode(res.body)).toContain("hi");
});
it("--spa falls back to index.html for unknown routes", async () => {
  const rt = new BrowserRuntime(); await rt.boot();
  rt.fs.mkdir("/site", { recursive: true });
  rt.fs.writeFile("/site/index.html", "<h1>app</h1>");
  await (await rt.exec("erdou serve /site 8080 --spa")).wait();
  const res = await rt.dispatch(8080, { method: "GET", url: "/some/route", headers: {}, body: new Uint8Array() });
  expect(res.status).toBe(200);
  expect(new TextDecoder().decode(res.body)).toContain("app");
});
```

- [ ] **Step 2: Run to fail.**

- [ ] **Step 3: Implement `serve.ts`** — parse `argv` (subcommand `serve`, positional dir + optional numeric port, `--spa` flag via `shortFlags`); resolve dir against `ctx.cwd`; build a handler that maps `req.url` (strip query, strip the `/__port__/<n>` prefix if present) to a file under dir; 404 if missing (or SPA fallback); set content-type; register with `ctx.serve(port, handler)`; write a line to stdout (`serving /site on port 8080`); return 0. Unknown subcommand → usage + exit 2.

- [ ] **Step 4: Run green** (`serve.test.ts` + package). 

- [ ] **Step 5: Commit** `feat(runtime): erdou serve — in-browser static file server on a virtual port`.

---

## Task 5: Preview SW reverse proxy + app bridge

**Files:**
- Replace: `apps/web/public/preview-sw.js` (reverse proxy, not static cache)
- Create: `apps/web/src/lib/preview-bridge.ts` (registers the SW; wires the SW⇄page `MessageChannel`; on a proxied request, calls `studio.runtime.dispatch(port, req)` and returns the `HttpResponse`)
- Modify: `apps/web/src/main.tsx` or the Studio boot (register the preview SW + install the bridge)
- Test: `apps/web/src/lib/preview-bridge.test.ts` (unit-test the request↔HttpRequest marshalling helpers; the SW/postMessage path is exercised in the E2E task)

**Interfaces (Produces):** a preview served at a same-origin scope the SW controls (e.g. `/__preview__/`); the SW intercepts requests under it, extracts the target **port** from the path (`/__preview__/<port>/<rest>` or a default primary port set via a control message), forwards `{method,url:rest,headers,body}` to the page via a `MessageChannel`, awaits the `HttpResponse`, and replies with a real `Response`. `preview-bridge.ts` exports `fetchToHttpRequest(request, urlRest): Promise<HttpRequest>` and `httpResponseToResponse(res): Response` (pure, unit-testable) + `installPreviewBridge(runtime)`.

- [ ] **Step 1: Failing test** — unit-test the marshalling:
```ts
it("marshals a fetch Request to HttpRequest and back", async () => {
  const req = new Request("http://x/__preview__/8000/api?q=1", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const hr = await fetchToHttpRequest(req, "/api?q=1");
  expect(hr.method).toBe("POST"); expect(hr.url).toBe("/api?q=1");
  expect(hr.headers["content-type"]).toBe("application/json");
  expect(new TextDecoder().decode(hr.body)).toBe("{}");
  const res = httpResponseToResponse({ status: 201, headers: { "x-a": "b" }, body: new TextEncoder().encode("ok") });
  expect(res.status).toBe(201); expect(res.headers.get("x-a")).toBe("b");
  expect(await res.text()).toBe("ok");
});
```

- [ ] **Step 2: Run to fail.**

- [ ] **Step 3: Implement** `preview-bridge.ts` (the two pure helpers + `installPreviewBridge` that `navigator.serviceWorker` message-listens: on `{type:"erdou:req", id, port, ...}` from the SW, call `runtime.dispatch(port, httpReq)` and post back `{type:"erdou:res", id, res}`). Write `public/preview-sw.js`: `fetch` handler for `/__preview__/` scope → parse `<port>/<rest>` → `postMessage` to the controlling client via a `MessageChannel`, await, respond; navigation requests (Accept: text/html, no extension) with SPA handling delegated to the port handler. Register the SW (reuse Round-7's `activeWorker` waiting pattern; scope `/__preview__/`).

- [ ] **Step 4: Run green** (marshalling test + build).

- [ ] **Step 5: Commit** `feat(web): preview Service Worker reverse-proxy + dispatch bridge`.

---

## Task 6: Preview panel rewrite (Run field + auto-detect + open-ports list); remove old preview

**Files:**
- Rewrite: `apps/web/src/components/PreviewPanel.tsx`
- Create: `apps/web/src/lib/run-detect.ts` (auto-detect a suggested run command from the VFS)
- Modify: `apps/web/src/lib/studio.ts` (track open ports from `port.opened`/`port.closed`; expose `openPorts`)
- Delete: `apps/web/src/lib/preview-sw.ts`, `apps/web/src/lib/preview-build.ts`'s `buildSite` path usage (keep esbuild bundling helper if still used by a "bundle" step; otherwise remove); `public/preview-sw.js`'s old static logic is replaced by Task 5.
- Test: `apps/web/src/lib/run-detect.test.ts`

**Interfaces (Produces):** `studio.openPorts: {port:number,url:string}[]` (updated on events). `detectRunCommand(fs): string | null` — a Flask WSGI `app` in a `.py` → `python <file>`; an `index.html` at root → `erdou serve . --spa`; a `dist/index.html` → `erdou serve dist --spa`; else null. PreviewPanel: a **Run** input (prefilled from `detectRunCommand`, editable), a **Run** button that `studio.shell.exec(cmd)` (reuse the persistent shell) then shows the open-ports list; each port → view (iframe `src="/__preview__/<port>/"`) + "open in new tab" + stop (× → `erdou stop <port>` or a studio.closePort). Errors inline. `live` re-runs.

- [ ] **Step 1: `run-detect.test.ts`** — asserts the three detection cases + null.
- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement** `run-detect.ts`; rewrite `PreviewPanel`; add `openPorts` to Studio (subscribe to port events in boot); delete the dead preview modules; add an `erdou stop <port>` subcommand to the Task-4 `erdou` builtin (calls `ctx`... note: closing a port needs runtime access — add `closePort(port)` to `BrowserRuntime` + a `stop` subcommand, OR a `studio.closePort(port)` calling `runtime.closePort`; prefer `runtime.closePort` on the concrete runtime + a studio method for the × button).
- [ ] **Step 4: Verify** — `pnpm --filter @erdou/web build` + `pnpm vitest run apps/web` + `pnpm lint:deps` green.
- [ ] **Step 5: Commit** `feat(web): Run-field + open-ports preview panel; remove /__preview__ static preview`.

---

# Phase S1c — Python WSGI bridge

## Task 7: `erdou.serve(app, port)` WSGI bridge

**Files:**
- Create: `packages/lang-python/src/erdou-module.ts` (the Python `erdou` module source + JS-side WSGI marshalling)
- Modify: `packages/lang-python/src/python.ts` (expose `ctx.serve` into Pyodide; install the `erdou` module)
- Test: `packages/lang-python/src/wsgi.test.ts` (pure JS environ-builder + a gated live Pyodide test if the harness allows)

**Interfaces (Produces):** inside Pyodide, `import erdou; erdou.serve(app, port=8000)` registers `app` (a WSGI callable). The python executor binds a JS function `__erdou_serve(port, py_app)` that calls `ctx.serve(port, handler)` where `handler(req)` builds a WSGI `environ` from `HttpRequest`, calls `py_app(environ, start_response)` on the (persistent, main-thread) Pyodide instance, and marshals status/headers/body → `HttpResponse`. `buildEnviron(req): Record<string, unknown>` and `collectResponse(status, headers, chunks): HttpResponse` are pure JS, unit-tested.

- [ ] **Step 1: Failing test** — unit-test the marshalling:
```ts
it("builds a WSGI environ from an HttpRequest", () => {
  const env = buildEnviron({ method: "POST", url: "/a/b?x=1", headers: { "content-type": "application/json", host: "h" }, body: new TextEncoder().encode("{}") });
  expect(env.REQUEST_METHOD).toBe("POST");
  expect(env.PATH_INFO).toBe("/a/b");
  expect(env.QUERY_STRING).toBe("x=1");
  expect(env.CONTENT_TYPE).toBe("application/json");
  expect(env.HTTP_HOST).toBe("h");
});
it("collects a WSGI response into HttpResponse", () => {
  const res = collectResponse("201 Created", [["Content-Type","text/plain"],["X-A","b"]], [new TextEncoder().encode("ok")]);
  expect(res.status).toBe(201);
  expect(res.headers["content-type"]).toBe("text/plain");
  expect(res.headers["x-a"]).toBe("b");
  expect(new TextDecoder().decode(res.body)).toBe("ok");
});
```

- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement** `erdou-module.ts` (the pure marshalling + the Python module string: `def serve(app, port=8000): __erdou_serve(port, app)`); in `python.ts`, after loading Pyodide, register the `erdou` module (`py.registerJsModule("erdou", {serve})` or write the module file) and expose `__erdou_serve` bound to `ctx.serve` with a handler that does `syncInto` (FS) → `buildEnviron` → `app(environ, start_response)` (capture status/headers via the `start_response` callback + iterate the returned body) → `collectResponse`. Handle app exceptions → 500 with traceback. Note: `ctx.serve` must remain callable after the executor returns — since the handler closes over the persistent Pyodide `app` and the registry keeps it, this works; do NOT `syncBack`-and-teardown the app.
- [ ] **Step 4: Run** — `pnpm vitest run packages/lang-python` (the pure tests; the live Pyodide serve test gated like the existing python live test). `pnpm lint:deps` clean (lang-python depends on contract only).
- [ ] **Step 5: Commit** `feat(lang-python): erdou.serve() WSGI bridge — run Flask/WSGI apps on a virtual port`.

---

# Phase S1d — Multi-port cross-origin routing

## Task 8: SW multi-port routing + panel

**Files:**
- Modify: `apps/web/public/preview-sw.js` (route cross-origin/sibling-port requests)
- Modify: `apps/web/src/components/PreviewPanel.tsx` (view a primary port; sibling ports reachable)
- Modify: `apps/web/src/lib/preview-bridge.ts` (port resolution helper)
- Test: `apps/web/src/lib/preview-bridge.test.ts` (extend — port resolution from a URL)

**Interfaces (Produces):** the SW resolves a target port for every intercepted request: an explicit `/__port__/<n>/...` prefix → port `n` (rest = the remainder); otherwise → the iframe's **primary port** (set when the panel opens a port, via a control `postMessage`). So an app served on port 8080 that fetches `/__port__/8000/api` hits port 8000, while its relative `/api` hits 8080. `resolvePort(pathname, primary): { port:number, rest:string }` is pure + unit-tested.

- [ ] **Step 1: Failing test**
```ts
it("resolves an explicit /__port__/<n>/ prefix, else the primary", () => {
  expect(resolvePort("/__preview__/8000/api", 8080)).toEqual({ port: 8000, rest: "/api" });
  expect(resolvePort("/__preview__/8080/", 8080)).toEqual({ port: 8080, rest: "/" });
  expect(resolvePort("/__preview__/__port__/8000/x", 8080)).toEqual({ port: 8000, rest: "/x" });
});
```
(Finalize the exact URL shape in implementation; keep the test in sync — the invariant: explicit port prefix wins, else primary.)

- [ ] **Step 2–4:** implement `resolvePort`, wire it in the SW + bridge, expose sibling-port linking in the panel; run green; build.
- [ ] **Step 5: Commit** `feat(web): multi-port preview routing (sibling ports via /__port__/<n>/)`.

---

# Phase #2 — Multi-turn conversation

## Task 9: agent-core conversation continuation

**Files:**
- Modify: `packages/agent-core/src/agent.ts` (`run(task, priorMessages?)`)
- Modify: `packages/agent-core/src/types.ts` (if the signature/return needs it)
- Test: `packages/agent-core/src/agent.test.ts` (add)

**Interfaces (Produces):** `run(task: string, priorMessages?: ChatMessage[]): Promise<AgentRunResult>` — when `priorMessages` is provided, `messages` starts as `[...priorMessages, { role:"user", content:task }]` (no fresh system prompt prepended — priorMessages already contains it); else unchanged (`[system, user]`). `AgentRunResult.transcript` already returns the full messages.

- [ ] **Step 1: Failing test** — a two-turn stub gateway: turn 1 (`run("t1")`) returns a tool call then done; capture `result.transcript`; turn 2 (`run("t2", result.transcript)`) — assert the gateway's 2nd-turn `messages` argument CONTAINS the turn-1 user/assistant messages (i.e. context carried). Use a `vi.fn()` gateway that records the `messages` it's called with.
- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement** the `priorMessages` branch in `run`.
- [ ] **Step 4: Run green** (`agent-core`).
- [ ] **Step 5: Commit** `feat(agent): multi-turn — run(task, priorMessages) continues a conversation`.

---

## Task 10: Studio reply-in-thread + composer

**Files:**
- Modify: `apps/web/src/lib/studio.ts` (`Run.messages`; `replyToRun(runId, task, model)`; persist messages)
- Modify: `apps/web/src/components/Composer.tsx` + `apps/web/src/App.tsx` (reply vs new-task wiring)
- Modify: `apps/web/src/lib/runs-store.ts` (persist `messages`)

**Interfaces (Produces):** `Run` gains `messages: ChatMessage[]` (the model transcript; empty until the first run resolves). `startRun` stores the returned transcript into `run.messages`. `replyToRun(runId, task, model)` — appends a `user` TraceLine for display, snapshots for diff (reuse Round-8 capture), calls `agent.run(task, run.messages)`, streams events into the run's trace, updates `run.messages`/`changes`/`status`, persists. The composer: when `activeRun` exists and is not running → `onRun` calls `replyToRun(activeRun.id, ...)`; else `startRun`. `+ New task` → `newDraft()` then `startRun` on next send. Disable the composer while `activeRun.status==="running"`.

- [ ] **Step 1** (no unit test — build-verified + headless in Task 15): implement `Run.messages`, `replyToRun`, persist messages, composer/App wiring. Reuse the Round-8 diff-capture around the reply.
- [ ] **Step 2: Verify** — `pnpm --filter @erdou/web build` + `pnpm vitest run apps/web` + `pnpm lint:deps` green; a headless smoke (send, then reply, confirm the 2nd turn shows in the same thread) if feasible.
- [ ] **Step 3: Commit** `feat(web): multi-turn threads — reply into the selected thread; +New task starts a new one`.

---

# Phase UX — file tree, tool-collapse, custom components

## Task 11: File tree expand/collapse + SVG icons

**Files:**
- Modify: `apps/web/src/components/FilePanel.tsx`
- Create: `apps/web/src/components/ui/icons.tsx` (inline SVG `Folder`, `FolderOpen`, `File`, `Chevron`)

**Interfaces (Produces):** `FilePanel` holds `expanded: Set<string>` (root path expanded by default). A folder row is a button: click toggles membership; children render only when expanded. A chevron rotates; a `Folder`/`FolderOpen` SVG precedes folders, `File` precedes files (currentColor, ~14px, minimal stroke). Files still open on click.

- [ ] **Step 1** (build-verified): implement icons + expand/collapse; tokens not hex.
- [ ] **Step 2: Verify** build + web tests green.
- [ ] **Step 3: Commit** `feat(web): file tree expand/collapse + inline SVG folder/file icons`.

---

## Task 12: Collapsed tool calls

**Files:**
- Modify: `apps/web/src/components/Conversation.tsx`, `apps/web/src/styles.css`

**Interfaces (Produces):** a `tool`(+ following `result`) renders as a collapsible block: a header `button` (status dot · tool name · truncated arg · chevron, `aria-expanded`), collapsed by default; expanded shows full args + full result output. thought/user/done/error unchanged. Preserve the tool/result pairing logic from Round 8 (the result folds into the tool block).

- [ ] **Step 1** (build-verified): implement the collapsible block + CSS.
- [ ] **Step 2: Verify** build + web tests green; headless: a tool call shows collapsed, expands on click.
- [ ] **Step 3: Commit** `feat(web): collapse tool-call details by default, expand on click`.

---

## Task 13: Custom Select + Toggle + CSS scrollbars

**Files:**
- Create: `apps/web/src/components/ui/Select.tsx`, `apps/web/src/components/ui/Toggle.tsx`
- Modify: `apps/web/src/components/Composer.tsx` (mode selector → `Select`), `PreviewPanel.tsx`/wherever the `live` checkbox is → `Toggle`
- Modify: `apps/web/src/styles.css` (scrollbar rules + component styles)

**Interfaces (Produces):** `Select({value, options:{value,label}[], onChange})` — a token-styled button + popover list, keyboard (↑/↓/Enter/Esc), click-outside close, `role="listbox"`/`aria-selected`. `Toggle({checked, onChange, label?})` — a switch. Global `::-webkit-scrollbar`/`-thumb`/`-track` rules (thin, `var(--faint)` thumb, transparent track). Replace the native `<select>`/`<input type=checkbox>` usages.

- [ ] **Step 1** (build-verified): implement both components + scrollbar CSS; swap usages.
- [ ] **Step 2: Verify** build + web tests green; headless: the Auto/Confirm Select opens + selects; scrollbars are styled.
- [ ] **Step 3: Commit** `feat(web): custom Select + Toggle components, CSS-styled scrollbars`.

---

# Phase #6 — Folder-synced session state

## Task 14: `.erdou/` session state on the mounted folder

**Files:**
- Create: `apps/web/src/lib/folder-state.ts` (read/write `.erdou/{runs.json,config.json,.gitignore}` via a `DirHandleLike`)
- Modify: `apps/web/src/lib/studio.ts` (on mount: hydrate from `.erdou/` if present else seed; debounced write on runs/config change; on unmount: stop)
- Modify: `apps/web/src/lib/local-mount.ts` (add `.erdou` to `SKIP` so it's never loaded as project files)
- Modify: `apps/web/src/lib/model-config.ts` (config shape read/written)
- Test: `apps/web/src/lib/folder-state.test.ts` (mock handle)

**Interfaces (Produces):** `writeFolderState(dir, { runs, config })` — writes `.erdou/runs.json`, `.erdou/config.json` (config INCLUDES the api key), `.erdou/.gitignore` (`config.json\n`). `readFolderState(dir): { runs?, config? } | null`. Studio: on successful mount, `const st = await readFolderState(handle)` → if present, `this.runs = st.runs`, apply `st.config` (theme/approval/model incl key); else `writeFolderState(handle, current)`. A debounced `scheduleFolderStateSave()` on run/config change writes when mounted. `.erdou/` is written **directly to the handle**, never into the VFS.

- [ ] **Step 1: Failing test**
```ts
it("writes and reads back .erdou state incl. the api key and a gitignore", async () => {
  const dir = mockDir({});
  await writeFolderState(dir as any, { runs: [{ id:"1" } as any], config: { apiKey:"sk-x", model:"m", approvalMode:"auto", theme:"dark" } as any });
  const st = await readFolderState(dir as any);
  expect(st?.runs?.[0]?.id).toBe("1");
  expect((st?.config as any)?.apiKey).toBe("sk-x");
  // .gitignore written under .erdou
  const gi = await readFileText(dir, ".erdou/.gitignore");
  expect(gi).toContain("config.json");
});
```
(Extend the existing `local-mount.test.ts` mock-dir helpers so `mockDir` supports nested `getDirectoryHandle`/`getFileHandle` create + read-back.)

- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement** `folder-state.ts`; wire Studio hydrate/seed/debounced-save/unmount; add `.erdou` to `local-mount` SKIP.
- [ ] **Step 4: Run green** (`folder-state.test.ts` + apps/web) + build + lint:deps.
- [ ] **Step 5: Commit** `feat(web): sync chat + config to <folder>/.erdou (folder is source of truth when mounted)`.

---

# Phase verify

## Task 15: End-to-end verification

**Files:** none (verification). Use the `verify`/`run` skill (headless Chromium).

- [ ] **Step 1: Gates** — `pnpm vitest run` (all), `pnpm lint:deps`, `pnpm --filter @erdou/web build`, `pnpm -w typecheck` — all green.
- [ ] **Step 2: S1 static** — Run field auto-detects a static site; `erdou serve . --spa`; the open-ports list shows the port; the iframe renders it; client routing works.
- [ ] **Step 3: S1 Python** — a Flask hello-world (`app.py` ending in `erdou.serve(app, 8000)`); Run it; the preview shows the served page; a POST/route works. (Needs Pyodide — allow the download.)
- [ ] **Step 4: S1 multi-port** — a static SPA on one port that `fetch('/__port__/<n>/…')` to a Flask API on another port; the response renders.
- [ ] **Step 5: #2** — send a task, then reply in the same thread; the 2nd turn sees context.
- [ ] **Step 6: #3/#4/#5** — tool calls collapsed→expand; the custom Select + Toggle work; scrollbars styled; file tree folders expand/collapse with SVG icons.
- [ ] **Step 7: #6** — mount a mock/real folder; `.erdou/` written (incl. key + `.gitignore`); reload/remount hydrates runs + config from the folder.
- [ ] **Step 8: Commit any fixups**, then hand back for review.

---

## Self-review notes (author)

- **Spec coverage:** S1→T1–T8 (contract T1, kernel T2, conformance T3, static T4, SW T5, panel T6, WSGI T7, multi-port T8); #2→T9–T10; #5→T11; #3→T12; #4→T13; #6→T14; verify→T15.
- **Type consistency:** `HttpRequest`/`HttpResponse`/`HttpHandler` (T1) consumed by T2/T4/T5/T7/T8; `ExecContext.serve` (T1) wired T2, used T4/T7; `Run.messages` (T10) from `run(task, priorMessages)` (T9); `openPorts` (T6) from port events (T2).
- **Contract discipline:** the HTTP surface is generic; conformance-tested (T3). No agent semantics in the contract.
- **Open detail for implementers:** the exact `/__preview__/<port>/` vs `/__port__/<n>/` URL scheme is finalized in T5/T8 — keep `resolvePort`'s test and the SW in sync; the invariant (explicit port prefix wins, else primary) is fixed.
