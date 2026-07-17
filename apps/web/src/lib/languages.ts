import { createPythonRunners, type PipPyodide } from "@erdou/lang-python";
import { createWasiRunner } from "@erdou/runtime-wasi";
import { createGitRunner } from "@erdou/tool-git";
import type { BrowserRuntime } from "@erdou/runtime-browser";

const PYODIDE_VERSION = "0.26.4";
const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

export interface RegisterLanguagesOptions {
  /** Test seam — hermetic tests inject a fake in place of the CDN loader. */
  loadPyodide?: () => Promise<PipPyodide>;
}

/**
 * Register optional runtimes. Python (Pyodide, ~10MB) lazily loads from a CDN on
 * first use; `pip`/`pip3` share the same cached instance so installs land in the
 * interpreter `python` runs in. The WASI runner runs any wasm32-wasi binary in
 * the filesystem.
 */
export function registerLanguages(runtime: BrowserRuntime, opts: RegisterLanguagesOptions = {}): void {
  const load =
    opts.loadPyodide ??
    (async () => {
      const mod = await import(/* @vite-ignore */ `${PYODIDE_URL}pyodide.mjs`);
      return mod.loadPyodide({ indexURL: PYODIDE_URL });
    });
  const { python, pip } = createPythonRunners({ load });
  runtime.registerProgram("python", python);
  runtime.registerProgram("python3", python);
  runtime.registerProgram("pip", pip);
  runtime.registerProgram("pip3", pip);
  runtime.registerProgram("wasi", createWasiRunner());
  runtime.registerProgram("git", createGitRunner());
}

/** Runtimes the agent should be told it can actually execute. */
export const AGENT_LANGUAGES = ["python", "wasi"];
/** Extra commands (beyond built-ins) the agent should know about. */
export const AGENT_COMMANDS = [
  "git (init/add/commit/log/status/branch)",
  "pip (install <pkg...> / list — Pyodide wheels + pure-Python from PyPI; installs do not survive a reload)",
];
