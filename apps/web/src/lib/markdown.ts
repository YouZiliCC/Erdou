/**
 * A tiny, dependency-free Markdown parser for agent chat output — matches
 * Erdou's hand-rolled, no-deps stance (see scripts/render-help.mjs). Produces a
 * small AST that `components/Markdown.tsx` renders to REACT NODES (never an HTML
 * string / dangerouslySetInnerHTML), so model output can't inject markup — text
 * is escaped by React and link hrefs are scheme-checked (`safeHref`).
 *
 * Covered (what Claude actually emits): paragraphs with soft line breaks, ATX
 * headings, fenced code blocks, inline code, bold, italic, links, unordered and
 * ordered lists, blockquotes, horizontal rules, and GFM pipe tables. Anything
 * ambiguous degrades to plain text rather than mis-rendering.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "br" }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "link"; href: string | null; c: Inline[] };

export type TableAlign = "left" | "center" | "right" | null;

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: number; c: Inline[] }
  | { t: "code"; lang: string; v: string }
  | { t: "ul"; items: Inline[][] }
  | { t: "ol"; items: Inline[][] }
  | { t: "quote"; c: Inline[] }
  | { t: "table"; align: TableAlign[]; head: Inline[][]; rows: Inline[][][] }
  | { t: "hr" };

const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE = /^```(\w*)\s*$/;
const FENCE_CLOSE = /^```\s*$/;
const QUOTE = /^>\s?/;
const UL = /^\s*[-*+]\s+/;
const OL = /^\s*\d+[.)]\s+/;

/** True if a line opens a NON-paragraph block, so a paragraph run stops at it.
 *  A table header is deliberately NOT one: GFM tables cannot interrupt a
 *  paragraph, so a pipe row is only checked at a fresh block start. */
function isBlockStart(line: string): boolean {
  return (
    FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || UL.test(line) || OL.test(line)
  );
}

/** One GFM delimiter cell: at least one dash, optional alignment colons. */
const DELIM_CELL = /^:?-+:?$/;

/** Split one table row into trimmed cell texts. One leading and one trailing
 *  `|` are decoration, not delimiters; `\|` is a literal pipe inside a cell
 *  (GFM's ONLY way to put one there — a `|` splits even inside backticks). */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && s[i + 1] === "|") {
      buf += "|";
      i++;
    } else if (c === "|") {
      cells.push(buf.trim());
      buf = "";
    } else {
      buf += c;
    }
  }
  cells.push(buf.trim());
  return cells;
}

/** Parse a delimiter row (`| :-- | :-: | --: |`) into per-column alignment, or
 *  null if the line is not one. Requiring a literal `|` keeps `---` an HR and
 *  a setext-style underline out of table detection. */
function parseDelimiterRow(line: string): TableAlign[] | null {
  if (!line.includes("|")) return null;
  const cells = splitRow(line);
  const align: TableAlign[] = [];
  for (const cell of cells) {
    if (!DELIM_CELL.test(cell)) return null;
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    align.push(left && right ? "center" : left ? "left" : right ? "right" : null);
  }
  return align;
}

/** A link href we're willing to emit as an `<a>`: http(s)/mailto or a
 *  schemeless (relative) target. Any other scheme — javascript:, data:,
 *  vbscript: … — returns null and the link renders as plain text. */
export function safeHref(href: string): string | null {
  const h = href.trim();
  // Allowlist by PARSING, not by pattern-matching the scheme: `String.trim`
  // strips whitespace only, so a leading C0 control ("javascript:…") made
  // the old scheme regex fail to match at position 0 and the value fell through
  // as a live javascript: URL — browsers strip those controls (and interior
  // tabs/newlines) before parsing, so the link fired. Resolving against a base
  // keeps schemeless/relative targets working: they inherit the base's https:.
  let protocol: string;
  try {
    protocol = new URL(h, "https://erdou.invalid/").protocol;
  } catch {
    return null; // unparseable even with a base — nothing we are willing to emit
  }
  if (protocol !== "http:" && protocol !== "https:" && protocol !== "mailto:") return null;
  return h;
}

/** CommonMark's intraword rule for `_`: a `_` delimiter flanked on its outer
 *  side by a word character neither opens nor closes emphasis. Without it the
 *  parser CONSUMED the underscores of every identifier an agent mentioned
 *  outside a code span — "some_var_name" rendered as some<em>var</em>name, i.e.
 *  a different identifier than the model wrote. `*` is exempt: intraword `*`
 *  emphasis is legal (a*b*c). */
const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

