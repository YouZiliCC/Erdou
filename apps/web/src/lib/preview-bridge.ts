import type { HttpRequest, HttpResponse, WsConnection } from "@erdou/runtime-contract";
import { injectPreviewScripts } from "./preview-inject.js";
import { isWsOpenMessage, openWsTunnel } from "./preview-tools.js";
import { PreviewCookieJar } from "./preview-cookies.js";

/**
 * The preview reverse-proxy bridge (page side).
 *
 * The preview Service Worker (`public/preview-sw.js`) intercepts an iframe's
 * requests under `/__preview__/<port>/…`, marshals each to a plain
 * `{method,url,headers,body}`, and posts it to this page over a per-request
 * `MessageChannel`. Here we `dispatch` it into the in-browser runtime and post
 * the `HttpResponse` back down the same channel. The SW turns that into a real
 * `Response`. No caching. One reply per request — but a STREAMED response
 * (`HttpResponse.stream`, engaged by kernels for `text/event-stream` only)
 * posts its reply at head-time with a TRANSFERRED pull-based `ReadableStream`
 * beside a headers-only `res`; the SW uses `stream ?? res.body` as the
 * `Response` body, so SSE chunks reach the iframe as the runtime produces
 * them. Everything else stays a single buffered reply, byte-identical —
 * except previewed DOCUMENTS: the SW reports `Request.destination` as `dest`
 * on the envelope, and `answer()` runs "document"/"iframe" HTML replies
 * through `injectPreviewScripts` (preview-inject.ts), which injects the
 * console/error observability hook (`window.__erdouLogs`, read by the agent's
 * preview_logs tool) and the WebSocket shim as `<script>`s after `<head>`.
 * Subresources, fetches, and non-HTML stay untouched.
 *
 * WebSockets: the SW never sees ws:// handshakes (no fetch event fires), so
 * the injected shim tunnels same-host WebSockets instead — it posts
 * `erdou:ws-open` (+ a MessagePort) to this window; the listener below
 * validates it and `openWsTunnel` (preview-tools.ts) drives
 * `runtime.upgrade(port, req)` — the contract's OPTIONAL capability method.
 * A kernel without `upgrade` (the browser kernel) gets a precise fail-fast
 * decline. Live tunnels are torn down when the bridge is re-aimed at a new
 * runtime (kernel switch), so no pump outlives its kernel.
 *
 * `fetchToHttpRequest` / `httpResponseToResponse` are the pure marshalling
 * helpers (unit-tested here). The SW mirrors the same marshalling inline
 * because it is served as static JS and cannot import this module; the two must
 * stay in sync.
 */

/** The path-prefix that marks a previewed iframe; an app on port N is viewed at
 *  `/__preview__/<N>/…`. The SW itself registers at ROOT `/` (see
 *  `startPreviewProxy`) so it can also intercept a guest's ABSOLUTE-path
 *  resources, which resolve against the app origin and escape this prefix. */
export const PREVIEW_SCOPE = "/__preview__/";

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);
// Statuses whose `Response` must have a null body — passing any body (even an
// empty Uint8Array) makes the `Response` constructor throw.
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

// The nested segment that lets a previewed app reach a SIBLING port instead of
// its own (the "primary" port it is viewed at).
const PORT_OVERRIDE = /^\/__port__\/(\d+)(\/.*)?$/;
// A preview-scope path: `/__preview__/<primary>/…`. Group 1 is the primary port.
const PREVIEW_PATH = /^\/__preview__\/([^/]+)(\/.*)?$/;

// Apply the `/__port__/<n>/` sibling-override to a guest path (a `/`-rooted path
// already stripped of the preview scope, or a guest's own absolute path). An
// empty path normalizes to `/`; an explicit override redirects to port `<n>`.
function applyOverride(guestPath: string, primary: number): { port: number; rest: string } {
  const rest = guestPath === "" ? "/" : guestPath;
  const override = PORT_OVERRIDE.exec(rest);
  if (override) {
    const overridePort = override[1];
    if (overridePort !== undefined) return { port: Number(overridePort), rest: override[2] || "/" };
  }
  return { port: primary, rest };
}

// Parse the primary port from a `/__preview__/<primary>/…` pathname, or null
// when the pathname is not a well-formed preview-scope path.
function previewPrimary(pathname: string): number | null {
  const match = PREVIEW_PATH.exec(pathname);
  if (!match) return null;
  const primary = Number(match[1]);
  return Number.isInteger(primary) ? primary : null;
}

