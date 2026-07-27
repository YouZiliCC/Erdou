import type { HttpRequest, HttpResponse, WsConnection } from "@erdou/runtime-contract";
import { injectPreviewScripts } from "./preview-inject.js";
import { isWsOpenMessage, openWsTunnel } from "./preview-tools.js";
import { PreviewCookieJar } from "./preview-cookies.js";

/**
 * The preview reverse-proxy bridge (page side).
 *
 * The preview Service Worker (`public/preview-sw.js`) intercepts an iframe's
 * requests under `/__preview__/<owner>/<port>/…`, marshals each to a plain
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
 * OWNERSHIP. One Service Worker instance serves EVERY tab of the origin, so
 * "which page do I dispatch into" is a real question with a wrong answer: the
 * worker used to pick the first window client that was not itself a preview
 * iframe — a focus-ordered guess, with no relation to the tab that issued the
 * request. Two Studio tabs on two projects both serving 8080 meant tab B's
 * preview could render tab A's files, silently. So a preview URL now NAMES its
 * owner: `/__preview__/<owner>/<port>/…`, where `<owner>` is the owning Studio
 * page's own Service Worker Client id — which the page learns at boot by asking
 * the worker (`erdou:whoami`; a page cannot read its own client id any other
 * way) and which the worker resolves back to that exact client. There is no
 * candidate-picking code path left, and a miss (owner tab closed, or reloaded —
 * a reload mints a NEW client id) is a precise 503, never a hand-off.
 *
 * `fetchToHttpRequest` / `httpResponseToResponse` are the pure marshalling
 * helpers (unit-tested here). The SW mirrors the same marshalling inline
 * because it is served as static JS and cannot import this module; the two must
 * stay in sync — `preview-sw-parity.test.ts` runs one shared case table against
 * both copies of the routing core so the duplication cannot drift unnoticed.
 */

/** The path-prefix that marks a previewed iframe; an app on port N owned by
 *  Studio page `<owner>` is viewed at `/__preview__/<owner>/<N>/…`. The SW
 *  itself registers at ROOT `/` (see `startPreviewProxy`) so it can also
 *  intercept a guest's ABSOLUTE-path resources, which resolve against the app
 *  origin and escape this prefix. */
export const PREVIEW_SCOPE = "/__preview__/";

/** What an owner segment may contain. A Client id is a UUID in every browser
 *  that ships one, but the spec only promises an opaque string — so the boot
 *  handshake VALIDATES rather than percent-encodes it: an exotic id fails loudly
 *  once, instead of being encoded and decoded through three separate parsers
 *  (SW, bridge, WS shim) that would each have to agree.
 *
 *  The `(?=.*[^.])` lookahead rejects an id made of NOTHING but dots. `.` and
 *  `..` are path segments the URL parser REMOVES before a request is ever made:
 *  `previewUrl("..", 8080)` = `/__preview__/../8080/`, which the browser
 *  normalizes to `/8080/` — an out-of-scope URL that reaches the SW with the
 *  STUDIO page as its context, routes to null, and is `fetch()`ed, so the SPA
 *  server answers with Studio's own index.html rendered inside the preview
 *  iframe. Silent wrong content is the exact class the owner segment exists to
 *  remove, so such an id must fail at the handshake, loudly, not in the frame. */
const OWNER_TOKEN = /^(?=.*[^.])[A-Za-z0-9._~-]{1,128}$/;

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);
// Statuses whose `Response` must have a null body — passing any body (even an
// empty Uint8Array) makes the `Response` constructor throw.
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

