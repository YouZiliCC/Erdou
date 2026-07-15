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

/** Strip the query string and an optional preview-SW `/__port__/<n>` prefix
 *  from a dispatched request URL, leaving a path rooted at `/`. */
function requestPath(url: string): string {
  const withoutQuery = url.split("?")[0] ?? "";
  const withoutPrefix = withoutQuery.replace(PORT_PREFIX, "");
  return withoutPrefix === "" ? "/" : withoutPrefix;
}

function notFound(): HttpResponse {
  return {
    status: 404,
    headers: { "content-type": "text/plain" },
    body: new TextEncoder().encode("Not Found"),
  };
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
    const reqPath = requestPath(req.url);
    let relPath = reqPath.slice(1);
    if (relPath === "" || relPath.endsWith("/")) relPath += "index.html";
    const filePath = join(dir, relPath);
    // Guard against a request path (e.g. containing "../..") escaping the
    // served root via VFS normalization.
    if (filePath !== dir && !filePath.startsWith(root)) return notFound();

    const file = readFile(filePath);
    if (file) return file;
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
