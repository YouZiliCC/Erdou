import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inject, renderMd } from "../../scripts/render-help.mjs";

const HELP_MD = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "help.md"), "utf8");

const PROFILES = {
  base: { version: "alpine-3.24.1-r13-base", packages: ["python3", "py3-pip"], label: "Python 3", interpreters: ["python3"], packageManagers: ["apk", "pip"] },
  node: { version: "alpine-3.24.1-r13-node", packages: ["python3", "py3-pip", "nodejs", "npm"], label: "Python 3 + Node.js", interpreters: ["python3", "node"], packageManagers: ["apk", "npm", "pip"] },
};

describe("renderMd", () => {
  it("renders the supported subset (headings, paragraphs, lists, fences, inline)", () => {
    const html = renderMd(
      [
        "# Er**dou** Help",
        "",
        "First line",
        "same paragraph.",
        "",
        "## Lists",
        "",
        "- item with `code`",
        "- [link](https://example.com)",
        "",
        "1. one",
        "2. two",
        "",
        "```sh",
        'echo "<hi>"',
        "```",
      ].join("\n"),
    );
    expect(html).toContain("<h1>Er<strong>dou</strong> Help</h1>");
    expect(html).toContain("<p>First line same paragraph.</p>");
    expect(html).toContain("<h2>Lists</h2>");
    expect(html).toContain("<li>item with <code>code</code></li>");
    expect(html).toContain('<li><a href="https://example.com">link</a></li>');
    expect(html).toContain("<ol><li>one</li><li>two</li></ol>");
    // fence content is escaped and keeps the lang class
    expect(html).toContain('<pre><code class="lang-sh">echo &quot;&lt;hi&gt;&quot;</code></pre>');
  });

  it("escapes HTML in paragraphs", () => {
    expect(renderMd("a <b> & c")).toBe("<p>a &lt;b&gt; &amp; c</p>");
  });

  it.each([
    ["table row", "| a | b |"],
    ["blockquote", "> quoted"],
    ["h4", "#### deep"],
    ["indented code", "    indented"],
    ["thematic break", "---"],
  ])("fails fast with a line number on unsupported construct: %s", (_name, bad) => {
    expect(() => renderMd(`# ok\n\n${bad}\n`)).toThrow(/help\.md line 3/);
  });

  it("fails fast on an unclosed code fence", () => {
    expect(() => renderMd("```sh\necho hi\n")).toThrow(/unclosed code fence/);
  });
});

describe("inject", () => {
  it("replaces the {{environments}} placeholder with browser + per-profile lines", () => {
    const md = inject("## Environments\n\n{{environments}}\n", PROFILES);
    expect(md).not.toContain("{{environments}}");
    expect(md).toContain("**Browser kernel**");
    expect(md).toContain("**Linux VM · Python 3**");
    expect(md).toContain("**Linux VM · Python 3 + Node.js**");
    expect(md).toContain("python3, node"); // interpreters from the JSON
    expect(md).toContain("alpine-3.24.1-r13-node"); // image version from the JSON
    // the generated lines must survive the strict renderer
    expect(() => renderMd(md)).not.toThrow();
  });

  it("fails fast when the placeholder is missing", () => {
    expect(() => inject("# no placeholder\n", PROFILES)).toThrow(/\{\{environments\}\}/);
  });
});

// The browser row is hardcoded here (profiles.data.json only covers the VM), so
// it can drift from what pip actually does — python.ts resolves the LOCAL WHEEL
// INDEX first, then loadPackage, and only then micropip. A "pure-Python wheels
// only" help page sends NumPy/Pandas users into an 84 MB VM download they never
// needed; dropping the bundled index hides that the document libraries install
// from our own origin (the offline path the wheels e2e covers).
describe("browser-kernel pip facts (help page vs. lang-python's pip)", () => {
  const browserRow = (): string => {
    const row = inject("{{environments}}\n", PROFILES)
      .split("\n")
      .find((l) => l.includes("Browser kernel"));
    if (row === undefined) throw new Error("inject() produced no Browser kernel row");
    return row;
  };

  it("injects a browser row describing Pyodide's prebuilt wheels plus the micropip fallback", () => {
    const row = browserRow();
    expect(row).toMatch(/Pyodide.*wheels/);
    expect(row).toMatch(/NumPy/);
    expect(row).toMatch(/micropip/);
    expect(row).not.toMatch(/pure-Python wheels only/);
  });

  it("injects all three install paths in resolution order (bundled wheels → loadPackage → micropip)", () => {
    const row = browserRow();
    expect(row).toMatch(/python-pptx/);
    const bundled = row.search(/bundled|same-origin|our own origin|Erdou's own origin/);
    const prebuilt = row.indexOf("loadPackage");
    const micropip = row.indexOf("micropip");
    expect(bundled).toBeGreaterThanOrEqual(0);
    expect(prebuilt).toBeGreaterThan(bundled);
    expect(micropip).toBeGreaterThan(prebuilt);
    // environments.ts's recipe qualifies the offline claim; the row must not drop it
    expect(row).toMatch(/openpyxl/);
    expect(row).toMatch(/lxml/);
  });

  it("keeps help.md's install bullet on all three paths, not just two", () => {
    const bullet = HELP_MD.split("\n").find((l) => l.startsWith("- **Browser kernel**: `pip install"));
    expect(bullet).toBeDefined();
    expect(bullet).toMatch(/python-pptx|python-docx|openpyxl|fpdf2/);
    expect(bullet).toMatch(/micropip/);
    // the two-path phrasing round 1 introduced, which omits the local wheel index
    expect(bullet).not.toMatch(/^- \*\*Browser kernel\*\*: `pip install <package>` first loads Pyodide/);
  });

  it("keeps help.md off the micropip-only claim and off 'switch for NumPy/Pandas'", () => {
    expect(HELP_MD).not.toMatch(/pure-Python wheels from PyPI only/);
    expect(HELP_MD).not.toMatch(/NumPy\/Pandas: use the \*\*sci\*\* profile/);
    // The pre-round-1 page sent EVERY native-code package to the VM ("a real
    // shell, `npm`, or packages with native code") — the exact advice that
    // buries NumPy/Pandas users in an 84 MB image. Only Pyodide's gaps qualify.
    expect(HELP_MD).not.toMatch(/or packages with native code/);
    expect(HELP_MD).toMatch(/native package Pyodide doesn't provide/);
    expect(HELP_MD).toMatch(/NumPy\/Pandas.*run natively|natively.*NumPy\/Pandas/);
  });
});
