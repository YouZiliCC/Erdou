// Erdou preview service worker: a reverse proxy for the in-browser runtime.
//
// It intercepts a preview iframe's requests, marshals each into a plain
// `{method,url,headers,body}`, and forwards it to the controlling Studio page
// over a per-request MessageChannel. The page dispatches it into the runtime
// (`runtime.dispatch(port, req)`) and posts the `HttpResponse` back down the
// channel; we turn that into a real `Response` for the iframe. No caching.
// One reply per request — but a STREAMED response (SSE: the runtime engaged
// `HttpResponse.stream` for `text/event-stream`) replies at head-time with a
// TRANSFERRED ReadableStream beside a headers-only `res`; the body pick below
// is `reply.stream ?? res.body`, so chunks flow to the iframe as the runtime
// produces them and a reader cancel propagates back across the transfer. The
// reply timeout therefore bounds HEAD arrival only — a live stream keeps
// flowing long past it.
//
// The request envelope also carries `dest` (= `Request.destination`): the
// page bridge injects the preview scripts (console/error observability hook +
// WebSocket shim) into HTML replies for "document"/"iframe" destinations ONLY
// — see src/lib/preview-inject.ts.
// This worker itself never rewrites bodies; WebSocket handshakes never reach
// a Service Worker at all (no fetch event), which is exactly why the injected
// shim + page bridge tunnel them instead.
//
// The worker registers at ROOT scope `/` (not `/__preview__/`) so it can also
// catch a guest's ABSOLUTE-path resources (`<link href="/style.css">`), which
// resolve against the app origin and escape the `/__preview__/` prefix. For an
// out-of-scope request we identify which guest it escaped from by the INITIATING
// CLIENT's document URL (`clients.get(event.clientId).url`), robust to the
// guest's Referrer-Policy (the referrer is only a fallback).
// `routePreviewRequest` is the safety gate: only in-scope requests and requests
// whose preview context is a same-origin preview iframe are proxied — the Studio
// app's own traffic returns `null` and is passed straight through untouched.
//
// OWNERSHIP — which page does a request get dispatched into? ONE worker serves
// EVERY tab of the origin, so this is a real question, and it used to be
// answered by a guess: "the first window client that is not itself a preview
// iframe", in a focus-dependent `matchAll` order, with no relation to the tab
// that issued the request. Two Studio tabs on two projects both serving 8080
// meant tab B's preview could be dispatched into tab A's runtime and render tab
// A's files — silently, with no error anywhere. So a preview URL NAMES its
// owner: `/__preview__/<owner>/<port>/…`, where `<owner>` is the owning Studio
// page's Service Worker Client id (it learns it from this worker at boot — see
// the `erdou:whoami` listener; a page cannot read its own client id any other
// way). Dispatch is then an EXACT identity match (`ownerClient`), not a choice
// among candidates, and it needs no state that a worker restart could lose —
// the browser owns the id. When the named client is gone (tab closed, or
// reloaded: a reload mints a NEW id) the request 503s saying exactly that; it is
// never handed to some other tab.
//
// This marshalling + routing mirrors `src/lib/preview-bridge.ts` (which cannot
// be imported here — this file is served as static JS). Keep the two in sync:
// `src/lib/preview-sw-parity.test.ts` loads THIS file in Node and runs one
// shared case table against both copies of the routing core.

const SCOPE = "/__preview__/";
// Bound the wait for the page to answer. A hung/absent dispatch becomes a 504
// instead of leaving the iframe request pending forever. This bounds the
// REPLY (i.e. head arrival) only: a transferred stream delivers its body
// chunks for as long as the producer keeps yielding.
const DISPATCH_TIMEOUT_MS = 15000;
// Statuses whose Response must have a null body (else the constructor throws).
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);
const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

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
// happily as owner="8080", primary=2024, so the stale URL skips the 400 branch
// and the user is told a tab was closed/reloaded (503) for what is a stale
// SHAPE. Client ids are UUIDs in every shipping browser, but OWNER_TOKEN
// deliberately accepts all-digit ids, so this code does not assume otherwise.
const LEGACY_OWNER = /^\d+$/;

// Kept in EXACT sync with `parsePreviewPath`/`routePreviewRequest` in
// `src/lib/preview-bridge.ts` — see that copy's doc comments for the full
// scheme. This file is served as static JS and cannot import TS, hence the
// duplication; `src/lib/preview-sw-parity.test.ts` runs one shared case table
// against both copies so a one-sided edit fails a test instead of a preview.

// Apply the /__port__/<n>/ sibling-override to a guest path (a `/`-rooted path
// already stripped of the preview scope, or a guest's own absolute path).
function applyOverride(guestPath, primary) {
  const rest = guestPath === "" ? "/" : guestPath;
  const override = PORT_OVERRIDE.exec(rest);
  if (override) {
    const overridePort = override[1];
    if (overridePort !== undefined) return { port: Number(overridePort), rest: override[2] || "/" };
  }
  return { port: primary, rest };
}

