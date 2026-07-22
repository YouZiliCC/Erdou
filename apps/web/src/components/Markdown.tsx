import { createElement, Fragment, type ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "../lib/markdown.js";

/**
 * Render agent chat text as Markdown — to REACT NODES only (no
 * dangerouslySetInnerHTML), so model output is escaped by React and link hrefs
 * are scheme-checked in the parser (`safeHref`). Covers the subset Claude emits
 * (see lib/markdown.ts); anything ambiguous shows as plain text.
 */
export function Markdown({ text }: { text: string }) {
  return <div className="md">{parseMarkdown(text).map((b, i) => renderBlock(b, i))}</div>;
}

function renderInline(spans: Inline[]): ReactNode {
  return spans.map((s, i): ReactNode => {
    switch (s.t) {
      case "text":
        return <Fragment key={i}>{s.v}</Fragment>;
      case "br":
        return <br key={i} />;
      case "code":
        return (
          <code key={i} className="md-code">
            {s.v}
          </code>
        );
      case "strong":
        return <strong key={i}>{renderInline(s.c)}</strong>;
      case "em":
        return <em key={i}>{renderInline(s.c)}</em>;
      case "link":
        return s.href !== null ? (
          <a key={i} href={s.href} target="_blank" rel="noopener noreferrer">
            {renderInline(s.c)}
          </a>
        ) : (
          <Fragment key={i}>{renderInline(s.c)}</Fragment>
        );
    }
  });
}

function renderBlock(b: Block, key: number): ReactNode {
  switch (b.t) {
    case "p":
      return (
        <p key={key} className="md-p">
          {renderInline(b.c)}
        </p>
      );
    case "h":
      // h1..h6 (level is 1-6 by construction), one shared class for chat sizing.
      return createElement(`h${b.level}`, { key, className: "md-h" }, renderInline(b.c));
    case "code":
      return (
        <pre key={key} className="md-pre">
          <code>{b.v}</code>
        </pre>
      );
    case "ul":
      return (
        <ul key={key} className="md-list">
          {b.items.map((it, j) => (
            <li key={j}>{renderInline(it)}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol key={key} className="md-list">
          {b.items.map((it, j) => (
            <li key={j}>{renderInline(it)}</li>
          ))}
        </ol>
      );
    case "quote":
      return (
        <blockquote key={key} className="md-quote">
          {renderInline(b.c)}
        </blockquote>
      );
    case "hr":
      return <hr key={key} className="md-hr" />;
  }
}
