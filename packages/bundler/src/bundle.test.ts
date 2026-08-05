import { describe, it, expect, beforeAll } from "vitest";
import * as esbuild from "esbuild-wasm";
import { Vfs } from "@erdou/runtime-browser";
import { bundle, findEntry, previewHtml, type EsbuildApi } from "./index.js";

const es = esbuild as unknown as EsbuildApi;

// Stub CDN so the test is hermetic; real npm fetching is verified in the browser.
const stubFetch = (async (url: RequestInfo | URL) => {
  const u = String(url);
  let body = "export default {};";
  if (u.includes("react-dom/client")) body = "export function createRoot(){ return { render(){} }; }";
  else if (u.includes("jsx-runtime")) body = "export function jsx(){}; export function jsxs(){}; export const Fragment = 0;";
  else if (u.includes("react")) body = "export function useState(){ return [0, () => {}]; } export default {};";
  return new Response(body, { status: 200, headers: { "content-type": "application/javascript" } });
}) as typeof fetch;

beforeAll(async () => {

  await esbuild.initialize({ worker: false });
}, 30000);

describe("bundle", () => {
  it("bundles a React TSX project — VFS for local, esm.sh for bare imports", async () => {
    const fs = new Vfs({ clock: () => 0 });
    fs.mkdir("/src", { recursive: true });
    fs.writeFile("/src/App.tsx", "export function App() { return <h1>Hello {1 + 1}</h1>; }");
    fs.writeFile(
      "/src/main.tsx",
      'import { createRoot } from "react-dom/client";\nimport { App } from "./App";\ncreateRoot(document.getElementById("root")!).render(<App />);',
    );
    const out = await bundle({ esbuild: es, fs, entry: "/src/main.tsx", fetch: stubFetch });
    expect(out.errors).toEqual([]);
    expect(out.js).toContain("Hello"); // local code compiled + bundled
    expect(out.js).toContain("createRoot"); // npm dep fetched + bundled in (self-contained)
    expect(out.js).not.toMatch(/from\s*["']https:\/\/esm\.sh/); // no runtime CDN import left
    expect(out.js.length).toBeGreaterThan(100);
  });

  it("finds a conventional entry and builds preview html", () => {
    const fs = new Vfs({ clock: () => 0 });
    fs.mkdir("/src", { recursive: true });
    fs.writeFile("/src/main.tsx", "console.log(1)");
    expect(findEntry(fs)).toBe("/src/main.tsx");
    const html = previewHtml("const x=1;", "body{color:red}");
    expect(html).toContain('<div id="root">');
    expect(html).toContain("const x=1;");
  });

  it("escapes </style in the inlined CSS so the stylesheet cannot break out of its element", () => {
    const html = previewHtml("const x=1;", '.hint::after{content:"</style>"}');
    // Rawtext parsing ends the style element at the first literal `</style` —
    // only the real closing tag may contain that sequence.
    expect(html.match(/<\/style/gi)).toHaveLength(1);
    expect(html).toContain('content:"<\\/style>"');
    expect(html.indexOf("body{margin:0")).toBeLessThan(html.indexOf("</style>"));
  });

  it("finds the index.html module script regardless of attribute order", () => {
    const fs = new Vfs({ clock: () => 0 });
    fs.mkdir("/src", { recursive: true });
    fs.writeFile("/index.html", '<html><body><script src="/src/game.js" type="module"></script></body></html>');
    fs.writeFile("/src/game.js", "console.log(1)");
    expect(findEntry(fs)).toBe("/src/game.js");
  });

  it("recognizes /src/index.ts and /src/index.js as conventional entries", () => {
    const tsFs = new Vfs({ clock: () => 0 });
    tsFs.mkdir("/src", { recursive: true });
    tsFs.writeFile("/src/index.ts", "console.log(1)");
    expect(findEntry(tsFs)).toBe("/src/index.ts");

    const jsFs = new Vfs({ clock: () => 0 });
    jsFs.mkdir("/src", { recursive: true });
    jsFs.writeFile("/src/index.js", "console.log(1)");
    expect(findEntry(jsFs)).toBe("/src/index.js");
  });

  it("resolves a directory import through its index barrel, including the barrel's own relative imports", async () => {
    const fs = new Vfs({ clock: () => 0 });
    fs.mkdir("/src/components", { recursive: true });
    fs.writeFile("/src/components/Button.ts", "export const Button = 'btn';");
    fs.writeFile("/src/components/index.ts", 'export { Button } from "./Button";');
    fs.writeFile("/src/main.ts", 'import { Button } from "./components";\nconsole.log(Button);');
    // stubFetch, though nothing here is a bare specifier: that is the point. If a
    // regression routed a local specifier into the CDN branch the test must fail on
    // resolution, not make a live request to esm.sh (flaky in CI, cryptic offline).
    const out = await bundle({ esbuild: es, fs, entry: "/src/main.ts", fetch: stubFetch });
    expect(out.errors).toEqual([]);
    expect(out.js).toContain("btn");
  });

  it("resolves a barrel that re-exports another directory's barrel", async () => {
    const fs = new Vfs({ clock: () => 0 });
    fs.mkdir("/src/components/ui", { recursive: true });
    fs.writeFile("/src/components/ui/Button.ts", "export const Button = 'nested-btn';");
    fs.writeFile("/src/components/ui/index.ts", 'export { Button } from "./Button";');
    fs.writeFile("/src/components/index.ts", 'export { Button } from "./ui";');
    fs.writeFile("/src/main.ts", 'import { Button } from "./components";\nconsole.log(Button);');
    const out = await bundle({ esbuild: es, fs, entry: "/src/main.ts", fetch: stubFetch });
    expect(out.errors).toEqual([]);
    expect(out.js).toContain("nested-btn");
  });

  it("resolves a barrel's '../' import out of its own directory", async () => {
    const fs = new Vfs({ clock: () => 0 });
    fs.mkdir("/src/components", { recursive: true });
    fs.writeFile("/src/shared.ts", "export const S = 'shared-val';");
    fs.writeFile("/src/components/index.ts", 'export { S } from "../shared";');
    fs.writeFile("/src/main.ts", 'import { S } from "./components";\nconsole.log(S);');
    const out = await bundle({ esbuild: es, fs, entry: "/src/main.ts", fetch: stubFetch });
    // Used to fail "cannot resolve module '/shared'": the barrel's importer was the
    // pre-resolution "/src/components", so ".." climbed one directory too far.
    expect(out.errors).toEqual([]);
    expect(out.js).toContain("shared-val");
  });

  it("gives a module one identity whether or not the import spells its extension", async () => {
    const fs = new Vfs({ clock: () => 0 });
    fs.mkdir("/src", { recursive: true });
    fs.writeFile("/src/App.tsx", "export const APP = 'app-body-marker';");
    fs.writeFile(
      "/src/main.ts",
      'import { APP } from "./App";\nimport { APP as APP2 } from "./App.tsx";\nconsole.log(APP, APP2);',
    );
    const out = await bundle({ esbuild: es, fs, entry: "/src/main.ts", fetch: stubFetch });
    expect(out.errors).toEqual([]);
    // Exactly one copy. When "./App" and "./App.tsx" resolved to two identities the
    // module was bundled twice, silently duplicating module-level state and React
    // contexts — the app still "worked", just with two of everything.
    expect(out.js.split("app-body-marker").length - 1).toBe(1);
  });

  it("extracts CSS imported from a JS/TS module into out.css", async () => {
    const fs = new Vfs({ clock: () => 0 });
    fs.mkdir("/src", { recursive: true });
    fs.writeFile("/src/app.css", ".card { color: rebeccapurple; }");
    fs.writeFile("/src/main.ts", 'import "./app.css";\nconsole.log("styled");');
    const out = await bundle({ esbuild: es, fs, entry: "/src/main.ts", fetch: stubFetch });
    expect(out.errors).toEqual([]);
    expect(out.css).toContain("rebeccapurple");
    expect(out.js).toContain("styled");
    // The stylesheet must not be inlined back into the JS — /dist/app.css is what the shell links.
    expect(out.js).not.toContain("rebeccapurple");
  });

  it("reports an error for a missing local import", async () => {
    const fs = new Vfs({ clock: () => 0 });
    fs.writeFile("/main.ts", 'import "./nope";');
    const out = await bundle({ esbuild: es, fs, entry: "/main.ts", fetch: stubFetch });
    expect(out.errors.length).toBeGreaterThan(0);
    // The unresolved specifier must still reach onLoad by name, not be silently dropped.
    expect(out.errors.join("\n")).toContain("cannot resolve module '/nope'");
  });
});
