import type { HttpResponse } from "@erdou/runtime-contract";

/**
 * HTML rewriting for previewed guest documents — the injection seam the page
 * bridge applies to a dispatch result before replying to the Service Worker
 * (see `answer()` in preview-bridge.ts).
 *
 * `rewriteHtml(res, inserts)` is the PURE core: it inserts `<script>` tags
 * into an HTML response body, right after `<head…>` so the scripts run before
 * any guest code (spike-proven to preserve standards mode). It is shared
 * infrastructure: the inserts are the console/error observability hook
 * (`PREVIEW_HOOK_SOURCE` — read by the agent's preview_logs tool) and the
 * WebSocket shim (`WS_SHIM_SOURCE`). A future preview script joins the same
 * `inserts` list in `injectPreviewScripts` — extend the array there, do not
 * add a second rewrite pass.
 *
 * Injection deliberately narrows to responses that are (a) an actual DOCUMENT
 * (the SW reports `Request.destination` as `dest` on the request envelope —
 * only "document"/"iframe" qualify, so a guest `fetch("page.html")` gets its
 * bytes untouched), (b) `text/html` in UTF-8 (no declared non-UTF-8 charset),
 * (c) not content-encoded (we cannot rewrite compressed bytes), and (d) not
 * streamed (`res.stream` — SSE is never HTML anyway). Everything else passes
 * through BYTE-IDENTICAL — the function returns the SAME object so callers
 * can cheaply detect "untouched".
 */

/** Case-insensitive header lookup on the contract's plain-record headers. */
function findHeader(headers: Record<string, string>, name: string): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return v;
  }
  return undefined;
}

function deleteHeader(headers: Record<string, string>, name: string): void {
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === name) delete headers[k];
  }
}

const HEAD_TAG = /<head(\s[^>]*)?>/i;
const DOCTYPE = /^\s*<!doctype[^>]*>/i;

/** True when `res` is an HTML document this module may rewrite (see the
 *  module doc's (b)–(d) guards). Exported for the bridge's CSP warning. */
export function isRewritableHtml(res: HttpResponse): boolean {
  if (res.stream !== undefined) return false;
  const ct = (findHeader(res.headers, "content-type") ?? "").toLowerCase();
  if (!ct.includes("text/html")) return false;
  const charset = /charset=\s*"?([^;"\s]+)/.exec(ct)?.[1];
  if (charset !== undefined && charset !== "utf-8" && charset !== "utf8") return false;
  if (findHeader(res.headers, "content-encoding") !== undefined) return false;
  return true;
}

/**
 * PURE: insert `inserts` (JS source strings) as `<script>` tags into an HTML
 * response — after the opening `<head…>` tag when present, else after the
 * doctype (keeping standards mode), else prepended. Returns the SAME object
 * when nothing applies (guards above / no inserts). When it rewrites:
 * `content-length` is recomputed if the response carried one, and any
 * `content-security-policy` header is dropped — a guest CSP would silently
 * block the inline scripts we just injected (the caller logs this).
 */
export function rewriteHtml(res: HttpResponse, inserts: readonly string[]): HttpResponse {
  if (inserts.length === 0 || !isRewritableHtml(res)) return res;
  const html = new TextDecoder().decode(res.body);
  const tags = inserts.map((src) => "<script>" + src + "</scr" + "ipt>").join("");
  const head = HEAD_TAG.exec(html);
  const doctype = head ? null : DOCTYPE.exec(html);
  const at = head ? head.index + head[0].length : doctype ? doctype[0].length : 0;
  const body = new TextEncoder().encode(html.slice(0, at) + tags + html.slice(at));
  const headers = { ...res.headers };
  if (findHeader(headers, "content-length") !== undefined) {
    deleteHeader(headers, "content-length");
    headers["content-length"] = String(body.length);
  }
  deleteHeader(headers, "content-security-policy");
  return { status: res.status, headers, body };
}

