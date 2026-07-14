import * as esbuild from "esbuild-wasm";
import esbuildWasmUrl from "esbuild-wasm/esbuild.wasm?url";
import { bundle, findEntry, previewHtml, type EsbuildApi } from "@erdou/bundler";
import type { FileSystemApi } from "@erdou/runtime-contract";

let initPromise: Promise<void> | undefined;

/** Initialize esbuild-wasm once and return the API. */
export async function getEsbuild(): Promise<EsbuildApi> {
  if (!initPromise) initPromise = esbuild.initialize({ wasmURL: esbuildWasmUrl });
  await initPromise;
  return esbuild as unknown as EsbuildApi;
}

export interface PreviewResult {
  html?: string;
  errors: string[];
  entry: string | null;
}

/** Fallback: a single self-contained document for a sandboxed srcdoc iframe. */
export async function buildPreview(fs: FileSystemApi): Promise<PreviewResult> {
  const entry = findEntry(fs);
  if (!entry) {
    return {
      entry: null,
      errors: ["No entry found. Create /src/main.tsx (or an index.html with a module script)."],
    };
  }
  const out = await bundle({ esbuild: await getEsbuild(), fs, entry });
  if (out.errors.length > 0) return { entry, errors: out.errors };
  return { entry, errors: [], html: previewHtml(out.js, out.css) };
}