/**
 * Resolve which port an intercepted IN-SCOPE preview request routes to, and the
 * (query-less) path to forward.
 *
 * Scheme: an app is viewed at `/__preview__/<primary>/…`; `primary` is parsed
 * from that scope by the caller (the SW) and passed in here. A request under
 * the scope routes to `primary` by default — e.g. a relative `fetch('api')`
 * from the app resolves to `/__preview__/8080/api`, routing to 8080. To reach
 * a SIBLING server, the app prefixes its request path with `/__port__/<n>/…`
 * right after the scope: `fetch('__port__/8000/api')` resolves (relative to
 * the app's own scope directory) to `/__preview__/8080/__port__/8000/api`;
 * that segment is stripped and overrides the target port. `pathname` is
 * `url.pathname` (no query string — the caller appends `url.search` to
 * `rest` itself); `rest` always starts with `/` (an empty remainder
 * normalizes to `/`).
 *
 * PURE. The SW (`public/preview-sw.js`) duplicates this verbatim — it cannot
 * import TS. Keep the two in sync.
 */
export function resolvePort(pathname: string, primary: number): { port: number; rest: string } {
  const afterScope = pathname.slice(PREVIEW_SCOPE.length + String(primary).length);
  return applyOverride(afterScope, primary);
}

/**
 * Decide whether an intercepted request belongs to a previewed guest and, if so,
 * which guest `port` and `guestPath` to forward it to. Returns `null` for a
 * PASSTHROUGH — a request the SW must NOT touch (the Studio app's own traffic).
 * This is the single gate that makes root-scoped interception safe: only the two
 * cases below are proxied; every other request is left to the browser untouched.
 *
 *  1. In-scope — the request URL is itself under `/__preview__/<primary>/…` (the
 *     iframe's main document, or a RELATIVE subresource that resolved under the
 *     scope). Routed from the URL by `resolvePort`; `previewContextUrl` is ignored.
 *  2. Absolute-path escape — the request URL is OUT of scope (e.g. `/style.css`
 *     from `<link href="/style.css">`), but the `previewContextUrl` is a
 *     SAME-ORIGIN preview iframe. The browser resolved the guest's absolute path
 *     against the app origin, escaping the scope; we recover `primary` from the
 *     context and forward the request's own absolute pathname to that guest.
 *
 * `previewContextUrl` is the URL that identifies WHICH guest an out-of-scope
 * request escaped from. The SW sources it from the INITIATING CLIENT's document
 * URL (`client.url`, robust to the guest's Referrer-Policy) and falls back to the
 * request REFERRER when the client is unavailable — i.e. `client.url ?? referrer`.
 * Either way it must be a path-bearing, same-origin `/__preview__/<port>/…` URL;
 * the same-origin check means a foreign page can never steer interception.
 *
 * Either case honors a `/__port__/<n>/` sibling-override in the resolved path.
 * `guestPath` carries no query string — the caller appends `url.search`.
 *
 * PURE. The SW (`public/preview-sw.js`) duplicates this verbatim — it cannot
 * import TS. Keep the two in sync.
 */
export function routePreviewRequest(
  requestUrl: string,
  previewContextUrl: string,
): { port: number; guestPath: string } | null {
  const req = new URL(requestUrl);
  const scopePrimary = previewPrimary(req.pathname);
  if (scopePrimary !== null) {
    const { port, rest } = resolvePort(req.pathname, scopePrimary);
    return { port, guestPath: rest };
  }
  if (!previewContextUrl) return null;
  let ctx: URL;
  try {
    ctx = new URL(previewContextUrl);
  } catch {
    return null;
  }
  if (ctx.origin !== req.origin) return null;
  const ctxPrimary = previewPrimary(ctx.pathname);
  if (ctxPrimary === null) return null;
  const { port, rest } = applyOverride(req.pathname, ctxPrimary);
  return { port, guestPath: rest };
}

/** Marshal an intercepted `Request` into a runtime `HttpRequest`.
 *  `urlRest` is the path+query already stripped of the `/__preview__/<port>`
 *  scope (e.g. `/api?q=1`). GET/HEAD carry no body. */
export async function fetchToHttpRequest(request: Request, urlRest: string): Promise<HttpRequest> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body = BODYLESS_METHODS.has(request.method.toUpperCase())
    ? new Uint8Array()
    : new Uint8Array(await request.arrayBuffer());
  return { method: request.method, url: urlRest, headers, body };
}

/** Marshal a runtime `HttpResponse` back into a real `Response`. */
export function httpResponseToResponse(res: HttpResponse): Response {
  const body = NULL_BODY_STATUS.has(res.status) ? null : res.body;
  return new Response(body, { status: res.status, headers: res.headers });
}

/** The SW → page request envelope (also declared inline in the SW). `dest` is
 *  the intercepted `Request.destination` — the injection policy's document
 *  gate (see preview-inject.ts). Optional: a not-yet-updated SW omits it, and
 *  the bridge then injects nothing (fail-safe for version skew). */
