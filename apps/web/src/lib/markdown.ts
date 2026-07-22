/**
 * A tiny, dependency-free Markdown parser for agent chat output — matches
 * Erdou's hand-rolled, no-deps stance (see scripts/render-help.mjs). Produces a
 * small AST that `components/Markdown.tsx` renders to REACT NODES (never an HTML
 * string / dangerouslySetInnerHTML), so model output can't inject markup — text
 * is escaped by React and link hrefs are scheme-checked (`safeHref`).
 *
 * Covered (what Claude actually emits): paragraphs with soft line breaks, ATX
 * headings, fenced code blocks, inline code, bold, italic, links, unordered and
 * ordered lists, blockquotes, and horizontal rules. Anything ambiguous degrades
 * to plain text rather than mis-rendering.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "br" }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "link"; href: string | null; c: Inline[] };

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: number; c: Inline[] }
  | { t: "code"; lang: string; v: string }
  | { t: "ul"; items: Inline[][] }
  | { t: "ol"; items: Inline[][] }
  | { t: "quote"; c: Inline[] }
  | { t: "hr" };

const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE = /^```(\w*)\s*$/;
const FENCE_CLOSE = /^```\s*$/;
const QUOTE = /^>\s?/;
const UL = /^\s*[-*+]\s+/;
const OL = /^\s*\d+[.)]\s+/;

/** True if a line opens a NON-paragraph block, so a paragraph run stops at it. */
function isBlockStart(line: string): boolean {
  return (
    FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || UL.test(line) || OL.test(line)
  );
}

/** A link href we're willing to emit as an `<a>`: http(s)/mailto or a
 *  schemeless (relative) target. Any other scheme — javascript:, data:,
 *  vbscript: … — returns null and the link renders as plain text. */
export function safeHref(href: string): string | null {
  const h = href.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(h);
  if (scheme && !/^(https?|mailto)$/i.test(scheme[1]!)) return null;
  return h;
}

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
    // Inline code: `…` — literal, no nested parsing.
    if (c === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        flush();
        out.push({ t: "code", v: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
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
    // Bold: **…** or __…__ (opening delimiter must not be followed by space).
    if ((c === "*" || c === "_") && text[i + 1] === c && text[i + 2] !== undefined && !/\s/.test(text[i + 2]!)) {
      const delim = c + c;
      const end = text.indexOf(delim, i + 2);
      if (end > i + 1) {
        flush();
        out.push({ t: "strong", c: parseInline(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    // Italic: *…* or _…_ (no space just inside the delimiters).
    if ((c === "*" || c === "_") && text[i + 1] !== undefined && !/\s/.test(text[i + 1]!) && text[i + 1] !== c) {
      const end = text.indexOf(c, i + 1);
      if (end > i + 1 && !/\s/.test(text[end - 1]!)) {
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
