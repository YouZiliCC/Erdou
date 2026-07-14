import { ErrnoError } from "@erdou/runtime-contract";
import type { WordPart } from "./ast.js";

export type Token =
  | { type: "word"; parts: WordPart[] }
  | { type: "op"; value: "|" | "||" | "&&" | ";" | "&" }
  | { type: "redirect"; fd: 0 | 1 | 2; op: ">" | ">>" | "<" };

const isWhitespace = (ch: string): boolean => ch === " " || ch === "\t" || ch === "\n";
const isOperatorChar = (ch: string): boolean =>
  ch === "|" || ch === "&" || ch === ";" || ch === "<" || ch === ">";
const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
const isDigit = (ch: string): boolean => ch >= "0" && ch <= "9";

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  const len = src.length;
  let i = 0;

  const at = (k: number): string | undefined => src[k];

  function readVar(): WordPart {
    i++; // consume '$'
    if (at(i) === "{") {
      i++;
      let name = "";
      while (i < len && at(i) !== "}") name += src[i++];
      if (i >= len) throw new ErrnoError("EINVAL", { syscall: "parse", path: "unterminated ${" });
      i++; // consume '}'
      return { t: "var", name };
    }
    let name = "";
    while (i < len && isNameChar(at(i)!)) name += src[i++];
    if (name === "") return { t: "lit", v: "$" };
    return { t: "var", name };
  }

  function readWord(): WordPart[] {
    const parts: WordPart[] = [];
    let buf = "";
    let bufGlob = false;
    const flush = (): void => {
      if (buf.length > 0) {
        parts.push(bufGlob ? { t: "glob", v: buf } : { t: "lit", v: buf });
        buf = "";
        bufGlob = false;
      }
    };
    while (i < len) {
      const ch = at(i)!;
      if (isWhitespace(ch) || isOperatorChar(ch)) break;
      if (ch === "'") {
        flush();
        i++;
        let lit = "";
        while (i < len && at(i) !== "'") lit += src[i++];
        if (i >= len) throw new ErrnoError("EINVAL", { syscall: "parse", path: "unterminated '" });
        i++;
        parts.push({ t: "lit", v: lit });
      } else if (ch === '"') {
        flush();
        i++;
        while (i < len && at(i) !== '"') {
          if (at(i) === "$") {
            parts.push(readVar());
          } else {
            let lit = "";
            while (i < len && at(i) !== '"' && at(i) !== "$") lit += src[i++];
            parts.push({ t: "lit", v: lit });
          }
        }
        if (i >= len) throw new ErrnoError("EINVAL", { syscall: "parse", path: 'unterminated "' });
        i++;
      } else if (ch === "$") {
        flush();
        parts.push(readVar());
      } else {
        if (ch === "*" || ch === "?") bufGlob = true;
        buf += ch;
        i++;
      }
    }
    flush();
    return parts;
  }

  function readRedirect(fd: 0 | 1 | 2): Token {
    if (at(i) === ">") {
      if (at(i + 1) === ">") {
        i += 2;
        return { type: "redirect", fd, op: ">>" };
      }
      i++;
      return { type: "redirect", fd, op: ">" };
    }
    i++; // '<'
    return { type: "redirect", fd, op: "<" };
  }

  while (i < len) {
    while (i < len && isWhitespace(at(i)!)) i++;
    if (i >= len) break;
    const c = at(i)!;

    if (isDigit(c) && (at(i + 1) === ">" || at(i + 1) === "<")) {
      const fd = Number(c) as 0 | 1 | 2;
      i++;
      tokens.push(readRedirect(fd));
      continue;
    }
    if (c === "|") {
      if (at(i + 1) === "|") {
        tokens.push({ type: "op", value: "||" });
        i += 2;
      } else {
        tokens.push({ type: "op", value: "|" });
        i++;
      }
      continue;
    }
    if (c === "&") {
      if (at(i + 1) === "&") {
        tokens.push({ type: "op", value: "&&" });
        i += 2;
      } else {
        tokens.push({ type: "op", value: "&" });
        i++;
      }
      continue;
    }
    if (c === ";") {
      tokens.push({ type: "op", value: ";" });
      i++;
      continue;
    }
    if (c === ">" || c === "<") {
      tokens.push(readRedirect(c === ">" ? 1 : 0));
      continue;
    }
    tokens.push({ type: "word", parts: readWord() });
  }

  return tokens;
}