// Parse `/__preview__/<owner>/<primary>/…` into {owner, primary, rest}, or null
// when the pathname is not a well-formed preview-scope path (every pre-owner
// two-segment URL included — PREVIEW_PATH and LEGACY_OWNER together, since the
// port group alone misses `…/8080/2024/report`). `rest` is RAW — the override is
// still in it, and `primary` is the port the guest is VIEWED at, which is what
// an escaped absolute path must be attributed to.
function parsePreviewPath(pathname) {
  const match = PREVIEW_PATH.exec(pathname);
  if (!match) return null;
  const owner = match[1];
  const primary = match[2];
  if (owner === undefined || primary === undefined) return null;
  if (LEGACY_OWNER.test(owner)) return null;
  return { owner, primary: Number(primary), rest: match[3] ?? "" };
}

// Decide whether an intercepted request belongs to a previewed guest and, if so,
// which Studio page (`owner`), guest `port` and `guestPath` to forward it to.
// Returns null for a PASSTHROUGH — a request the SW must NOT touch (the Studio
// app's own traffic).
//   1. In-scope: the URL is under `/__preview__/<owner>/<primary>/…`. The owner
//      rides in the PATH because relative subresources inherit it for free and
//      the iframe's own navigation reaches us with an EMPTY clientId — nothing
//      else in the request identifies the page that opened it.
//   2. Absolute-path escape: the URL is out of scope but the `previewContextUrl`
//      is a SAME-ORIGIN preview iframe (the guest used an absolute path); owner
//      and primary port come from that context.
// `previewContextUrl` identifies which guest an out-of-scope request escaped
// from: the SW sources it from the INITIATING CLIENT's document URL (robust to
// the guest's Referrer-Policy), falling back to the request referrer — i.e.
// `client.url ?? referrer`. Either case honors a /__port__/<n>/ sibling-override,
// which moves the PORT only — the owner never comes from the overridable part,
// so a sibling-port request cannot cross into another tab's runtime.
// `guestPath` carries no query string — the caller appends `url.search`.
function routePreviewRequest(requestUrl, previewContextUrl) {
  const req = new URL(requestUrl);
  const inScope = parsePreviewPath(req.pathname);
  if (inScope) {
    const { port, rest } = applyOverride(inScope.rest, inScope.primary);
    return { owner: inScope.owner, port, guestPath: rest };
  }
  if (!previewContextUrl) return null;
  let ctx;
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

// Monotonic request id — correlates each forwarded request with its reply.
let nextId = 1;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// `erdou:whoami` — the boot handshake that tells a Studio page its own Service
// Worker Client id, which it then puts in every preview URL it builds (see
// `askClientId` in src/lib/preview-bridge.ts). `event.source` IS the asking
// client and this worker is the only party that can observe its id: no DOM API
// exposes a page's own client id. Registered at top level, so a worker restart
// re-registers it along with everything else.
self.addEventListener("message", (event) => {
  if (!event.data || event.data.type !== "erdou:whoami") return;
  const reply = event.ports[0];
  if (!reply) return;
  reply.postMessage({ type: "erdou:whoami-res", clientId: event.source ? event.source.id : null });
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // `/__preview__/` is a RESERVED namespace: the Studio app serves nothing under
  // it, so a request here is a preview request or a mistake — never passthrough
  // traffic. In-scope requests are fully determined by the URL alone (owner and
  // port are both in it), so no client lookup is needed before respondWith.
  if (url.pathname.startsWith(SCOPE)) {
    const route = routePreviewRequest(url.href, "");
    if (!route) {
      // A path under the reserved namespace that is not a well-formed preview
      // URL. In practice the pre-owner `/__preview__/<port>/…` shape from a
      // bookmark or a popup left open across this upgrade — but the branch is
      // unconditional, so it ALSO 400s a guest's own absolute path under the
      // namespace (`<link href="/__preview__/assets/x.css">`, which pre-owner
      // routing forwarded to that guest). That is a deliberate narrowing of the
      // absolute-path-escape guarantee: the namespace is Erdou's, and a visible
      // 400 beats guessing which guest a reserved-namespace path meant.
      // Passing it through instead would render the Studio app's own index.html
      // inside the preview frame — a broken-looking guest app rather than a
      // named error, i.e. exactly the silent wrong content this scheme removes.
      event.respondWith(
        textResponse(
          400,
          "Erdou preview: unrecognized preview URL " + url.pathname +
            " — the shape is /__preview__/<owner>/<port>/… . Reopen the preview from the Erdou tab.",
        ),
      );
      return;
    }
    event.respondWith(proxy(event, route));
    return;
  }

  // Out-of-scope, same-origin: either a guest's ABSOLUTE-path resource that
  // escaped `/__preview__/` (e.g. `<link href="/style.css">`) or the Studio
  // app's own traffic. We tell them apart by the INITIATING CLIENT (the iframe's
  // document URL), which is robust to the guest's Referrer-Policy — the referrer
  // is only a fallback. Resolving the client is async, so we commit to
  // respondWith and pass genuine app traffic straight through to the network
  // untouched (never handing it to a guest — the core safety property).
  event.respondWith(routeOutOfScope(event, url));
});

// Route (or pass through) an out-of-scope, same-origin request. Identifies the
// preview context from the initiating client, then proxies to the guest when it
// is an absolute-path escape, or re-fetches from the network for genuine app
// traffic (routePreviewRequest → null).
async function routeOutOfScope(event, url) {
  const context = await previewContext(event);
  const route = routePreviewRequest(url.href, context);
  if (!route) return fetch(event.request);
  return proxy(event, route);
}

// The preview context that identifies which guest an out-of-scope request
// escaped from: the initiating client's document URL
// (`/__preview__/<owner>/<port>/…`, unaffected by Referrer-Policy), falling back
// to the request referrer when the client is unavailable (e.g. the preview
// iframe's own navigation, whose clientId is empty). Either carries the owner.
async function previewContext(event) {
  if (event.clientId) {
    const client = await self.clients.get(event.clientId);
    if (client) return client.url;
  }
  return event.request.referrer;
}

async function proxy(event, route) {
  const url = new URL(event.request.url);
  const { owner, port, guestPath } = route;
  // Query string was stripped from guestPath; reattach it here.
  const rest = guestPath + url.search;

  const client = await ownerClient(owner);
  if (!client) {
    // FAIL, never fall back: the owning page is the only page that may answer
    // this request. Serving it from whichever other Erdou tab happens to be open
    // is how a preview came to show another project's files.
    return textResponse(
      503,
      "Erdou preview: the Erdou tab that owns this preview is gone (owner " + owner + "). A tab that was" +
        " CLOSED — or RELOADED, which starts a new runtime and a new owner id — no longer answers its old" +
        " preview URLs. Reopen the preview from the Erdou tab.",
    );
  }

  const req = await toRequest(event.request, rest);
  const id = nextId++;
  let reply;
  try {
    // `dest` = Request.destination — the page bridge's document gate for
    // preview-script injection. `owner` is echoed so the receiving page can
    // verify the request was addressed to IT (a second, independent check on
    // this routing). Both kept in sync with ProxyRequestMessage in
    // src/lib/preview-bridge.ts.
    reply = await exchange(client, {
      type: "erdou:req",
      id,
      port,
      req,
      dest: event.request.destination,
      owner,
    });
  } catch {
    return textResponse(504, "Erdou preview: the app did not respond in time (port " + port + ").");
  }
  if (reply.error !== undefined) {
    return textResponse(502, "Erdou preview: dispatch failed on port " + port + ": " + reply.error);
  }
  const res = reply.res;
  // Body pick (kept in sync with `answer()` in src/lib/preview-bridge.ts): a
  // streamed reply carries a transferred ReadableStream beside a headers-only
  // `res` — use it as the Response body so the iframe reads chunks as the
  // runtime produces them; otherwise the buffered bytes, exactly as before.
  const body = NULL_BODY_STATUS.has(res.status) ? null : (reply.stream ?? res.body);
  return new Response(body, { status: res.status, headers: res.headers });
}

// Marshal an intercepted Request into the plain shape the runtime expects.
async function toRequest(request, urlRest) {
  const headers = {};
  for (const [key, value] of request.headers) headers[key] = value;
  const body = BODYLESS_METHODS.has(request.method.toUpperCase())
    ? new Uint8Array()
    : new Uint8Array(await request.arrayBuffer());
  return { method: request.method, url: urlRest, headers, body };
}

// The Studio page a request is ADDRESSED to, by the owner id in its own URL.
// This replaces the old `appClient()`, which picked "the first window client
// that is not a preview iframe" — a focus-ordered guess that could dispatch one
// tab's preview into another tab's runtime. There is no candidate set here: an
// exact id match, or null. Notes:
//  - `matchAll` (not `clients.get`) with includeUncontrolled, so a Studio page
//    this root-scope SW has not claimed yet is still found — the property the
//    old code documented and previews still depend on;
//  - the `!startsWith(SCOPE)` rule survives, but as VALIDATION of a named client
//    rather than as selection among many: a preview document is never an owner,
//    so a forged owner id naming another guest's client cannot make one guest
//    serve another;
//  - no worker state is involved. The id belongs to the browser, so a worker
//    that was terminated and restarted mid-session resolves it with zero
//    warm-up — which is why the token is a Client id and not a registry key.
async function ownerClient(owner) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const client = clients.find((c) => c.id === owner);
  if (!client) return null;
  if (new URL(client.url).pathname.startsWith(SCOPE)) return null;
  return client;
}

// Post `message` to the page over a fresh MessageChannel and await its reply.
// The dedicated channel isolates this request's response; `id` is echoed for
// correlation/debugging. Rejects on timeout.
function exchange(client, message) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      reject(new Error("timeout"));
    }, DISPATCH_TIMEOUT_MS);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(event.data || {});
    };
    client.postMessage(message, [channel.port2]);
  });
}

function textResponse(status, text) {
  return new Response(text, { status, headers: { "content-type": "text/plain", "cache-control": "no-store" } });
}
