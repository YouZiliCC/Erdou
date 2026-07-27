import type { FileSystemApi, HttpHandler, HttpRequest, HttpResponse } from "@erdou/runtime-contract";
import type { Program } from "../process/program.js";
import { join } from "../vfs/path.js";
import { abs, shortFlags } from "./util.js";

/**
 * Extension -> MIME type for the built-in static server. A small local copy
 * (not imported from apps/web's `preview-sw.ts`) — runtime-browser must not
 * depend on the app layer.
 */
const CONTENT_TYPES: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  wasm: "application/wasm",
  txt: "text/plain",
  md: "text/markdown",
};

function contentType(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  if (dot <= slash) return "application/octet-stream";
  return CONTENT_TYPES[path.slice(dot + 1).toLowerCase()] ?? "application/octet-stream";
}

/** True if the final path segment has a `.ext` — used to tell a SPA client
 *  route (e.g. `/dashboard`) apart from a missing asset (e.g. `/app.css`). */
function looksLikeFile(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.includes(".");
}

const PORT_PREFIX = /^\/__port__\/\d+/;

/**
 * Strip an optional preview-SW `/__port__/<n>` prefix from a dispatched
 * request path and percent-decode it, giving the VFS path the page actually
 * linked to. The production caller is the preview Service Worker, which
 * derives the path from `new URL(...).pathname` — ALWAYS percent-encoded — so
 * without decoding, `<img src="图片.png">` and `href="my file.txt"` miss every
 * lookup and 404. Returns null for a malformed escape (e.g. a bare "%"), which
 * the caller answers with 400 rather than guessing at the raw bytes.
 */
function requestPath(rawPath: string): string | null {
  const withoutPrefix = rawPath.replace(PORT_PREFIX, "");
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutPrefix);
  } catch {
    return null;
  }
  return decoded === "" ? "/" : decoded;
}

function textResponse(status: number, body: string, extraHeaders?: Record<string, string>): HttpResponse {
  return {
    status,
    headers: { "content-type": "text/plain", ...extraHeaders },
    body: new TextEncoder().encode(body),
  };
}

function notFound(): HttpResponse {
  return textResponse(404, "Not Found");
}

/** Build a static-file `HttpHandler` rooted at `dir` (an absolute VFS path).
 *  `--spa` serves `dir/index.html` for a non-file route that doesn't resolve
 *  to a real file, so a client-side router can take over. */
function makeHandler(fs: FileSystemApi, dir: string, spa: boolean): HttpHandler {
  const root = dir === "/" ? "/" : dir + "/";

  const readFile = (path: string): HttpResponse | null => {
    if (!fs.exists(path) || fs.stat(path).type !== "file") return null;
    return { status: 200, headers: { "content-type": contentType(path) }, body: fs.readFile(path) };
  };

  return (req: HttpRequest): HttpResponse => {
    const q = req.url.indexOf("?");
    const rawPath = q === -1 ? req.url : req.url.slice(0, q);
    const query = q === -1 ? "" : req.url.slice(q);
    const reqPath = requestPath(rawPath);
    if (reqPath === null) return textResponse(400, `Bad Request: malformed percent-encoding in path '${rawPath}'`);

    const relPath = reqPath.slice(1);
    // A path ending in `/` (or the bare root) asks for the directory index. Track
    // that we synthesized `index.html`: the directory branch below must not
    // redirect a path that already carries its trailing slash.
    const wantsIndex = relPath === "" || relPath.endsWith("/");
    const filePath = join(dir, wantsIndex ? relPath + "index.html" : relPath);
    // Guard against a request path (e.g. containing "../..") escaping the
    // served root via VFS normalization.
    if (filePath !== dir && !filePath.startsWith(root)) return notFound();

    const file = readFile(filePath);
    if (file) return file;
    // `/docs` names a real directory: redirect to `docs/` so the index lookup
    // above can fire and so relative links inside that page resolve against
    // the directory. This must precede the SPA branch — looksLikeFile("/docs")
    // is false, so otherwise --spa would answer with the ROOT index.html and
    // silently serve the wrong page.
    //
    // The location is RELATIVE (RFC 7231 §7.1.2 allows it), never origin-
    // absolute: the production caller (apps/web/public/preview-sw.js) strips
    // BOTH `/__preview__/<owner>/<primary>` and `/__port__/<n>` before dispatch,
    // so this handler never sees the scope it has to stay inside — an absolute
    // `/docs/` would resolve against the Studio origin and leave the preview
    // entirely (and could not be rebuilt here: the `<owner>` segment names the
    // Studio page that owns the preview and is unknown to the runtime).
    // A relative reference resolves against the URL the browser actually
    // requested, so it lands correctly under any scope (including a direct
    // `/__port__/<n>/…` dispatch, which bypasses the SW). The leading `./`
    // stops a segment holding a colon (`data:x`) from parsing as a scheme.
    //
    // 302, never 301: this is a live dev preview over a filesystem the agent
    // rewrites constantly. Browsers cache a 301 persistently, so once `/docs`
    // had redirected, replacing that directory with `docs.html` would pin the
    // user to a dead URL with no fix short of purging the cache.
    if (fs.exists(filePath) && fs.stat(filePath).type === "directory") {
      // The one shape that would loop: a DIRECTORY named `index.html`. `/docs/`
      // resolves to `docs/index.html`, itself a directory, whose trailing-slash
      // form is `/docs//` — and around again. Having already appended
      // `index.html` there is no slash left to add, so fail fast naming the path.
      if (wantsIndex) {
        return textResponse(500, `Internal Server Error: '${filePath}' is a directory, not an index file`);
      }
      // Keep the raw (still percent-encoded) final segment: reqPath is decoded,
      // and a decoded `my file` is not a valid URI reference in a location.
      const segment = rawPath.slice(rawPath.lastIndexOf("/") + 1);
      return textResponse(302, "Found", { location: `./${segment}/${query}` });
    }
    if (spa && !looksLikeFile(reqPath)) {
      const index = readFile(join(dir, "index.html"));
      if (index) return index;
    }
    return notFound();
  };
}

const USAGE = "usage: erdou serve <dir> [port] [--spa]\n";

/**
 * The `erdou` built-in. Currently just `serve`: registers a static-file
 * handler over the VFS on a virtual port and exits — the handler persists in
 * the port registry after the process is gone (`erdou stop` closes it later).
 */
export const erdou: Program = async (ctx) => {
  const sub = ctx.argv[1];
  if (sub !== "serve") {
    ctx.stderr.write(USAGE);
    return 2;
  }

  const rest = ctx.argv.slice(2);
  const { positional } = shortFlags(rest);
  // shortFlags splits a multi-char dash-prefixed token into individual short
  // flags (it has no notion of a "--long" flag as a unit), so a boolean
  // long flag like --spa is checked directly against the raw args instead.
  const spa = rest.includes("--spa");

  const dirArg = positional[0];
  if (dirArg === undefined) {
    ctx.stderr.write(USAGE);
    return 2;
  }
  const dir = abs(ctx.cwd, dirArg);

  const portArg = positional[1];
  const port = portArg === undefined ? 8080 : Number.parseInt(portArg, 10);
  if (Number.isNaN(port)) {
    ctx.stderr.write(`erdou serve: invalid port '${portArg}'\n`);
    return 2;
  }

  ctx.serve(port, makeHandler(ctx.fs, dir, spa));
  ctx.stdout.write(`serving ${dir} on port ${port}\n`);
  return 0;
};
