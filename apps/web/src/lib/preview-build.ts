import * as esbuild from "esbuild-wasm";
import esbuildWasmUrl from "esbuild-wasm/esbuild.wasm?url";
import { bundle, findEntry, previewHtml, type EsbuildApi } from "@erdou/bundler";
import type { FileSystemApi } from "@erdou/runtime-contract";

let initPromise: Promise<void> | undefined;
function ensureInit(): Promise<void> {
  if (!initPromise) initPromise = esbuild.initialize({ wasmURL: esbuildWasmUrl });
  return initPromise;
}

export interface PreviewResult {
  html?: string;
  errors: string[];
  entry: string | null;
}

/**
 * Bundle the project in the runtime filesystem into a self-contained preview
 * document (local code from the VFS, npm deps from esm.sh). Everything runs in
 * the browser — nothing is sent to a server.
 */
export async function buildPreview(fs: FileSystemApi): Promise<PreviewResult> {
  const entry = findEntry(fs);
  if (!entry) {
    return {
      entry: null,
      errors: ["No entry found. Create /src/main.tsx (or an index.html with a module script)."],
    };
  }
  await ensureInit();
  const out = await bundle({ esbuild: esbuild as unknown as EsbuildApi, fs, entry });
  if (out.errors.length > 0) return { entry, errors: out.errors };
  return { entry, errors: [], html: previewHtml(out.js, out.css) };
}
