// Erdou preview service worker: an in-browser dev server. The app posts a
// "site" (a map of path -> { body, type }); this SW serves it under
// /__preview__/<id>/ with SPA fallback, so multi-file apps, static assets,
// fetch(), and client-side routing all work in the preview iframe.

const sites = new Map();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg && msg.type === "erdou:site" && msg.id) {
    sites.set(msg.id, msg.files || {});
  }
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  let siteId;
  let path;
  const direct = url.pathname.match(/^\/__preview__\/([^/]+)(\/.*)?$/);
  if (direct) {
    siteId = direct[1];
    path = direct[2] || "/";
  } else {
    // Absolute path (e.g. fetch('/data.json')) from a preview document — map it
    // into that document's site via the referrer.
    const ref = event.request.referrer;
    const viaRef = ref && new URL(ref).pathname.match(/^\/__preview__\/([^/]+)\//);
    if (viaRef) {
      siteId = viaRef[1];
      path = url.pathname;
    }
  }
  if (!siteId) return;

  const site = sites.get(siteId);
  if (!site) return;
  event.respondWith(serve(site, path, event.request));
});

function serve(site, path, request) {
  if (path === "/" || path === "") path = "/index.html";
  let file = site[path];
  if (!file && request.mode === "navigate") file = site["/index.html"]; // SPA fallback
  if (!file) return new Response("Erdou preview: not found " + path, { status: 404 });
  return new Response(file.body, {
    headers: {
      "content-type": file.type,
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
  });
}
