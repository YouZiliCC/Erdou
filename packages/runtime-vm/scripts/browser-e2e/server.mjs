// Plain static server for the browser e2e harness. Serves page.html, the
// esbuild-bundled browser-entry.ts, v86's build/{libv86.mjs,v86.wasm,v86-fallback.wasm}
// (served under /v86/ — resolved by page.html's import map), and the baked
// assets/{seabios.bin,vgabios.bin,kernel.bin,state.zst}. Ported from R11b Spike D's
// server.mjs (verbatim MIME/range-free structure); parameterized by env vars instead
// of a fixed `web/` dir since the bundle lives in a temp build dir per run.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = process.env.BUNDLE_PATH; // absolute path to the esbuild-bundled browser-entry.js
const v86BuildDir = process.env.V86_BUILD_DIR; // absolute path to v86's build/ dir
const assetsDir = process.env.ASSETS_DIR; // absolute path to packages/runtime-vm/assets
if (!bundlePath || !v86BuildDir || !assetsDir) {
  throw new Error("server.mjs requires BUNDLE_PATH, V86_BUILD_DIR, and ASSETS_DIR env vars");
}

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".wasm": "application/wasm", ".json": "application/json",
  ".bin": "application/octet-stream", ".zst": "application/octet-stream",
};

function resolveFile(pathname) {
  if (pathname === "/" || pathname === "/index.html") return join(here, "page.html");
  if (pathname === "/bundle.js") return bundlePath;
  if (pathname.startsWith("/v86/")) {
    const rel = pathname.slice("/v86/".length);
    const file = normalize(join(v86BuildDir, rel));
    return file.startsWith(v86BuildDir) ? file : null;
  }
  if (pathname.startsWith("/assets/")) {
    const rel = pathname.slice("/assets/".length);
    const file = normalize(join(assetsDir, rel));
    return file.startsWith(assetsDir) ? file : null;
  }
  return null;
}

const server = createServer(async (req, res) => {
  const pathname = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
  const file = resolveFile(pathname);
  if (!file) { res.writeHead(404).end("not found: " + pathname); return; }
  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(data);
  } catch {
    res.writeHead(404).end("not found: " + file);
  }
});

const port = Number(process.env.PORT ?? 8931);
server.listen(port, "127.0.0.1", () => console.log(`serving on http://127.0.0.1:${port}/`));
