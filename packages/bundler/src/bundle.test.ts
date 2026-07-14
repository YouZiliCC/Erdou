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

  it("reports an error for a missing local import", async () => {
    const fs = new Vfs({ clock: () => 0 });
    fs.writeFile("/main.ts", 'import "./nope";');
    const out = await bundle({ esbuild: es, fs, entry: "/main.ts" });
    expect(out.errors.length).toBeGreaterThan(0);
  });
});