interface ProxyRequestMessage {
  type: "erdou:req";
  id: number;
  port: number;
  req: HttpRequest;
  dest?: string;
}

function isProxyRequest(data: unknown): data is ProxyRequestMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === "erdou:req" &&
    typeof (data as { port?: unknown }).port === "number" &&
    typeof (data as { req?: unknown }).req === "object"
  );
}

interface DispatchRuntime {
  dispatch(port: number, req: HttpRequest): Promise<HttpResponse>;
  /** OPTIONAL, mirroring the contract: absent on kernels without WebSocket
   *  support (the browser kernel) — the tunnel declines fail-fast then. */
  upgrade?(port: number, req: HttpRequest): Promise<WsConnection>;
}

let bridgeInstalled = false;
let currentRuntime: DispatchRuntime | null = null;
/** Cleanups for live WebSocket tunnels, so re-aiming the bridge at a NEW
 *  runtime (kernel switch / re-boot) tears the old kernel's pumps down instead
 *  of leaking them against a dead emulator. */
const activeTunnels = new Set<() => void>();
/** The preview cookie jar (see preview-cookies.ts): the page bridge IS the
 *  cookie store for previewed apps — a browser never stores a
 *  Service-Worker-synthesized response's cookies. Cleared on a kernel switch
 *  (the old kernel's servers, and their sessions, are gone). */
const cookieJar = new PreviewCookieJar();

function retargetRuntime(runtime: DispatchRuntime): void {
  if (currentRuntime !== null && currentRuntime !== runtime) {
    for (const cleanup of [...activeTunnels]) cleanup();
    activeTunnels.clear();
    cookieJar.clear();
  }
  currentRuntime = runtime;
}

/** Re-aim the installed preview bridge at a new runtime (e.g. after a kernel
 *  switch). The listener is installed once (below) and reads this holder.
 *  Live WebSocket tunnels belong to the OLD runtime and are closed. */
export function setPreviewRuntime(runtime: DispatchRuntime): void {
  retargetRuntime(runtime);
}

/**
 * Listen for proxied requests from the preview SW and answer them by dispatching
 * into `runtime`. Idempotent; a guarded no-op when there is no Service Worker
 * (SSR, tests, unsupported browsers).
 */
export function installPreviewBridge(runtime: DispatchRuntime): void {
  retargetRuntime(runtime); // always update the target…
  if (bridgeInstalled) return; // …but install the listeners only once
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return;
  }
  bridgeInstalled = true;
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    if (!isProxyRequest(event.data)) return;
    const replyPort = event.ports[0];
    if (!replyPort) return;
    const rt = currentRuntime;
    if (!rt) return;
    void answer(rt, event.data, replyPort);
  });
  // The WebSocket tunnel listener: the injected shim (same-origin preview
  // document) posts `erdou:ws-open` with a transferred MessagePort. The origin
  // check means a foreign page can never open a tunnel into the runtime.
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return;
    if (!isWsOpenMessage(event.data)) return;
    const tunnelPort = event.ports[0];
    if (!tunnelPort) return;
    const rt = currentRuntime;
    if (!rt) return;
    let cleanup: (() => void) | null = null;
    void openWsTunnel(rt, event.data, tunnelPort, () => {
      if (cleanup) activeTunnels.delete(cleanup);
    }).then((c) => {
      if (!c) return;
      cleanup = c;
      // The kernel may have been switched while the upgrade was in flight —
      // a tunnel into the outgoing runtime must not be kept.
      if (currentRuntime !== rt) {
        c();
        return;
      }
      activeTunnels.add(c);
    });
  });
}

/** Wait until the registration has an active worker (Round-7 pattern):
 *  `navigator.serviceWorker.ready` never resolves for our out-of-page scope. */
function activeWorker(reg: ServiceWorkerRegistration): Promise<ServiceWorker | null> {
  if (reg.active) return Promise.resolve(reg.active);
  const sw = reg.installing ?? reg.waiting;
  if (!sw) return Promise.resolve(null);
  return new Promise((resolve) => {
    if (sw.state === "activated") return resolve(sw);
    sw.addEventListener("statechange", () => {
      if (sw.state === "activated") resolve(sw);
    });
  });
}

/**
 * Boot the preview proxy: install the page-side bridge listener, then register
 * the SW at ROOT scope `/` so it can intercept not just in-scope preview iframes
 * but also a guest's ABSOLUTE-path resources, which resolve against the app
 * origin and escape `/__preview__/`. `routePreviewRequest` is the gate that
 * keeps this safe: app-origin traffic that is neither in-scope nor referred by a
 * preview iframe passes straight through untouched. Guarded so a no-SW
 * environment just logs and skips (the app still runs, sans preview).
 */
