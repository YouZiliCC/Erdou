import * as esbuild from "esbuild-wasm";
import esbuildWasmUrl from "esbuild-wasm/esbuild.wasm?url";
import { bundle, findEntry, type EsbuildApi } from "@erdou/bundler";
import type { FileSystemApi } from "@erdou/runtime-contract";

let initPromise: Promise<void> | undefined;

/** Initialize esbuild-wasm once (idempotent) and return the API. */
export async function getEsbuild(): Promise<EsbuildApi> {
  if (!initPromise) initPromise = esbuild.initialize({ wasmURL: esbuildWasmUrl });
  await initPromise;
  return esbuild as unknown as EsbuildApi;
}

const SOURCE_EXTS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs"]);
const SKIP_NAMES = new Set([".git", "node_modules"]);

function extOf(p: string): string {
  return p.slice(p.lastIndexOf(".") + 1).toLowerCase();
}
function dirnameOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

/** Depth-first listing of every file under `dir`, skipping VCS/dependency
 *  directories and the build output itself (so a rebuild doesn't recurse into
 *  its own prior /dist). */
function listFiles(fs: FileSystemApi, dir: string, out: string[]): void {
  for (const e of fs.readdir(dir)) {
    if (SKIP_NAMES.has(e.name)) continue;
    const p = dir === "/" ? `/${e.name}` : `${dir}/${e.name}`;
    if (p === "/dist") continue;
    if (e.type === "directory") listFiles(fs, p, out);
    else out.push(p);
  }
}

/** The preview shell HTML: loads the bundled app.js (+ app.css if present). */
function shell(hasCss: boolean): string {
  return `<!doctype html><html><head><meta charset="utf-8"><base href="./">${
    hasCss ? '<link rel="stylesheet" href="app.css">' : ""
  }<style>body{margin:0;font-family:system-ui,sans-serif}</style></head><body><div id="root"></div><div id="app"></div><script type="module" src="app.js"></script></body></html>`;
}

/**
 * Assemble `/dist` in the VFS from a bundle's output: the HTML shell,
 * `app.js`, `app.css` (if any css was produced), and every non-source file
 * elsewhere in the project (assets/data), copied under `/dist` preserving
 * paths — so a multi-file app with fetch()/routing still works once served.
 *
 * Pure aside from the `fs` it's handed (no esbuild call here) — this is what
 * the unit tests exercise without needing a live bundler.
 */
export function assembleDist(fs: FileSystemApi, out: { js: string; css: string }): void {
  fs.rm("/dist", { recursive: true, force: true });
  fs.mkdir("/dist", { recursive: true });

  const all: string[] = [];
  listFiles(fs, "/", all);
  for (const p of all) {
    if (SOURCE_EXTS.has(extOf(p)) || p === "/index.html") continue;
    const dest = `/dist${p}`;
    fs.mkdir(dirnameOf(dest), { recursive: true });
    fs.writeFile(dest, fs.readFile(p));
  }

  fs.writeFile("/dist/app.js", out.js);
  if (out.css) fs.writeFile("/dist/app.css", out.css);
  fs.writeFile("/dist/index.html", shell(out.css.length > 0));
}

export interface BundleProjectResult {
  ok: boolean;
  errors: string[];
  entry: string | null;
}

/**
 * Find the project's entry, bundle it in-browser with esbuild-wasm, and
 * assemble `/dist`. Fails fast: with no entry, or with bundle errors, nothing
 * is written to `/dist` and the errors are returned verbatim for the UI.
 */
export async function bundleProject(fs: FileSystemApi): Promise<BundleProjectResult> {
  const entry = findEntry(fs);
  if (!entry) {
    return { ok: false, errors: ["No entry found (e.g. /src/main.tsx or an index.html module)."], entry: null };
  }
  const out = await bundle({ esbuild: await getEsbuild(), fs, entry });
  if (out.errors.length > 0) return { ok: false, errors: out.errors, entry };
  assembleDist(fs, out);
  return { ok: true, errors: [], entry };
}

/** Whether the project has something `bundleProject` could bundle (a
 *  conventional TS/JS entry) — used by the Preview panel to decide whether to
 *  surface "Bundle & Run". */
export function hasBundleEntry(fs: FileSystemApi): boolean {
  return findEntry(fs) !== null;
}
