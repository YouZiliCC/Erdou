// Erdou preview service worker: a reverse proxy for the in-browser runtime.
//
// It intercepts a preview iframe's requests, marshals each into a plain
// `{method,url,headers,body}`, and forwards it to the controlling Studio page
// over a per-request MessageChannel. The page dispatches it into the runtime
// (`runtime.dispatch(port, req)`) and posts the `HttpResponse` back down the
// channel; we turn that into a real `Response` for the iframe. Request →
// response only: no caching, no streaming.
//
// The worker registers at ROOT scope `/` (not `/__preview__/`) so it can also
// catch a guest's ABSOLUTE-path resources (`<link href="/style.css">`), which
// resolve against the app origin and escape the `/__preview__/` prefix.
// `routePreviewRequest` is the safety gate: only in-scope requests and requests
// referred by a same-origin preview iframe are proxied — the Studio app's own
// traffic returns `null` and is left to the browser untouched.
//
// This marshalling + routing mirrors `src/lib/preview-bridge.ts` (which cannot
// be imported here — this file is served as static JS). Keep the two in sync.

const SCOPE = "/__preview__/";
// Bound the wait for the page to answer. A hung/absent dispatch becomes a 504
// instead of leaving the iframe request pending forever.
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
//   2. Absolute-path escape: the URL is out of scope but its REFERRER is a
//      SAME-ORIGIN preview iframe (the guest used an absolute path).
// Either case honors a /__port__/<n>/ sibling-override. `guestPath` carries no
// query string — the caller appends `url.search`.
function routePreviewRequest(requestUrl, referrer) {
  const req = new URL(requestUrl);
  const scopePrimary = previewPrimary(req.pathname);
  if (scopePrimary !== null) {
    const { port, rest } = resolvePort(req.pathname, scopePrimary);
    return { port, guestPath: rest };
  }
  if (!referrer) return null;
  let ref;
  try {
    ref = new URL(referrer);
  } catch {
    return null;
  }
  if (ref.origin !== req.origin) return null;
  const refPrimary = previewPrimary(ref.pathname);
  if (refPrimary === null) return null;
  const { port, rest } = applyOverride(req.pathname, refPrimary);
  return { port, guestPath: rest };
}

// Monotonic request id — correlates each forwarded request with its reply.
let nextId = 1;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const route = routePreviewRequest(event.request.url, event.request.referrer);
  // Passthrough: not a preview request. Leave the app's own traffic to the
  // browser — never call respondWith for it (the critical safety property of
  // registering at root scope).
  if (!route) return;
  event.respondWith(proxy(event, route));
});

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
    reply = await exchange(client, { type: "erdou:req", id, port, req });
  } catch {
    return textResponse(504, "Erdou preview: the app did not respond in time (port " + port + ").");
  }
  if (reply.error !== undefined) {
    return textResponse(502, "Erdou preview: dispatch failed on port " + port + ": " + reply.error);
  }
  const res = reply.res;
  const body = NULL_BODY_STATUS.has(res.status) ? null : res.body;
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