// The nested segment that lets a previewed app reach a SIBLING port instead of
// its own (the "primary" port it is viewed at).
const PORT_OVERRIDE = /^\/__port__\/(\d+)(\/.*)?$/;
// A preview-scope path: `/__preview__/<owner>/<primary>/…`.
// 1 = owner (the owning Studio page's SW client id), 2 = primary port, 3 = rest.
const PREVIEW_PATH = /^\/__preview__\/([^/]+)\/(\d+)(\/.*)?$/;
// An ALL-DIGIT owner segment is refused. The pre-owner two-segment shape
// (`/__preview__/8080/…`, from a stale bookmark or a popup left open across this
// upgrade) is otherwise indistinguishable from an owner named "8080": the `\d+`
// port group alone does NOT reject it — `/__preview__/8080/2024/report` parses
// happily as owner="8080", primary=2024, so the stale URL skips the SW's 400
// branch and the user is told a tab was closed/reloaded (503) for what is a
// stale SHAPE. Client ids are UUIDs in every shipping browser, but OWNER_TOKEN
// deliberately accepts all-digit ids, so this code does not assume otherwise.
const LEGACY_OWNER = /^\d+$/;

// Apply the `/__port__/<n>/` sibling-override to a guest path (a `/`-rooted path
// already stripped of the preview scope, or a guest's own absolute path). An
// empty path normalizes to `/`; an explicit override redirects to port `<n>`.
//
// The scheme: an app is viewed at `/__preview__/<owner>/<primary>/…` and routes
// to `primary` by default — a relative `fetch('api')` resolves to
// `/__preview__/<owner>/8080/api`, i.e. it inherits BOTH segments for free,
// which is why identity lives in the path. To reach a SIBLING server the app
// prefixes its path with `/__port__/<n>/…` right after the scope:
// `fetch('__port__/8000/api')` resolves to
// `/__preview__/<owner>/8080/__port__/8000/api`; that segment is stripped here
// and overrides the target PORT — never the owner, which stays whatever the
// URL's own scope (or the escape's context) said.
function applyOverride(guestPath: string, primary: number): { port: number; rest: string } {
  const rest = guestPath === "" ? "/" : guestPath;
  const override = PORT_OVERRIDE.exec(rest);
  if (override) {
    const overridePort = override[1];
    if (overridePort !== undefined) return { port: Number(overridePort), rest: override[2] || "/" };
  }
  return { port: primary, rest };
}

/** A parsed preview-scope path. `rest` is the raw remainder — NOT yet through
 *  `applyOverride`, so `primary` is the port the guest is VIEWED at (what an
 *  escaped absolute path must be attributed to) and a `/__port__/<n>/` prefix is
 *  still sitting in `rest` for the router to strip. */
export interface PreviewPath {
  /** The owning Studio page's Service Worker Client id. */
  owner: string;
  /** The port the guest is viewed at, before any sibling-port override. */
  primary: number;
  /** The remainder after `/__preview__/<owner>/<primary>` — `""` for a bare
   *  scope URL, which `applyOverride` normalizes to `/`. */
  rest: string;
}

/**
 * Parse `/__preview__/<owner>/<primary>/…`, or null when the pathname is not a
 * well-formed preview-scope path (including every pre-owner two-segment URL —
 * see `PREVIEW_PATH` and `LEGACY_OWNER`, which together reject that shape even
 * when the stale guest path starts with a numeric segment). Null under the
 * `/__preview__/` prefix is NOT a licence to guess: the SW answers such a
 * request with an explicit 400.
 *
 * PURE. The SW (`public/preview-sw.js`) duplicates this verbatim — it cannot
 * import TS. Keep the two in sync (`preview-sw-parity.test.ts` enforces it).
 */
export function parsePreviewPath(pathname: string): PreviewPath | null {
  const match = PREVIEW_PATH.exec(pathname);
  if (!match) return null;
  const owner = match[1];
  const primary = match[2];
  if (owner === undefined || primary === undefined) return null;
  if (LEGACY_OWNER.test(owner)) return null;
  return { owner, primary: Number(primary), rest: match[3] ?? "" };
}

