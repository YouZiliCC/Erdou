import type { FileSystemApi } from "@erdou/runtime-contract";

const decoder = new TextDecoder();

const ENTRY_CANDIDATES = [
  "/src/main.tsx",
  "/src/main.jsx",
  "/src/main.ts",
  "/src/main.js",
  "/src/index.tsx",
  "/src/index.jsx",
  "/src/index.ts",
  "/src/index.js",
  "/index.tsx",
  "/index.jsx",
  "/main.tsx",
  "/main.jsx",
  "/App.tsx",
  "/app.tsx",
  "/index.ts",
  "/index.js",
];

/** Find a project's entry module: an index.html's module script, or a
 *  conventional entry path. Returns null if none is found. */
export function findEntry(fs: FileSystemApi): string | null {
  if (fs.exists("/index.html") && fs.stat("/index.html").type === "file") {
    const html = decoder.decode(fs.readFile("/index.html"));
    // Attribute order is free in HTML: test type= and src= independently
    // rather than in one ordered pattern.
    for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
      if (!/\btype=["']module["']/i.test(tag)) continue;
      const match = /\bsrc=["']([^"']+)["']/i.exec(tag);
      if (!match) continue;
      const src = match[1]!.replace(/^\.?\//, "/");
      const path = src.startsWith("/") ? src : `/${src}`;
      if (fs.exists(path)) return path;
    }
  }
  for (const candidate of ENTRY_CANDIDATES) {
    if (fs.exists(candidate) && fs.stat(candidate).type === "file") return candidate;
  }
  return null;
}

/** Build the self-contained HTML document to load in a preview iframe. */
export function previewHtml(js: string, css: string): string {
  const safeJs = js.replace(/<\/script/gi, "<\\/script");
  // Same breakout class as </script: rawtext parsing would end the style
  // element at a literal </style even inside a CSS string or comment.
  const safeCss = css.replace(/<\/style/gi, "<\\/style");
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    `<style>${safeCss}\nbody{margin:0;font-family:system-ui,sans-serif}</style>`,
    "</head><body>",
    '<div id="root"></div><div id="app"></div>',
    `<script type="module">${safeJs}</script>`,
    "</body></html>",
  ].join("");
}
