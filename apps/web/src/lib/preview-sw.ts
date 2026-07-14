import { bundle, findEntry } from "@erdou/bundler";
import type { FileSystemApi } from "@erdou/runtime-contract";
import { getEsbuild } from "./preview-build.js";

const encoder = new TextEncoder();
const SOURCE = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs"]);
const SKIP = new Set([".git", "node_modules"]);

export interface SiteFile {
  body: Uint8Array;
  type: string;
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html",
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
const extOf = (p: string): string => p.slice(p.lastIndexOf(".") + 1).toLowerCase();
const contentType = (p: string): string => CONTENT_TYPES[extOf(p)] ?? "application/octet-stream";

function listFiles(fs: FileSystemApi, dir: string, out: string[]): void {
  for (const e of fs.readdir(dir)) {
    if (SKIP.has(e.name)) continue;
    const p = dir === "/" ? `/${e.name}` : `${dir}/${e.name}`;
    if (e.type === "directory") listFiles(fs, p, out);
    else out.push(p);
  }
}

function shell(hasCss: boolean): string {
  return `<!doctype html><html><head><meta charset="utf-8"><base href="./">${
    hasCss ? '<link rel="stylesheet" href="app.css">' : ""
  }<style>body{margin:0;font-family:system-ui,sans-serif}</style></head><body><div id="root"></div><div id="app"></div><script type="module" src="app.js"></script></body></html>`;
}

export interface SiteResult {
  files?: Record<string, SiteFile>;
  errors: string[];
  entry: string | null;
}

/** Build the project into a virtual site: the bundled entry + a shell + all
 *  non-source files (assets/data), so a multi-file app with fetch()/routing runs. */
export async function buildSite(fs: FileSystemApi): Promise<SiteResult> {
  const entry = findEntry(fs);
  if (!entry) {
    return { entry: null, errors: ["No entry found. Create /src/main.tsx (or an index.html with a module script)."] };
  }
  const out = await bundle({ esbuild: await getEsbuild(), fs, entry });
  if (out.errors.length > 0) return { entry, errors: out.errors };

  const files: Record<string, SiteFile> = {};
  const all: string[] = [];
  listFiles(fs, "/", all);
  for (const p of all) {
    if (SOURCE.has(extOf(p)) || p === "/index.html") continue;
    files[p] = { body: fs.readFile(p), type: contentType(p) };
  }
  files["/app.js"] = { body: encoder.encode(out.js), type: "text/javascript" };
  if (out.css) files["/app.css"] = { body: encoder.encode(out.css), type: "text/css" };
  files["/index.html"] = { body: encoder.encode(shell(out.css.length > 0)), type: "text/html" };
  return { entry, errors: [], files };
}

let registration: Promise<ServiceWorkerRegistration | null> | undefined;
export function registerPreviewSW(): Promise<ServiceWorkerRegistration | null> {
  if (!registration) {
    registration = (async () => {
      if (!("serviceWorker" in navigator)) return null;
      try {
        return await navigator.serviceWorker.register("/preview-sw.js", { scope: "/__preview__/" });
      } catch {
        return null;
      }
    })();
  }
  return registration;
}

function activeWorker(reg: ServiceWorkerRegistration): Promise<ServiceWorker | null> {
  // Can't use navigator.serviceWorker.ready — our scope (/__preview__/) doesn't
  // cover the app page, so it never resolves. Wait on the registration instead.
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

/** Publish a site to the service worker. Returns false if the SW isn't serving. */
export async function publishSite(id: string, files: Record<string, SiteFile>): Promise<boolean> {
  const reg = await registerPreviewSW();
  if (!reg) return false;
  const sw = await activeWorker(reg);
  if (!sw) return false;
  sw.postMessage({ type: "erdou:site", id, files });
  // Health check: confirm the SW actually serves this site (else caller falls back).
  try {
    await new Promise((r) => setTimeout(r, 80));
    const res = await fetch(`/__preview__/${id}/index.html`, { cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

export const previewUrl = (id: string, version: number): string => `/__preview__/${id}/?v=${version}`;
