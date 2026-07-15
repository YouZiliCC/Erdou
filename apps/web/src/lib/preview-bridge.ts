import type { HttpRequest, HttpResponse } from "@erdou/runtime-contract";

/**
 * The preview reverse-proxy bridge (page side).
 *
 * The preview Service Worker (`public/preview-sw.js`) intercepts an iframe's
 * requests under `/__preview__/<port>/…`, marshals each to a plain
 * `{method,url,headers,body}`, and posts it to this page over a per-request
 * `MessageChannel`. Here we `dispatch` it into the in-browser runtime and post
 * the `HttpResponse` back down the same channel. The SW turns that into a real
 * `Response`. Request → response only: no caching, no streaming.
 *
 * `fetchToHttpRequest` / `httpResponseToResponse` are the pure marshalling
 * helpers (unit-tested here). The SW mirrors the same marshalling inline
 * because it is served as static JS and cannot import this module; the two must
 * stay in sync.
 */

/** The same-origin scope the preview SW controls; a previewed app on port N is
 *  viewed at `/__preview__/<N>/…`. */
export const PREVIEW_SCOPE = "/__preview__/";

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);
// Statuses whose `Response` must have a null body — passing any body (even an
// empty Uint8Array) makes the `Response` constructor throw.
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

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

/** The SW → page request envelope (also declared inline in the SW). */
interface ProxyRequestMessage {
  type: "erdou:req";
  id: number;
  port: number;
  req: HttpRequest;
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
}

let bridgeInstalled = false;

/**
 * Listen for proxied requests from the preview SW and answer them by dispatching
 * into `runtime`. Idempotent; a guarded no-op when there is no Service Worker
 * (SSR, tests, unsupported browsers).
 */
export function installPreviewBridge(runtime: DispatchRuntime): void {
  if (bridgeInstalled) return;
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return;
  }
  bridgeInstalled = true;
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    if (!isProxyRequest(event.data)) return;
    const replyPort = event.ports[0];
    if (!replyPort) return;
    void answer(runtime, event.data, replyPort);
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
 * the SW at the preview scope so it can intercept preview iframes. Guarded so a
 * no-SW environment just logs and skips (the app still runs, sans preview).
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
    const reg = await navigator.serviceWorker.register("/preview-sw.js", { scope: PREVIEW_SCOPE });
    await activeWorker(reg);
  } catch (err) {
    console.warn("[erdou] preview SW registration failed", err);
  }
}

async function answer(
  runtime: DispatchRuntime,
  msg: ProxyRequestMessage,
  replyPort: MessagePort,
): Promise<void> {
  try {
    const res = await runtime.dispatch(msg.port, msg.req);
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
