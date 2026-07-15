import type { FileSystemApi } from "@erdou/runtime-contract";

const SKIP_DIRS = new Set([".git", "node_modules"]);

/**
 * Heuristic for "this .py file is a Flask/WSGI app entrypoint": it either
 * constructs a Flask app (`Flask(` / `= Flask`) or defines a top-level `app =`
 * / `application =` binding (the two conventional WSGI callable names).
 * Deliberately simple — a real WSGI detector would need to parse imports, but
 * this project has no Python AST tooling and the goal is a helpful prefill,
 * not certainty.
 */
function looksLikeWsgiApp(source: string): boolean {
  return /Flask\(|=\s*Flask\b/.test(source) || /^\s*(app|application)\s*=/m.test(source);
}

/** Depth-first search for the first `.py` file (in readdir order) that looks
 *  like a WSGI app entrypoint. Skips VCS/dependency directories. */
function findWsgiEntry(fs: FileSystemApi, dir: string): string | null {
  for (const entry of fs.readdir(dir)) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`;
    if (entry.type === "directory") {
      const found = findWsgiEntry(fs, path);
      if (found) return found;
    } else if (entry.name.endsWith(".py")) {
      const source = new TextDecoder().decode(fs.readFile(path));
      if (looksLikeWsgiApp(source)) return path;
    }
  }
  return null;
}

/**
 * Suggest a run command for the project currently in `fs`, tried in order:
 *  1. A `.py` file anywhere (VCS/`node_modules` excluded) that looks like a
 *     Flask/WSGI app -> `python <file>`.
 *  2. A static site with `/index.html` at the root -> `erdou serve . --spa`.
 *  3. A built static site at `/dist/index.html` -> `erdou serve dist --spa`.
 *  4. Otherwise `null` — nothing to prefill, the user types their own command.
 */
export function detectRunCommand(fs: FileSystemApi): string | null {
  const wsgiEntry = findWsgiEntry(fs, "/");
  if (wsgiEntry) return `python ${wsgiEntry}`;
  if (fs.exists("/index.html")) return "erdou serve . --spa";
  if (fs.exists("/dist/index.html")) return "erdou serve dist --spa";
  return null;
}
