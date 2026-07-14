import { createPythonRunner } from "@erdou/lang-python";
import type { BrowserRuntime } from "@erdou/runtime-browser";

const PYODIDE_VERSION = "0.26.4";
const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

/**
 * Register optional language runtimes on the runtime. Python (Pyodide, ~10MB)
 * is lazily loaded from a CDN the first time a `python` command actually runs —
 * registering it here is free.
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
}

export const LANGUAGES = ["js", "python"];