/**
 * The bridge's injection policy: previewed DOCUMENTS ("document" = the
 * open-in-new-tab preview, "iframe" = the preview panel + any guest-nested
 * iframe) get the preview scripts; every other destination — and any request
 * from a pre-`dest` Service Worker (version skew) — passes through untouched.
 */
export function injectPreviewScripts(res: HttpResponse, dest: string | undefined): HttpResponse {
  if (dest !== "document" && dest !== "iframe") return res;
  // Hook FIRST: the console wrap must be installed before any other injected
  // or guest script can log (and a shim failure would then be captured too).
  const out = rewriteHtml(res, [PREVIEW_HOOK_SOURCE, WS_SHIM_SOURCE]);
  if (out !== res && findHeader(res.headers, "content-security-policy") !== undefined) {
    console.warn(
      "[erdou] preview: dropped the guest's Content-Security-Policy header to inject the preview scripts",
    );
  }
  return out;
}

/**
 * The console/error observability hook injected into every previewed document
 * (spike-proven verbatim, then hardened). It buffers `{kind, t, text}` entries
 * in the GUEST window's own `window.__erdouLogs` — no host mirror, so a
 * reload/navigation naturally restarts capture for the new document. The
 * agent's preview_logs tool (preview-tools.ts) reads and DRAINS the buffer
 * through `contentWindow`.
 *
 * Mechanics: idempotent guard on `window.__erdouLogs`; wraps
 * console.log/info/warn/error/debug (originals still called — DevTools keeps
 * working); captures uncaught errors via the window `error` event (with
 * file:line) as kind "uncaught" and unhandled promise rejections as kind
 * "unhandledrejection". Bounded on both axes: at most 500 entries
 * (drop-OLDEST, the drop count kept on `__erdouLogs.dropped`) and at most
 * 2000 chars of text per entry, so a pathological logger cannot balloon guest
 * memory. All globals are referenced via `window.` so the source is evaluable
 * against a fake window in unit tests.
 */
export const PREVIEW_HOOK_SOURCE = `(() => {
  if (window.__erdouLogs) return;
  const logs = [];
  logs.dropped = 0;
  window.__erdouLogs = logs;
  const fmt = (a) => {
    let t;
    try {
      if (typeof a === "string") t = a;
      else if (a instanceof Error) t = a.stack || String(a);
      else t = JSON.stringify(a);
    } catch {
      t = String(a);
    }
    if (typeof t !== "string") t = String(t);
    return t.length > 2000 ? t.slice(0, 2000) + "\\u2026" : t;
  };
  const push = (kind, text) => {
    logs.push({ kind, t: Date.now(), text });
    if (logs.length > 500) {
      logs.shift();
      logs.dropped++;
    }
  };
  for (const k of ["log", "info", "warn", "error", "debug"]) {
    const orig = window.console[k];
    window.console[k] = function (...args) {
      push(k, args.map(fmt).join(" "));
      orig.apply(window.console, args);
    };
  }
  window.addEventListener("error", (e) => {
    push("uncaught", (e.message || "error") + " @" + (e.filename || "?") + ":" + (e.lineno || 0));
  });
  window.addEventListener("unhandledrejection", (e) => {
    push("unhandledrejection", fmt(e.reason));
  });
})();`;

/**
 * The WebSocket shim injected into every previewed document (spike-proven
 * verbatim, then hardened): it monkey-patches `window.WebSocket` so a
 * same-host `ws://`/`wss://` target — which the Service Worker can NEVER see
 * (no fetch event fires for WebSocket handshakes) — is tunnelled to the
 * Studio page instead: the shim opens a `MessageChannel`, posts
 * `{type:"erdou:ws-open", port, path, protocols}` with one end to the top
 * window, and speaks frames over the channel. The bridge answers by calling
 * `runtime.upgrade(port, …)` and pumping frames both ways (preview-tools.ts).
 * Foreign-host / non-ws URLs — and documents with no preview scope or no
 * embedding Studio window (the ↗ open-in-new-tab view) — fall through to the
 * NATIVE WebSocket, which fails visibly rather than hanging.
 *
 * Message protocol (append-only — a compatibility surface with the injected
 * shim, same discipline as the SW's `erdou:req` envelope):
 *   page → shim  {type:"open", protocol} | {type:"frame", data} |
 *                {type:"close", code, reason, wasClean} | {type:"error", message}
 *   shim → page  {type:"frame", data} | {type:"close", code, reason}
 * `data` is a string (text frame) or ArrayBuffer/Blob (binary frame).
 */