/**
 * Build a preview URL. The ONE place the shape is constructed — the panel's
 * iframe `src` and its ↗ `window.open` both come through here, so the two
 * cannot drift from each other or from `parsePreviewPath`.
 *
 * `owner` must be this page's own client id (`getPreviewClientId()`); a URL
 * naming any other page routes to that page, which is the entire point.
 */
export function previewUrl(owner: string, port: number): string {
  return `${PREVIEW_SCOPE}${owner}/${port}/`;
}

/**
 * Decide whether an intercepted request belongs to a previewed guest and, if so,
 * which Studio page (`owner`), guest `port` and `guestPath` to forward it to.
 * Returns `null` for a PASSTHROUGH — a request the SW must NOT touch (the Studio
 * app's own traffic). This is the single gate that makes root-scoped
 * interception safe: only the two cases below are proxied; every other request
 * is left to the browser untouched.
 *
 *  1. In-scope — the request URL is itself under `/__preview__/<owner>/<primary>/…`
 *     (the iframe's main document, or a RELATIVE subresource that resolved under
 *     the scope). Routed from the URL alone; `previewContextUrl` is ignored.
 *     This is why the owner rides in the PATH: a relative subresource inherits
 *     it for free, and the iframe's own navigation — which reaches the SW with
 *     an EMPTY `clientId`, so nothing else identifies its opener — carries it too.
 *  2. Absolute-path escape — the request URL is OUT of scope (e.g. `/style.css`
 *     from `<link href="/style.css">`), but the `previewContextUrl` is a
 *     SAME-ORIGIN preview iframe. The browser resolved the guest's absolute path
 *     against the app origin, escaping the scope; we recover `owner` + `primary`
 *     from the context and forward the request's own absolute pathname there.
 *
 * `previewContextUrl` is the URL that identifies WHICH guest an out-of-scope
 * request escaped from. The SW sources it from the INITIATING CLIENT's document
 * URL (`client.url`, robust to the guest's Referrer-Policy) and falls back to the
 * request REFERRER when the client is unavailable — i.e. `client.url ?? referrer`.
 * Either way it must be a path-bearing, same-origin `/__preview__/<owner>/<port>/…`
 * URL; the same-origin check means a foreign page can never steer interception.
 * The escape is attributed to the context's `primary` port — the port the guest
 * is VIEWED at — never to a port the context itself had overridden.
 *
 * Either case honors a `/__port__/<n>/` sibling-override in the resolved path.
 * The override moves the PORT only: `owner` always comes from the request's own
 * scope or from the context, so a sibling-port request can never cross into
 * another Studio page's runtime.
 * `guestPath` carries no query string — the caller appends `url.search`.
 *
 * PURE. The SW (`public/preview-sw.js`) duplicates this verbatim — it cannot
 * import TS. Keep the two in sync (`preview-sw-parity.test.ts` enforces it).
 */
export function routePreviewRequest(
  requestUrl: string,
  previewContextUrl: string,
): { owner: string; port: number; guestPath: string } | null {
  const req = new URL(requestUrl);
  const inScope = parsePreviewPath(req.pathname);
  if (inScope) {
    const { port, rest } = applyOverride(inScope.rest, inScope.primary);
    return { owner: inScope.owner, port, guestPath: rest };
  }
  if (!previewContextUrl) return null;
  let ctx: URL;
  try {
    ctx = new URL(previewContextUrl);
  } catch {
    return null;
  }
  if (ctx.origin !== req.origin) return null;
  const owner = parsePreviewPath(ctx.pathname);
  if (!owner) return null;
  const { port, rest } = applyOverride(req.pathname, owner.primary);
  return { owner: owner.owner, port, guestPath: rest };
}

/** Marshal an intercepted `Request` into a runtime `HttpRequest`.
 *  `urlRest` is the path+query already stripped of the
 *  `/__preview__/<owner>/<port>` scope (e.g. `/api?q=1`). GET/HEAD carry no
 *  body. */
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
 *  gate (see preview-inject.ts). `owner` is the client id the preview URL named,
 *  echoed back so the receiving page can verify the request was addressed to IT.
 *  Both optional: a not-yet-updated SW omits them, and the bridge then injects
 *  nothing / enforces nothing (fail-safe for version skew — and a pre-owner SW
 *  cannot have misrouted by owner, since its URLs carry no owner at all). */
