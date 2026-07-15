import type { HttpRequest, HttpResponse } from "@erdou/runtime-contract";

/**
 * Pure marshalling between Erdou's generic `HttpRequest`/`HttpResponse` and the
 * WSGI (PEP 3333) `environ` dict / `start_response` triple. No Pyodide here —
 * these are plain, unit-testable transforms. The bridge in `erdou-module.ts`
 * attaches `wsgi.input`/`wsgi.errors` (which need Python objects) around them.
 */

/** Split a request URL into `[PATH_INFO, QUERY_STRING]` (query without the `?`). */
function splitUrl(url: string): [string, string] {
  const q = url.indexOf("?");
  if (q === -1) return [url, ""];
  return [url.slice(0, q), url.slice(q + 1)];
}

/**
 * Build a WSGI `environ` from an `HttpRequest`. Maps method/path/query,
 * `Content-Type`/`Content-Length` (kept out of the `HTTP_*` space per the CGI
 * convention), every other header to `HTTP_<UPPER_WITH_UNDERSCORES>`, and the
 * minimal `wsgi.*`/`SERVER_*` keys a WSGI app expects. `wsgi.input` and
 * `wsgi.errors` are added later (they require Python objects), so this stays
 * pure. `CONTENT_LENGTH` falls back to the actual body length so an app that
 * reads `wsgi.input` sees the right byte count even without the header.
 */
export function buildEnviron(req: HttpRequest): Record<string, unknown> {
  const [path, query] = splitUrl(req.url);
  const environ: Record<string, unknown> = {
    REQUEST_METHOD: req.method,
    SCRIPT_NAME: "",
    PATH_INFO: path,
    QUERY_STRING: query,
    SERVER_NAME: "erdou.local",
    SERVER_PORT: "80",
    SERVER_PROTOCOL: "HTTP/1.1",
    "wsgi.version": [1, 0],
    "wsgi.url_scheme": "http",
    "wsgi.multithread": false,
    "wsgi.multiprocess": false,
    "wsgi.run_once": false,
  };

  for (const [rawKey, value] of Object.entries(req.headers)) {
    const key = rawKey.toLowerCase();
    if (key === "content-type") {
      environ.CONTENT_TYPE = value;
      continue;
    }
    if (key === "content-length") {
      environ.CONTENT_LENGTH = value;
      continue;
    }
    environ["HTTP_" + key.toUpperCase().replace(/-/g, "_")] = value;
  }

  if (environ.CONTENT_LENGTH === undefined && req.body.length > 0) {
    environ.CONTENT_LENGTH = String(req.body.length);
  }

  return environ;
}

/**
 * Collect a WSGI response — the `"<code> <reason>"` status line, the
 * `[name, value]` header pairs, and the iterated body chunks — into an
 * `HttpResponse`. Header names are lower-cased (Erdou stores headers
 * lower-cased); a malformed status line degrades to 500.
 */
export function collectResponse(
  status: string,
  headers: [string, string][],
  chunks: Uint8Array[],
): HttpResponse {
  const code = Number.parseInt(status, 10);

  const outHeaders: Record<string, string> = {};
  for (const [name, value] of headers) {
    outHeaders[name.toLowerCase()] = value;
  }

  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }

  return { status: Number.isNaN(code) ? 500 : code, headers: outHeaders, body };
}
