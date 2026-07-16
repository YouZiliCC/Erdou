import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Statically walk the default-entry import graph and assert no module in it has a
// top-level `node:*` (or bare node builtin) import — those throw under Vite's
// browser-external stubs at import time (Spike G). assets.ts (node:fs) must NOT
// be reachable from index.ts.
const here = dirname(fileURLToPath(import.meta.url));
function topLevelImports(file: string): string[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(/^\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]!);
}
const NODE_BUILTINS = /^(node:|fs$|path$|zlib$|module$|url$|crypto$|os$|child_process$)/;
// Bare Node-only globals that ReferenceError in the browser (no import to catch).
// Negative lookbehind excludes matches at the start of a string literal (e.g. the
// `"process.started"` / `"process.exited"` event-type names from
// @erdou/runtime-contract) — those are string values, not a bare identifier
// reference to the Node `process` global.
const BARE_GLOBALS = /(?<!["'])\b(Buffer|process|__dirname|__filename|global)\b/;

// Walk the default-entry import graph transitively so a bare global two hops
// down (e.g. Buffer in workspace-snapshot.ts) is still caught.
function localGraph(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const imp of topLevelImports(f)) {
      if (!imp.startsWith("./")) continue;
      stack.push(join(dirname(f), imp.replace(/\.js$/, ".ts")));
    }
  }
  return [...seen];
}

describe("runtime-vm default entry is browser-clean", () => {
  it("index.ts does not (transitively, one hop) re-export a node:* module", () => {
    const idxImports = topLevelImports(join(here, "index.ts"));
    // index.ts should not import assets.ts (the node:fs module)
    expect(idxImports.some((i) => /\.\/assets(\.js)?$/.test(i))).toBe(false);
    // and its direct local imports must themselves be node-free at the top level
    for (const imp of idxImports) {
      if (!imp.startsWith("./")) continue;
      const f = join(here, imp.replace(/\.js$/, ".ts"));
      const nested = topLevelImports(f).filter((n) => NODE_BUILTINS.test(n));
      expect(nested, `${imp} pulls node builtins: ${nested}`).toEqual([]);
    }
  });

  it("no module reachable from the default entry uses a bare Node global (Buffer/process/…)", () => {
    // node.ts is the Node-only subpath — exclude it; everything else in the
    // default-entry graph must be browser-safe.
    for (const f of localGraph(join(here, "index.ts"))) {
      if (/\/node\.ts$/.test(f)) continue;
      const src = readFileSync(f, "utf8");
      const m = BARE_GLOBALS.exec(src);
      expect(m, `${f} uses bare Node global: ${m?.[0]}`).toBeNull();
    }
  });
});
