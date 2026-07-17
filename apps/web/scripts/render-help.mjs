// Render docs/help.md -> public/help.html at predev/prebuild (chained after
// link-vm-assets.mjs). Hand-rolled markdown SUBSET: # ## ### headings,
// paragraphs, - lists, 1. lists, ``` fences, inline `code` **bold**
// [link](url). Anything else THROWS with a line number — help.md is
// repo-authored, so unsupported syntax is an author bug, not a fallback case.
// VM environment facts are injected from runtime-vm's profiles.data.json (the
// single source of truth for profile package data); the TS catalog
// (src/lib/environments.ts) derives from the same JSON and is NOT imported
// here (plain .mjs cannot import .ts).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const inline = (s) =>
  esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');

export function renderMd(md) {
  const out = [];
  const lines = md.split("\n");
  let i = 0;
  const fail = (why) => { throw new Error(`help.md line ${i + 1}: ${why}: ${JSON.stringify(lines[i])}`); };
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    if (/^(#{1,3}) (.+)$/.test(line)) {
      const [, h, text] = line.match(/^(#{1,3}) (.+)$/);
      out.push(`<h${h.length}>${inline(text)}</h${h.length}>`); i++; continue;
    }
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      if (i === lines.length) fail("unclosed code fence");
      i++; // closing ```
      out.push(`<pre><code${lang ? ` class="lang-${esc(lang)}"` : ""}>${esc(code.join("\n"))}</code></pre>`);
      continue;
    }
    const li = (re, tag) => {
      const items = [];
      while (i < lines.length && re.test(lines[i])) items.push(`<li>${inline(lines[i++].replace(re, ""))}</li>`);
      out.push(`<${tag}>${items.join("")}</${tag}>`);
    };
    if (/^- /.test(line)) { li(/^- /, "ul"); continue; }
    if (/^\d+\. /.test(line)) { li(/^\d+\. /, "ol"); continue; }
    if (/^(\s+\S|>|\||#{4,}|!\[)/.test(line)) fail("unsupported markdown (subset: #/##/###, -, 1., ```, plain paragraphs)");
    // paragraph: join until blank line
    const para = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^([#`>-]|\d+\. |\|)/.test(lines[i])) para.push(lines[i++]);
    // A line the paragraph collector refuses on entry (e.g. "---", "#nope")
    // would loop forever — it is unsupported syntax, so fail with its number.
    if (para.length === 0) fail("unsupported markdown (subset: #/##/###, -, 1., ```, plain paragraphs)");
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}

/** Replace the {{environments}} placeholder with a bullet list generated from
 *  profiles.data.json (VM rows) plus the fixed browser-kernel row. Throws if
 *  the placeholder is missing — the environments section must never silently
 *  drop out of the help page. */
export function inject(md, profiles) {
  if (!md.includes("{{environments}}")) throw new Error("help.md: missing {{environments}} placeholder");
  const rows = [
    "- **Browser kernel** — instant, in-tab simulated OS. Interpreters: python (Pyodide), wasi. Packages: `pip install` via micropip (pure-Python wheels only).",
    ...Object.entries(profiles).map(
      ([id, p]) =>
        // "Linux VM · <label>" matches the selector labels (src/lib/environments.ts).
        `- **Linux VM · ${p.label}** — real Alpine Linux (profile \`${id}\`, image \`${p.version}\`). Interpreters: ${p.interpreters.join(", ")}. Package managers: ${p.packageManagers.join(", ")}. Preinstalled: ${p.packages.join(", ")}.`,
    ),
  ];
  return md.replace("{{environments}}", rows.join("\n"));
}

// Minimal copy of the app design tokens (src/styles.css :root blocks, dark
// default + light override) + the same localStorage key as src/lib/theme.ts,
// so the help tab opens in the app's current theme. No third-party origins.
const PAGE = (body) => `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<title>Erdou — Help</title>
<style>
:root { --bg:#0d0d0d; --panel:#141414; --elev:#1c1c1c; --border:rgba(255,255,255,.08);
  --ink:#ededed; --muted:#8b8b8b; --accent:#58a6ff;
  --sans:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace; color-scheme:dark; }
:root[data-theme="light"] { --bg:#fff; --panel:#f7f7f8; --elev:#eeeef0; --border:#e5e5e5;
  --ink:#0d0d0d; --muted:#6e6e80; color-scheme:light; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font-family:var(--sans); font-size:14px; line-height:1.65; }
main { max-width:760px; margin:0 auto; padding:40px 24px 80px; }
h1 { font-size:22px; } h2 { font-size:17px; margin-top:2em; border-bottom:1px solid var(--border); padding-bottom:6px; }
h3 { font-size:14px; margin-top:1.6em; }
h1 strong, h1 b { color:var(--accent); }
code { font-family:var(--mono); font-size:12.5px; background:var(--elev); border:1px solid var(--border); border-radius:4px; padding:1px 5px; }
pre { background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:12px 14px; overflow-x:auto; }
pre code { background:none; border:none; padding:0; }
a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
ul,ol { padding-left:1.4em; } li { margin:4px 0; }
</style>
<script>
try { document.documentElement.setAttribute("data-theme", localStorage.getItem("erdou.theme") || "dark"); } catch {}
</script>
</head>
<body><main>
${body}
</main></body>
</html>
`;

// CLI (predev/prebuild hook): read help.md + profiles.data.json, write help.html.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const here = dirname(fileURLToPath(import.meta.url));
  const mdPath = join(here, "..", "docs", "help.md");
  const profilesPath = join(here, "..", "..", "..", "packages", "runtime-vm", "src", "profiles.data.json");
  const outPath = join(here, "..", "public", "help.html");
  const profiles = JSON.parse(readFileSync(profilesPath, "utf8"));
  writeFileSync(outPath, PAGE(renderMd(inject(readFileSync(mdPath, "utf8"), profiles))));
  console.log(`[render-help] rendered docs/help.md -> public/help.html`);
}