export async function startPreviewProxy(runtime: DispatchRuntime): Promise<void> {
  // Register the message listener before the SW activates, so no early proxied
  // request is dropped.
  installPreviewBridge(runtime);
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    console.info("[erdou] preview proxy disabled: no Service Worker support");
    return;
  }
  try {
    await unregisterStalePreviewWorkers();
    const reg = await navigator.serviceWorker.register("/preview-sw.js", { scope: "/" });
    await activeWorker(reg);
  } catch (err) {
    console.warn("[erdou] preview SW registration failed", err);
  }
}

/**
 * Remove any pre-upgrade preview worker registered at the OLD `/__preview__/`
 * scope. This worker now ships at ROOT `/`, which is a DIFFERENT registration
 * key; without this sweep a returning user would run BOTH workers split-brain
 * (the old scope serving in-scope iframe requests, the new root scope serving
 * absolute-path escapes and app traffic). Unregister the stale one so only the
 * root worker remains. The root registration's scope ends in `/`, never
 * `/__preview__/`, so it is left untouched.
 */
async function unregisterStalePreviewWorkers(): Promise<void> {
  const regs = await navigator.serviceWorker.getRegistrations();
  await Promise.all(
    regs.filter((r) => r.scope.endsWith(PREVIEW_SCOPE)).map((r) => r.unregister()),
  );
}

/** The slice of `MessagePort` the reply path uses — injectable so `answer` is
 *  unit-testable with a recording fake. */
export interface ProxyReplyPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

/**
 * Answer one proxied request: dispatch into the runtime, reply on the SW's
 * per-request `MessagePort`. Exported for unit tests; production traffic
 * arrives via the listener `installPreviewBridge` installs.
 *
 * A STREAMED response (`res.stream` — see the contract doc on `HttpResponse`)
 * replies at head-time: the single-use iterable is wrapped in a pull-based
 * `ReadableStream` (pull → `it.next()`, cancel → `it.return()`) and
 * TRANSFERRED to the SW beside a headers-only `res` with an empty body. A
 * consumer cancel propagates natively across the transfer, so the producer
 * learns "client gone" and stops. A mid-stream producer error rejects a pull,
 * erroring the stream — a visible network error in the iframe, never a
 * silently-truncated success. NULL-BODY statuses never stream (the SW's
 * null-body rule wins); a nonsensical stream on one is released, not sent.
 *
 * Buffered DOCUMENT replies ("document"/"iframe" per `msg.dest`) pass through
 * `injectPreviewScripts` first, which injects the console/error hook and the
 * WebSocket shim into HTML (preview-inject.ts — streams and non-HTML pass
 * through unchanged).
 */
export async function answer(
  runtime: DispatchRuntime,
  msg: ProxyRequestMessage,
  replyPort: ProxyReplyPort,
): Promise<void> {
  try {
    // Inject the previewed guest's stored cookies for this port + path (the
    // browser can't for an SW-proxied app — see preview-cookies.ts). `Cookie`
    // is a forbidden header the SW never sees, so we own it here entirely.
    const cookie = cookieJar.header(msg.port, msg.req.url);
    if (cookie !== null) msg.req.headers = { ...msg.req.headers, cookie };
    const raw = await runtime.dispatch(msg.port, msg.req);
    // Absorb Set-Cookie into the jar BEFORE injection — rewriteHtml returns a
    // fresh object without setCookies, and the jar is the sole cookie store.
    if (raw.setCookies && raw.setCookies.length > 0) cookieJar.store(msg.port, msg.req.url, raw.setCookies);
    const res = injectPreviewScripts(raw, msg.dest);
    if (res.stream !== undefined && !NULL_BODY_STATUS.has(res.status)) {
      const it = res.stream[Symbol.asyncIterator]();
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { done, value } = await it.next();
          if (done) controller.close();
          else controller.enqueue(value);
        },
        async cancel() {
          await it.return?.();
        },
      });
      replyPort.postMessage(
        {
          type: "erdou:res",
          id: msg.id,
          res: { status: res.status, headers: res.headers, body: new Uint8Array() },
          stream,
        },
        [stream],
      );
      return;
    }
    if (res.stream !== undefined) {
      // Null-body status + stream: unsupported by definition — release the
      // producer (client will never read) and reply with the plain head.
      void res.stream[Symbol.asyncIterator]().return?.();
      replyPort.postMessage({
        type: "erdou:res",
        id: msg.id,
        res: { status: res.status, headers: res.headers, body: res.body },
      });
      return;
    }
    replyPort.postMessage({ type: "erdou:res", id: msg.id, res });
  } catch (err) {
    // Surface the dispatch failure so the SW can answer the iframe with a 502
    // (a real, visible error status) instead of hanging until the timeout.
    replyPort.postMessage({
      type: "erdou:res",
      id: msg.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
