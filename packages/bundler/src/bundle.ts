import type { FileSystemApi } from "@erdou/runtime-contract";

// A structural slice of esbuild's plugin API, so this package doesn't hard-depend
// on esbuild's types. A real esbuild / esbuild-wasm instance satisfies it.
export interface EsbuildOnResolveArgs {
  path: string;
  importer: string;
}
export interface EsbuildOnResolveResult {
  path?: string;
  namespace?: string;
  external?: boolean;
}
export interface EsbuildOnLoadArgs {
  path: string;
}
export interface EsbuildOnLoadResult {
  contents?: string;
  loader?: string;
  resolveDir?: string;
  errors?: { text: string }[];
}
export interface EsbuildPluginBuild {
  onResolve(
    options: { filter: RegExp; namespace?: string },
    cb: (args: EsbuildOnResolveArgs) => EsbuildOnResolveResult | undefined,
  ): void;
  onLoad(
    options: { filter: RegExp; namespace?: string },
    cb: (args: EsbuildOnLoadArgs) => EsbuildOnLoadResult | Promise<EsbuildOnLoadResult>,
  ): void;
}
export interface EsbuildApi {
  build(options: {
    entryPoints: string[];
    bundle: boolean;
    write: boolean;
    format: string;
    jsx?: string;
    jsxImportSource?: string;
    sourcemap?: boolean;
    minify?: boolean;
    plugins: { name: string; setup(build: EsbuildPluginBuild): void }[];
  }): Promise<{ outputFiles?: { path: string; text: string }[]; errors: { text: string }[] }>;
}

export interface BundleInput {
  esbuild: EsbuildApi;
  fs: FileSystemApi;
  /** Absolute VFS path of the entry module, e.g. "/src/main.tsx". */
  entry: string;
  /** CDN base for bare (npm) imports. Default https://esm.sh/. */
  cdn?: string;
  jsxImportSource?: string;
  /** Injectable fetch (defaults to globalThis.fetch) — used to fetch npm deps. */
  fetch?: typeof fetch;
}

export interface BundleOutput {
  js: string;
  css: string;
  errors: string[];
}

const decoder = new TextDecoder();
const NS = "erdou-vfs";
const EXTS = ["", ".tsx", ".ts", ".jsx", ".js", ".mjs", ".json", ".css"];

function normalizePath(p: string): string {
  const stack: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") stack.pop();
    else stack.push(seg);
  }
  return "/" + stack.join("/");
}
function dirnameOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}
function loaderFor(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1);
  if (ext === "tsx") return "tsx";
  if (ext === "ts") return "ts";
  if (ext === "jsx") return "jsx";
  if (ext === "mjs" || ext === "js" || ext === "cjs") return "js";
  if (ext === "json") return "json";
  if (ext === "css") return "css";
  return "text";
}
function resolveFile(fs: FileSystemApi, path: string): string | null {
  for (const e of EXTS) {
    const p = path + e;
    if (fs.exists(p) && fs.stat(p).type === "file") return p;
  }
  for (const e of EXTS) {
    if (!e) continue;
    const p = `${path}/index${e}`;
    if (fs.exists(p) && fs.stat(p).type === "file") return p;
  }
  return null;
}

/**
 * Bundle a project from the Erdou filesystem with esbuild. Relative/absolute
 * imports load from the VFS; bare (npm) imports are rewritten to a CDN (esm.sh)
 * and kept external — so a real React/Vite-style app builds in the browser with
 * no `npm install`.
 */
const HTTP = "http";

export async function bundle(input: BundleInput): Promise<BundleOutput> {
  const cdn = input.cdn ?? "https://esm.sh/";
  const fs = input.fs;
  const fetchFn = input.fetch ?? globalThis.fetch;
  const httpCache = new Map<string, string>();

  async function fetchModule(url: string): Promise<string> {
    const cached = httpCache.get(url);
    if (cached !== undefined) return cached;
    const res = await fetchFn(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`failed to fetch ${url} (${res.status})`);
    const text = await res.text();
    httpCache.set(url, text);
    return text;
  }

  const plugin = {
    name: "erdou-vfs",
    setup(build: EsbuildPluginBuild): void {
      build.onResolve({ filter: /.*/ }, (args) => {
        const spec = args.path;
        // Imports coming from a fetched (http) module: resolve as URLs and keep fetching.
        if (spec.startsWith("http://") || spec.startsWith("https://")) return { path: spec, namespace: HTTP };
        if (args.importer.startsWith("http")) {
          return { path: new URL(spec, args.importer).href, namespace: HTTP };
        }
        // Imports from the VFS (entry + local files).
        if (spec.startsWith("/")) return { path: normalizePath(spec), namespace: NS };
        if (spec.startsWith(".")) {
          const dir = args.importer ? dirnameOf(args.importer) : "/";
          return { path: normalizePath(`${dir}/${spec}`), namespace: NS };
        }
        // Bare (npm) import → fetch from the CDN and bundle it in (self-contained preview).
        return { path: cdn + spec, namespace: HTTP };
      });
      build.onLoad({ filter: /.*/, namespace: NS }, (args) => {
        const resolved = resolveFile(fs, args.path);
        if (!resolved) return { errors: [{ text: `cannot resolve module '${args.path}'` }] };
        return {
          contents: decoder.decode(fs.readFile(resolved)),
          loader: loaderFor(resolved),
          resolveDir: dirnameOf(resolved),
        };
      });
      build.onLoad({ filter: /.*/, namespace: HTTP }, async (args) => {
        try {
          return { contents: await fetchModule(args.path), loader: "js" };
        } catch (err) {
          return { errors: [{ text: err instanceof Error ? err.message : String(err) }] };
        }
      });
    },
  };

  let result: Awaited<ReturnType<EsbuildApi["build"]>>;
  try {
    result = await input.esbuild.build({
      entryPoints: [normalizePath(input.entry)],
      bundle: true,
      write: false,
      format: "esm",
      jsx: "automatic",
      jsxImportSource: input.jsxImportSource ?? "react",
      plugins: [plugin],
    });
  } catch (err) {
    return { js: "", css: "", errors: [err instanceof Error ? err.message : String(err)] };
  }

  // Single-entry write:false builds name JS "<stdout>" and CSS "<stdout>.css".
  const files = result.outputFiles ?? [];
  const cssFile = files.find((f) => f.path.endsWith(".css"));
  const jsFile = files.find((f) => f !== cssFile);
  return { js: jsFile?.text ?? "", css: cssFile?.text ?? "", errors: result.errors.map((e) => e.text) };
}