interface ProxyRequestMessage {
  type: "erdou:req";
  id: number;
  port: number;
  req: HttpRequest;
  dest?: string;
  owner?: string;
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

/** Bound the boot-time `erdou:whoami` round trip. A worker that never answers
 *  must not leave `boot()` waiting on a promise forever — the panel says
 *  "preview transport unavailable" instead. */
const WHOAMI_TIMEOUT_MS = 5000;

/** This page's own Service Worker Client id, learned once at boot. `null` until
 *  the handshake completes, and permanently null if it fails — there is no
 *  fallback owner, because inventing one is exactly the guess this scheme
 *  removes. */
let previewClientId: string | null = null;

/** This page's preview owner id (see `previewUrl`), or null when the boot
 *  handshake has not completed / failed. Read by PreviewPanel to build the
 *  iframe `src` and the ↗ popup URL, and by `answer()` to verify that an
 *  arriving request was addressed to this page. */
export function getPreviewClientId(): string | null {
  return previewClientId;
}

/**
 * Ask the worker for this page's Service Worker Client id and REMEMBER it: this
 * is the single writer of `previewClientId`, which `getPreviewClientId()` serves
 * to PreviewPanel (iframe `src`, ↗ popup) and which `answer()` defaults its
 * cross-tab guard to. Exported so tests drive the real wiring — the guard's
 * default is the only thing production ever passes, so a test that supplies its
 * own `expectedOwner` proves nothing about it.
 *
 * A page cannot read its own client id: no DOM API exposes it. The worker can —
 * `event.source.id` on a message from this page IS it — so we ask, once, over a
 * dedicated `MessageChannel` (same isolation discipline as `exchange()` in the
 * SW). We post to the registration's ACTIVE worker rather than
 * `navigator.serviceWorker.controller`: on a first-ever load this page is not
 * controlled until `clients.claim()` lands, and the answer does not depend on
 * control — but every preview URL we build does depend on having the answer.
 *
 * Stores and returns null (loudly) rather than guessing: a timeout, a worker
 * that replies with nothing, or an id outside `OWNER_TOKEN` (which would not
 * survive being put in a path and re-parsed by the SW, the bridge and the WS
 * shim). Null is terminal for this document — there is no fallback owner.
 */
export async function learnPreviewClientId(worker: ServiceWorker): Promise<string | null> {
  previewClientId = await askClientId(worker);
  return previewClientId;
}

async function askClientId(worker: ServiceWorker): Promise<string | null> {
  const reply = await new Promise<unknown>((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      resolve(null);
    }, WHOAMI_TIMEOUT_MS);
    channel.port1.onmessage = (event: MessageEvent) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(event.data);
    };
    worker.postMessage({ type: "erdou:whoami" }, [channel.port2]);
  });
  if (reply === null) {
    console.error(
      `[erdou] preview: the Service Worker did not answer erdou:whoami within ${WHOAMI_TIMEOUT_MS}ms` +
        " — this tab has no preview identity, so no preview can be addressed back to it. Reload the page.",
    );
    return null;
  }
  const id = (reply as { clientId?: unknown }).clientId;
  if (typeof id !== "string" || !OWNER_TOKEN.test(id)) {
    console.error(
      "[erdou] preview: the Service Worker reported an unusable client id for this page" +
        ` (${JSON.stringify(id)}) — previews cannot be addressed to this tab and will not be shown.`,
    );
    return null;
  }
  return id;
}

