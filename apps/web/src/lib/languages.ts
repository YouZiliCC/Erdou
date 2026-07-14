import { createPythonRunner } from "@erdou/lang-python";
import { createWasiRunner } from "@erdou/runtime-wasi";
import type { BrowserRuntime } from "@erdou/runtime-browser";

const PYODIDE_VERSION = "0.26.4";
const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

/**
 * Register optional runtimes. Python (Pyodide, ~10MB) lazily loads from a CDN on
 * first use; the WASI runner runs any wasm32-wasi binary in the filesystem.
 */
export function registerLanguages(runtime: BrowserRuntime): void {
  const python = createPythonRunner({
    load: async () => {
      const mod = await import(/* @vite-ignore */ `${PYODIDE_URL}pyodide.mjs`);
      return mod.loadPyodide({ indexURL: PYODIDE_URL });
    },
  });
  runtime.registerProgram("python", python);
  runtime.registerProgram("python3", python);
  runtime.registerProgram("wasi", createWasiRunner());
}

/** Runtimes the agent should be told it can actually execute. */
export const AGENT_LANGUAGES = ["python", "wasi"];
