// Erdou preview service worker: a reverse proxy for the in-browser runtime.
//
// It intercepts an iframe's requests under `/__preview__/<port>/…`, marshals
// each into a plain `{method,url,headers,body}`, and forwards it to the
// controlling Studio page over a per-request MessageChannel. The page dispatches
// it into the runtime (`runtime.dispatch(port, req)`) and posts the
// `HttpResponse` back down the channel; we turn that into a real `Response` for
// the iframe. Request → response only: no caching, no streaming.
//
// This marshalling mirrors `src/lib/preview-bridge.ts` (which cannot be imported
// here — this file is served as static JS). Keep the two in sync.

const SCOPE = "/__preview__/";
// Bound the wait for the page to answer. A hung/absent dispatch becomes a 504
// instead of leaving the iframe request pending forever.
const DISPATCH_TIMEOUT_MS = 15000;
// Statuses whose Response must have a null body (else the constructor throws).
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);
const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

// Monotonic request id — correlates each forwarded request with its reply.
let nextId = 1;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(SCOPE)) return;
  event.respondWith(proxy(event));
});

async function proxy(event) {
  const url = new URL(event.request.url);
  // /__preview__/<port>/<rest...>
  const match = url.pathname.match(/^\/__preview__\/([^/]+)(\/.*)?$/);
  if (!match) return textResponse(404, "Erdou preview: malformed preview URL " + url.pathname);
  const port = Number(match[1]);
  if (!Number.isInteger(port)) return textResponse(404, "Erdou preview: invalid port '" + match[1] + "'");
  // Path+query already stripped of the /__preview__/<port> scope.
  const rest = (match[2] || "/") + url.search;

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
// includeUncontrolled: the app page lives outside our scope, so we never
// "control" it — we only message it.
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
