import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseMarkdown, parseInline, safeHref } from "./markdown.js";
import { Markdown } from "../components/Markdown.js";

const html = (text: string): string => renderToStaticMarkup(createElement(Markdown, { text }));

describe("parseInline", () => {
  it("bold, italic and inline code", () => {
    expect(parseInline("a **b** c")).toEqual([
      { t: "text", v: "a " },
      { t: "strong", c: [{ t: "text", v: "b" }] },
      { t: "text", v: " c" },
    ]);
    expect(parseInline("_i_")).toEqual([{ t: "em", c: [{ t: "text", v: "i" }] }]);
    expect(parseInline("run `x = 1`")).toEqual([
      { t: "text", v: "run " },
      { t: "code", v: "x = 1" },
    ]);
  });

  it("a backtick run is closed only by a run of the SAME length (CommonMark)", () => {
    // The single-backtick scan used to close at the run's first char, turning
    // ``x`` into two EMPTY code pills around unstyled text.
    expect(parseInline("``x``")).toEqual([{ t: "code", v: "x" }]);
    expect(parseInline("``a`b``")).toEqual([{ t: "code", v: "a`b" }]);
    // One space is stripped from each end (CommonMark's escape for a span with
    // edge backticks) — but only when both ends are spaces and the span isn't
    // all spaces.
    expect(parseInline("`` `code` ``")).toEqual([{ t: "code", v: "`code`" }]);
    expect(parseInline("` `")).toEqual([{ t: "code", v: " " }]);
    // An unclosed run stays literal.
    expect(parseInline("``oops")).toEqual([{ t: "text", v: "``oops" }]);
  });

  it("links carry a scheme-checked href; nesting works", () => {
    expect(parseInline("[**go**](https://x.com)")).toEqual([
      { t: "link", href: "https://x.com", c: [{ t: "strong", c: [{ t: "text", v: "go" }] }] },
    ]);
  });

  it("a soft newline becomes a break", () => {
    expect(parseInline("a\nb")).toEqual([{ t: "text", v: "a" }, { t: "br" }, { t: "text", v: "b" }]);
  });

  it("***bold-italic*** nests em around strong (CommonMark); no closing triple degrades to literal", () => {
    // The `**` branch used to find the closing run's FIRST two stars, so the
    // third opening star was swallowed into the strong content and the last
    // closing star leaked out as text: "<strong>*bold</strong>*".
    expect(parseInline("***bold***")).toEqual([{ t: "em", c: [{ t: "strong", c: [{ t: "text", v: "bold" }] }] }]);
    expect(parseInline("___x___")).toEqual([{ t: "em", c: [{ t: "strong", c: [{ t: "text", v: "x" }] }] }]);
    expect(parseInline("a ***b*** c")).toEqual([
      { t: "text", v: "a " },
      { t: "em", c: [{ t: "strong", c: [{ t: "text", v: "b" }] }] },
      { t: "text", v: " c" },
    ]);
    // Unmatched runs degrade to literal text — never a half-bold mangle.
    expect(parseInline("***oops**")).toEqual([{ t: "text", v: "***oops**" }]);
    expect(parseInline("******")).toEqual([{ t: "text", v: "******" }]);
  });

  it("unmatched delimiters and 'a * b' fall through to literal text (no false emphasis)", () => {
    expect(parseInline("2 * 3 * 4")).toEqual([{ t: "text", v: "2 * 3 * 4" }]);
    expect(parseInline("**oops")).toEqual([{ t: "text", v: "**oops" }]);
  });

  it("intraword `_` is literal — identifiers keep their underscores (CommonMark)", () => {
    // The parser used to EAT these underscores: "run some<em>var</em>name here".
    expect(parseInline("run some_var_name here")).toEqual([{ t: "text", v: "run some_var_name here" }]);
    expect(parseInline("st.session_state")).toEqual([{ t: "text", v: "st.session_state" }]);
    expect(parseInline("use __init__ and snake_case_id")).toEqual([
      { t: "text", v: "use " },
      { t: "strong", c: [{ t: "text", v: "init" }] },
      { t: "text", v: " and snake_case_id" },
    ]);
    // A word-boundary `_` still emphasizes, before and after a rejected one.
    expect(parseInline("snake_case _real_")).toEqual([
      { t: "text", v: "snake_case " },
      { t: "em", c: [{ t: "text", v: "real" }] },
    ]);
    // `*` is exempt: intraword `*` emphasis is legal and must keep working.
    expect(parseInline("a*b*c")).toEqual([
      { t: "text", v: "a" },
      { t: "em", c: [{ t: "text", v: "b" }] },
      { t: "text", v: "c" },
    ]);
    expect(parseInline("a**b**c")).toEqual([
      { t: "text", v: "a" },
      { t: "strong", c: [{ t: "text", v: "b" }] },
      { t: "text", v: "c" },
    ]);
  });
});

describe("safeHref", () => {
  it("allows http/https/mailto and relative, rejects dangerous schemes", () => {
    expect(safeHref("https://a.com")).toBe("https://a.com");
    expect(safeHref("/local/path")).toBe("/local/path");
    expect(safeHref("mailto:x@y.com")).toBe("mailto:x@y.com");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
  });

  it("a C0 control before the scheme does not smuggle javascript: past the check", () => {
    // String.trim strips whitespace only, so these fell through as LIVE
    // javascript: URLs — browsers strip leading C0 controls before parsing.
    expect(safeHref("\u0001javascript:alert(1)")).toBeNull();
    expect(safeHref("\u001Fjavascript:alert(1)")).toBeNull();
    expect(safeHref("\u000Bjavascript:alert(1)")).toBeNull();
    expect(safeHref("\u0000javascript:alert(1)")).toBeNull();
    // Tabs/newlines inside the scheme are stripped by the URL parser too.
    expect(safeHref("java\nscript:alert(1)")).toBeNull();
    expect(safeHref("\u0001vbscript:msgbox(1)")).toBeNull();
    // Relative targets still pass through untouched.
    expect(safeHref("#anchor")).toBe("#anchor");
    expect(safeHref("docs/readme.md")).toBe("docs/readme.md");
  });
});