/**
 * The worker that will actually serve this page's previews (Round-7 pattern:
 * `navigator.serviceWorker.ready` never resolves for our out-of-page scope).
 * Exported for unit tests: it is pure over the registration object, and the
 * choice it makes decides whether this tab gets a preview identity at all.
 *
 * An UPDATE in flight wins over `reg.active`: on the first load after a deploy
 * `reg.active` is still the OUTGOING worker while the new one installs, and the
 * outgoing one predates `erdou:whoami` — asking it would time out and leave this
 * tab with no preview identity until a manual reload. The new worker calls
 * `skipWaiting()` on install and `clients.claim()` on activate, so waiting for
 * it is bounded in practice; bounded here too, so a worker that never activates
 * reports itself instead of hanging boot's fire-and-forget promise forever.
 *
 * That preference holds only while the update is ALIVE. A worker whose install
 * failed (bad deploy, parse error, fetch failure) goes `redundant` and will
 * never reach `activated`, so waiting the timer out would discard `reg.active`
 * and return null — "Preview transport unavailable" for the WHOLE session, after
 * a gratuitous 5s boot stall, on a page that an older-but-working worker is
 * controlling right now. Resolving `reg.active` there is not a guess: it is the
 * worker that actually controls this page. (If it predates `erdou:whoami` the
 * handshake still fails — but loudly, in `askClientId`, naming that.)
 */
export function activeWorker(reg: ServiceWorkerRegistration): Promise<ServiceWorker | null> {
  const updating = reg.installing ?? reg.waiting;
  if (!updating) return Promise.resolve(reg.active);
  return new Promise((resolve) => {
    if (updating.state === "activated") return resolve(updating);
    if (updating.state === "redundant") return resolve(reg.active);
    const timer = setTimeout(() => resolve(null), WHOAMI_TIMEOUT_MS);
    updating.addEventListener("statechange", () => {
      if (updating.state === "activated") {
        clearTimeout(timer);
        resolve(updating);
        return;
      }
      if (updating.state !== "redundant") return;
      clearTimeout(timer);
      resolve(reg.active);
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
 *
 * Returns this page's OWNER id — the client id every preview URL it builds must
 * name (see `previewUrl`) — or null when there is no worker to serve previews
 * or the `erdou:whoami` handshake failed. Null is terminal for this document:
 * the panel reports it instead of mounting an iframe that could only ever be
 * served by guessing which tab owns it.
 */
export async function startPreviewProxy(runtime: DispatchRuntime): Promise<string | null> {
  // Register the message listener before the SW activates, so no early proxied
  // request is dropped.
  installPreviewBridge(runtime);
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    console.info("[erdou] preview proxy disabled: no Service Worker support");
    return null;
  }
  try {
    await unregisterStalePreviewWorkers();
    const reg = await navigator.serviceWorker.register("/preview-sw.js", { scope: "/" });
    const worker = await activeWorker(reg);
    if (!worker) {
      console.error("[erdou] preview: the Service Worker never activated — previews are unavailable.");
      return null;
    }
    return await learnPreviewClientId(worker);
  } catch (err) {
    console.warn("[erdou] preview SW registration failed", err);
    return null;
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
 *
 * `expectedOwner` is this page's own client id: a request whose envelope names a
 * DIFFERENT page is refused outright (the SW renders the error as a 502). That
 * is a second, independent check on the routing this scheme fixes — the page
 * never selects a target, it only declines one addressed elsewhere.
 */
export async function answer(
  runtime: DispatchRuntime,
  msg: ProxyRequestMessage,
  replyPort: ProxyReplyPort,
  expectedOwner: string | null = getPreviewClientId(),
): Promise<void> {
  if (msg.owner !== undefined && expectedOwner !== null && msg.owner !== expectedOwner) {
    replyPort.postMessage({
      type: "erdou:res",
      id: msg.id,
      error:
        `preview request was addressed to Erdou tab ${msg.owner} but reached tab ${expectedOwner}` +
        " — refusing to serve another tab's project (this is the cross-tab misroute the owner segment prevents).",
    });
    return;
  }
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