/** Parse inline spans within a block's text. Recursive for nesting (e.g. bold
 *  inside a link). Unmatched delimiters fall through to literal text. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf) out.push({ t: "text", v: buf });
    buf = "";
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const rest = text.slice(i);

    if (c === "\n") {
      flush();
      out.push({ t: "br" });
      i++;
      continue;
    }
    // Inline code: `…` — literal, no nested parsing. A run of N backticks is
    // closed only by a run of exactly N (CommonMark), so ``a`b`` is ONE span
    // containing a backtick — a naive single-char scan closed at the run's
    // first char and emitted empty spans. One space is stripped from each end
    // when both ends are spaces and the span isn't all spaces (CommonMark's
    // escape for a span with edge backticks). An unclosed run stays literal,
    // consumed whole so its chars can't half-match a shorter closer.
    if (c === "`") {
      let run = 1;
      while (text[i + run] === "`") run++;
      const delim = "`".repeat(run);
      let end = -1;
      for (let j = i + run; j < text.length; ) {
        const at = text.indexOf(delim, j);
        if (at === -1) break;
        let len = run;
        while (text[at + len] === "`") len++;
        if (len === run) {
          end = at;
          break;
        }
        j = at + len;
      }
      if (end !== -1) {
        flush();
        let v = text.slice(i + run, end);
        if (v.length >= 2 && v.startsWith(" ") && v.endsWith(" ") && v.trim() !== "") v = v.slice(1, -1);
        out.push({ t: "code", v });
        i = end + run;
        continue;
      }
      buf += delim;
      i += run;
      continue;
    }
    // Link: [text](href)
    if (c === "[") {
      const m = /^\[([^\]]*)\]\(([^)\s]*)\)/.exec(rest);
      if (m) {
        flush();
        out.push({ t: "link", href: safeHref(m[2]!), c: parseInline(m[1]!) });
        i += m[0].length;
        continue;
      }
    }
    // Bold-italic: ***…*** or ___…___ — em wrapping strong, CommonMark's
    // nesting. Without this branch the `**` matcher below closed at the FIRST
    // two chars of the closing run, swallowing the third opener into the
    // strong content ("<strong>*bold</strong>*"). A run with no matching
    // closer is consumed as literal here for the same reason — falling
    // through would let `**` half-match it.
    if (
      (c === "*" || c === "_") &&
      text[i + 1] === c &&
      text[i + 2] === c &&
      text[i + 3] !== undefined &&
      !/\s/.test(text[i + 3]!) &&
      (c === "*" || !isWordChar(text[i - 1]))
    ) {
      const end = text.indexOf(c + c + c, i + 3);
      if (end > i + 3 && !/\s/.test(text[end - 1]!) && (c === "*" || !isWordChar(text[end + 3]))) {
        flush();
        out.push({ t: "em", c: [{ t: "strong", c: parseInline(text.slice(i + 3, end)) }] });
        i = end + 3;
        continue;
      }
      buf += c + c + c;
      i += 3;
      continue;
    }
    // Bold: **…** or __…__ (opening delimiter must not be followed by space).
    if ((c === "*" || c === "_") && text[i + 1] === c && text[i + 2] !== undefined && !/\s/.test(text[i + 2]!)) {
      const delim = c + c;
      const end = text.indexOf(delim, i + 2);
      if (end > i + 1 && (c === "*" || (!isWordChar(text[i - 1]) && !isWordChar(text[end + 2])))) {
        flush();
        out.push({ t: "strong", c: parseInline(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    // Italic: *…* or _…_ (no space just inside the delimiters).
    if ((c === "*" || c === "_") && text[i + 1] !== undefined && !/\s/.test(text[i + 1]!) && text[i + 1] !== c) {
      const end = text.indexOf(c, i + 1);
      if (
        end > i + 1 &&
        !/\s/.test(text[end - 1]!) &&
        (c === "*" || (!isWordChar(text[i - 1]) && !isWordChar(text[end + 1])))
      ) {
        flush();
        out.push({ t: "em", c: parseInline(text.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

/** Parse Markdown source into a flat list of blocks. */
export function parseMarkdown(md: string): Block[] {
  const blocks: Block[] = [];
  const lines = md.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE_CLOSE.test(lines[i]!)) {
        body.push(lines[i]!);
        i++;
      }
      i++; // consume the closing fence (or run off the end if unterminated)
      blocks.push({ t: "code", lang: fence[1] ?? "", v: body.join("\n") });
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      blocks.push({ t: "h", level: h[1]!.length, c: parseInline(h[2]!.trim()) });
      i++;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ t: "hr" });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) {
        quoted.push(lines[i]!.replace(QUOTE, ""));
        i++;
      }
      blocks.push({ t: "quote", c: parseInline(quoted.join("\n")) });
      continue;
    }

    if (UL.test(line)) {
      const items: Inline[][] = [];
      while (i < lines.length && UL.test(lines[i]!)) {
        items.push(parseInline(lines[i]!.replace(UL, "")));
        i++;
      }
      blocks.push({ t: "ul", items });
      continue;
    }

    if (OL.test(line)) {
      const items: Inline[][] = [];
      while (i < lines.length && OL.test(lines[i]!)) {
        items.push(parseInline(lines[i]!.replace(OL, "")));
        i++;
      }
      blocks.push({ t: "ol", items });
      continue;
    }

    // Table: a pipe row whose NEXT line is a delimiter row with the same cell
    // count (GFM's recognition rule — anything less stays a paragraph).
    if (line.includes("|")) {
      const align = i + 1 < lines.length ? parseDelimiterRow(lines[i + 1]!) : null;
      if (align !== null && align.length === splitRow(line).length) {
        const head = splitRow(line).map(parseInline);
        i += 2;
        const rows: Inline[][][] = [];
        // Body rows: pipe lines until a blank line, a pipeless line, or
        // another block opener. Width is the header's: short rows pad,
        // long rows truncate, as GFM says.
        while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "" && !isBlockStart(lines[i]!)) {
          const cells = splitRow(lines[i]!).slice(0, head.length);
          while (cells.length < head.length) cells.push("");
          rows.push(cells.map(parseInline));
          i++;
        }
        blocks.push({ t: "table", align, head, rows });
        continue;
      }
    }

    // Paragraph: consecutive lines until a blank line or a new block opener.
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && !isBlockStart(lines[i]!)) {
      para.push(lines[i]!);
      i++;
    }
    blocks.push({ t: "p", c: parseInline(para.join("\n")) });
  }
  return blocks;
}