describe("parseMarkdown blocks", () => {
  it("headings, paragraphs, hr", () => {
    const b = parseMarkdown("# Title\n\nhello\n\n---");
    expect(b[0]).toEqual({ t: "h", level: 1, c: [{ t: "text", v: "Title" }] });
    expect(b[1]!.t).toBe("p");
    expect(b[2]).toEqual({ t: "hr" });
  });

  it("fenced code is literal (no inline parsing), lang captured", () => {
    const b = parseMarkdown("```py\nx = **1**\n```");
    expect(b).toEqual([{ t: "code", lang: "py", v: "x = **1**" }]);
  });

  it("unordered and ordered lists", () => {
    const ul = parseMarkdown("- one\n- two");
    expect(ul[0]!.t).toBe("ul");
    expect((ul[0] as { items: unknown[] }).items).toHaveLength(2);
    const ol = parseMarkdown("1. a\n2. b");
    expect(ol[0]!.t).toBe("ol");
  });

  it("blockquote", () => {
    expect(parseMarkdown("> quoted")[0]).toEqual({ t: "quote", c: [{ t: "text", v: "quoted" }] });
  });
});

describe("GFM tables", () => {
  const t = (v: string) => [{ t: "text", v }];

  it("parses header, alignment and body rows", () => {
    expect(parseMarkdown("| a | b | c |\n| :- | :-: | -: |\n| 1 | 2 | 3 |")).toEqual([
      {
        t: "table",
        align: ["left", "center", "right"],
        head: [t("a"), t("b"), t("c")],
        rows: [[t("1"), t("2"), t("3")]],
      },
    ]);
  });

  it("outer pipes are optional; a bare delimiter gives no alignment", () => {
    expect(parseMarkdown("a | b\n--- | ---\n1 | 2")).toEqual([
      { t: "table", align: [null, null], head: [t("a"), t("b")], rows: [[t("1"), t("2")]] },
    ]);
  });

  it("short rows pad and long rows truncate to the header width", () => {
    const b = parseMarkdown("| a | b |\n| - | - |\n| 1 |\n| 1 | 2 | 3 |");
    expect(b).toEqual([
      {
        t: "table",
        align: [null, null],
        head: [t("a"), t("b")],
        rows: [
          [t("1"), []],
          [t("1"), t("2")],
        ],
      },
    ]);
  });

  it("cells parse inline markdown and \\| is a literal pipe", () => {
    const b = parseMarkdown("| **x** | `a\\|b` |\n| - | - |");
    expect(b).toEqual([
      {
        t: "table",
        align: [null, null],
        head: [[{ t: "strong", c: t("x") }], [{ t: "code", v: "a|b" }]],
        rows: [],
      },
    ]);
  });

  it("pipe lines WITHOUT a delimiter row stay a paragraph (no false tables)", () => {
    const b = parseMarkdown("a | b\nc | d");
    expect(b).toHaveLength(1);
    expect(b[0]!.t).toBe("p");
  });

  it("a delimiter row whose cell count mismatches the header is not a table", () => {
    const b = parseMarkdown("| a | b |\n| --- |\n| 1 | 2 |");
    expect(b).toHaveLength(1);
    expect(b[0]!.t).toBe("p");
  });

  it("the table ends at a blank line or a pipeless line", () => {
    const b = parseMarkdown("| a |\n| - |\n| 1 |\n\nafter");
    expect(b[0]!.t).toBe("table");
    expect(b[1]).toEqual({ t: "p", c: t("after") });
    const c = parseMarkdown("| a |\n| - |\nplain text");
    expect(c[0]!.t).toBe("table");
    expect(c[1]).toEqual({ t: "p", c: t("plain text") });
  });

  it("renders thead/tbody with md-table and per-column alignment", () => {
    const out = html("| a | b |\n| :-: | - |\n| 1 | 2 |");
    expect(out).toContain('<table class="md-table">');
    expect(out).toMatch(/<thead><tr><th style="text-align:center">a<\/th><th>b<\/th><\/tr><\/thead>/);
    expect(out).toMatch(/<tbody><tr><td style="text-align:center">1<\/td><td>2<\/td><\/tr><\/tbody>/);
  });
});

describe("Markdown render (React nodes, XSS-safe)", () => {
  it("renders bold/code/list/heading to real elements", () => {
    expect(html("**b**")).toContain("<strong>b</strong>");
    expect(html("`c`")).toContain('<code class="md-code">c</code>');
    expect(html("- a")).toMatch(/<ul class="md-list"><li>a<\/li><\/ul>/);
    expect(html("## H")).toContain("<h2");
    expect(html("```\ncode\n```")).toContain("<pre");
  });

  it("a safe link is an anchor; a javascript: link renders as text, never an href", () => {
    expect(html("[x](https://a.com)")).toContain('href="https://a.com"');
    const dangerous = html("[x](javascript:alert(1))");
    expect(dangerous).not.toContain("href");
    expect(dangerous).toContain("x");
  });

  it("HTML in the source is escaped, not injected (no XSS)", () => {
    const out = html("<img src=x onerror=alert(1)> **still bold**");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
    expect(out).toContain("<strong>still bold</strong>");
  });
});
