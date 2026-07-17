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
const BARE_GLOBALS = /\b(Buffer|process|__dirname|__filename|global)\b/;

// Strip comments and string/template literals so the bare-global scan sees only
// executable code — the word "process" in prose or the "process.started" event
// literals are not references to the Node `process` global. Order matters:
// comments first (so an apostrophe inside a comment can't start a bogus string).
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")        // block comments
    .replace(/\/\/[^\n]*/g, " ")               // line comments
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')     // double-quoted strings
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")     // single-quoted strings
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");      // template literals
}

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

describe("profiles subpath is browser-clean (apps/web main bundle imports it — no v86)", () => {
  it("profiles.ts imports ONLY the data JSON", () => {
    expect(topLevelImports(join(here, "profiles.ts"))).toEqual(["./profiles.data.json"]);
  });

  it("its transitive local graph pulls no v86, no v86-host.ts, no node builtins", () => {
    const graph = localGraph(join(here, "profiles.ts"));
    expect(graph.filter((f) => /v86-host\.ts$/.test(f))).toEqual([]);
    for (const f of graph) {
      const bad = topLevelImports(f).filter((i) => i === "v86" || i.startsWith("v86/") || NODE_BUILTINS.test(i));
      expect(bad, `${f} pulls forbidden imports: ${bad}`).toEqual([]);
    }
  });
});

describe("runtime-vm default entry is browser-clean", () => {
  it("index.ts does not (transitively, at any depth) re-export a node:* module", () => {
    const idxImports = topLevelImports(join(here, "index.ts"));
    // index.ts should not import assets.ts (the node:fs module)
    expect(idxImports.some((i) => /\.\/assets(\.js)?$/.test(i))).toBe(false);
    // and EVERY module reachable from the default entry — not just index.ts's
    // direct imports — must be node-free at the top level. A depth-≥2 import
    // (e.g. a node:fs import reintroduced in http-codec.ts or
    // workspace-snapshot.ts) would otherwise go undetected.
    for (const f of localGraph(join(here, "index.ts"))) {
      const nested = topLevelImports(f).filter((n) => NODE_BUILTINS.test(n));
      expect(nested, `${f} pulls node builtins: ${nested}`).toEqual([]);
    }
  });

  it("no module reachable from the default entry uses a bare Node global (Buffer/process/…)", () => {
    // node.ts is the Node-only subpath — exclude it; everything else in the
    // default-entry graph must be browser-safe.
    for (const f of localGraph(join(here, "index.ts"))) {
      if (/\/node\.ts$/.test(f)) continue;
      const src = readFileSync(f, "utf8");
      const m = BARE_GLOBALS.exec(codeOnly(src));
      expect(m, `${f} uses bare Node global: ${m?.[0]}`).toBeNull();
    }
  });
});
