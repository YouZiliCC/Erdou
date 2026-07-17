import { describe, expect, it } from "vitest";
import { inject, renderMd } from "../../scripts/render-help.mjs";

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
