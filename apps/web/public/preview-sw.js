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
// This marshalling + routing mirrors `src/lib/preview-bridge.ts` (which cannot
// be imported here — this file is served as static JS). Keep the two in sync.

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
// A preview-scope path: `/__preview__/<primary>/…`. Group 1 is the primary port.
const PREVIEW_PATH = /^\/__preview__\/([^/]+)(\/.*)?$/;

// Kept in EXACT sync with `resolvePort`/`routePreviewRequest` in
// `src/lib/preview-bridge.ts` — see that copy's doc comments for the full
// scheme. This file is served as static JS and cannot import TS, hence the
// duplication.

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

// Parse the primary port from a `/__preview__/<primary>/…` pathname, or null.
function previewPrimary(pathname) {
  const match = PREVIEW_PATH.exec(pathname);
  if (!match) return null;
  const primary = Number(match[1]);
  return Number.isInteger(primary) ? primary : null;
}

function resolvePort(pathname, primary) {
  const afterScope = pathname.slice(SCOPE.length + String(primary).length);
  return applyOverride(afterScope, primary);
}

// Decide whether an intercepted request belongs to a previewed guest and, if so,
// which guest `port` and `guestPath` to forward it to. Returns null for a
// PASSTHROUGH — a request the SW must NOT touch (the Studio app's own traffic).
//   1. In-scope: the URL is under `/__preview__/<primary>/…`.
//   2. Absolute-path escape: the URL is out of scope but the `previewContextUrl`
//      is a SAME-ORIGIN preview iframe (the guest used an absolute path).
// `previewContextUrl` identifies which guest an out-of-scope request escaped
// from: the SW sources it from the INITIATING CLIENT's document URL (robust to
// the guest's Referrer-Policy), falling back to the request referrer — i.e.
// `client.url ?? referrer`. Either case honors a /__port__/<n>/ sibling-override.
// `guestPath` carries no query string — the caller appends `url.search`.
function routePreviewRequest(requestUrl, previewContextUrl) {
  const req = new URL(requestUrl);
  const scopePrimary = previewPrimary(req.pathname);
  if (scopePrimary !== null) {
    const { port, rest } = resolvePort(req.pathname, scopePrimary);
    return { port, guestPath: rest };
  }
  if (!previewContextUrl) return null;
  let ctx;
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

// Monotonic request id — correlates each forwarded request with its reply.
let nextId = 1;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // In-scope preview requests (`/__preview__/<port>/…`) are fully determined by
  // the URL alone — no client lookup needed. Decide synchronously.
  if (previewPrimary(url.pathname) !== null) {
    event.respondWith(proxy(event, routePreviewRequest(url.href, "")));
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
// escaped from: the initiating client's document URL (`/__preview__/<port>/…`,
// unaffected by Referrer-Policy), falling back to the request referrer when the
// client is unavailable (e.g. a navigation, whose clientId is empty).
async function previewContext(event) {
  if (event.clientId) {
    const client = await self.clients.get(event.clientId);
    if (client) return client.url;
  }
  return event.request.referrer;
}

async function proxy(event, route) {
  const url = new URL(event.request.url);
  const { port, guestPath } = route;
  // Query string was stripped from guestPath; reattach it here.
  const rest = guestPath + url.search;

  const client = await appClient();
  if (!client) {
    return textResponse(503, "Erdou preview: no controlling Studio page — open the Erdou tab and retry.");
  }

  const req = await toRequest(event.request, rest);
  const id = nextId++;
  let reply;
  try {
    // `dest` = Request.destination — the page bridge's document gate for
    // preview-script injection (kept in sync with ProxyRequestMessage in
    // src/lib/preview-bridge.ts).
    reply = await exchange(client, { type: "erdou:req", id, port, req, dest: event.request.destination });
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

// The Studio page that runs the bridge is any same-origin window client whose
// URL is NOT under the preview scope (the iframe itself is under it). Use
// includeUncontrolled so the app page is found even before this root-scope SW
// has claimed it.
async function appClient() {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return clients.find((c) => !new URL(c.url).pathname.startsWith(SCOPE)) || null;
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