export const WS_SHIM_SOURCE = `(() => {
  if (window.__erdouWsShim) return;
  window.__erdouWsShim = true;
  const NativeWS = window.WebSocket;
  const SCOPE = /^\\/__preview__\\/(\\d+)(\\/.*)?$/;
  const OVERRIDE = /^\\/__port__\\/(\\d+)(\\/.*)?$/;
  const scope = SCOPE.exec(location.pathname);
  const primary = scope ? Number(scope[1]) : null;
  const studio = window.top;
  class ErdouWebSocket extends EventTarget {
    constructor(url, protocols) {
      super();
      const u = new URL(url, location.href);
      const tunnelable = (u.protocol === "ws:" || u.protocol === "wss:") &&
        u.host === location.host && primary !== null && studio !== null && studio !== window;
      if (!tunnelable) return new NativeWS(url, protocols);
      this.url = u.href;
      this.readyState = 0;
      this.binaryType = "blob";
      this.bufferedAmount = 0;
      this.extensions = "";
      this.protocol = "";
      this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
      let port = primary;
      let path = u.pathname;
      const sc = SCOPE.exec(path);
      if (sc) { port = Number(sc[1]); path = sc[2] || "/"; }
      const o = OVERRIDE.exec(path);
      if (o) { port = Number(o[1]); path = o[2] || "/"; }
      path += u.search;
      const ch = new MessageChannel();
      this._tx = ch.port1;
      ch.port1.onmessage = (e) => this._recv(e.data);
      const list = protocols == null ? [] : (Array.isArray(protocols) ? protocols : [protocols]);
      studio.postMessage({ type: "erdou:ws-open", port, path, protocols: list }, location.origin, [ch.port2]);
    }
    _recv(m) {
      if (!m) return;
      if (m.type === "open" && this.readyState === 0) {
        this.readyState = 1;
        this.protocol = m.protocol || "";
        const ev = new Event("open");
        if (this.onopen) this.onopen(ev);
        this.dispatchEvent(ev);
      } else if (m.type === "frame" && this.readyState === 1) {
        let data = m.data;
        if (data instanceof ArrayBuffer && this.binaryType === "blob") data = new Blob([data]);
        const ev = new MessageEvent("message", { data });
        if (this.onmessage) this.onmessage(ev);
        this.dispatchEvent(ev);
      } else if (m.type === "close" && this.readyState !== 3) {
        this.readyState = 3;
        this._tx.close();
        const ev = new CloseEvent("close", { code: m.code ?? 1005, reason: m.reason || "", wasClean: m.wasClean !== false });
        if (this.onclose) this.onclose(ev);
        this.dispatchEvent(ev);
      } else if (m.type === "error") {
        const ev = new Event("error");
        if (this.onerror) this.onerror(ev);
        this.dispatchEvent(ev);
      }
    }
    send(data) {
      if (this.readyState === 0) throw new DOMException("Still in CONNECTING state.", "InvalidStateError");
      if (this.readyState !== 1) return;
      if (ArrayBuffer.isView(data)) data = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      this._tx.postMessage({ type: "frame", data });
    }
    close(code, reason) {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      this._tx.postMessage({ type: "close", code, reason });
    }
  }
  for (const [k, v] of [["CONNECTING", 0], ["OPEN", 1], ["CLOSING", 2], ["CLOSED", 3]]) {
    ErdouWebSocket[k] = v;
    ErdouWebSocket.prototype[k] = v;
  }
  ErdouWebSocket.__erdouShim = true;
  window.WebSocket = ErdouWebSocket;
})();`;
