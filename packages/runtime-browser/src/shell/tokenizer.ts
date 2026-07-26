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
/** The only `${...}` body this shell can evaluate: a bare parameter name. */
const isPlainName = (s: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);

/** A shell construct we deliberately do not implement. It must fail loudly:
 *  every one of these used to degrade into something that looked like it
 *  worked — `${X:-d}` expanded to the empty string, `$(cmd)` passed through as
 *  the literal text — so a command that wrote a file wrote wrong bytes with
 *  exit 0. */
const unsupported = (construct: string): ErrnoError =>
  new ErrnoError("EINVAL", { syscall: "parse", path: construct });

/** Bash's special parameters, none of which this shell can answer — there are
 *  no positional parameters (nothing runs scripts with arguments here), the
 *  shell has no pid of its own, and `$!` needs a job's pid the interpreter
 *  never exposes. Left to the name loop they degraded silently and differently
 *  for each: `$#` came out as the literal `$#`, `$1` as the empty string, and
 *  `$?` as `$` plus a `?` glob that could match a one-character filename.
 *  `$?` is the one special parameter we implement (see readVar). */
const SPECIAL_PARAMS: Record<string, string> = {
  $: "shell pid",
  "!": "pid of the last background job",
  "@": "positional parameters",
  "*": "positional parameters",
  "#": "positional parameter count",
  "-": "shell option flags",
};

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  const len = src.length;
  let i = 0;

  const at = (k: number): string | undefined => src[k];

  function readVar(): WordPart {
    const dollar = i;
    i++; // consume '$'
    if (at(i) === "(") {
      throw at(i + 1) === "("
        ? unsupported("arithmetic expansion is not supported: $((...))")
        : unsupported("command substitution is not supported: $(...)");
    }
    const next = at(i);
    if (next !== undefined) {
      const special = SPECIAL_PARAMS[next];
      if (special !== undefined) {
        throw unsupported(`special parameter is not supported: $${next} (${special})`);
      }
      if (isDigit(next)) {
        throw unsupported(`positional parameter is not supported: $${next}`);
      }
    }
    // `$?` — the exit status of the last command. `?` is not a legal variable
    // name (isNameChar excludes it), so this `var` part can never collide with
    // an environment variable; the interpreter supplies the value at expansion
    // time from the status it already tracks for `&&`/`||`.
    if (next === "?") {
      i++;
      return { t: "var", name: "?" };
    }
    if (at(i) === "{") {
      i++;
      let name = "";
      while (i < len && at(i) !== "}") name += src[i++];
      if (i >= len) throw new ErrnoError("EINVAL", { syscall: "parse", path: "unterminated ${" });
      i++; // consume '}'
      if (!isPlainName(name)) {
        throw unsupported(`unsupported parameter expansion: ${src.slice(dollar, i)}`);
      }
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
      if (ch === "\\") {
        i++;
        const esc = at(i);
        // No character to escape: bash would prompt for a continuation line, we
        // have nothing left to read, so refuse rather than drop the backslash.
        if (esc === undefined) {
          throw new ErrnoError("EINVAL", { syscall: "parse", path: "trailing backslash" });
        }
        i++;
        if (esc === "\n") continue; // line continuation: both characters vanish
        // The escaped character is literal, so it cannot end the word (`a\ b`
        // is one argument). An escaped metacharacter also has to leave `buf`:
        // bufGlob classifies the whole buffer, so a `\*` left in it would be
        // reclassified by a later unescaped `*` and `echo \*d*` would answer
        // `d.txt` where bash answers `*d*`. A `lit` part of its own cannot be.
        if (esc === "*" || esc === "?") {
          flush();
          parts.push({ t: "lit", v: esc });
          continue;
        }
        buf += esc;
        continue;
      }
      if (ch === "`") throw unsupported("command substitution is not supported: `...`");
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
        let lit = "";
        const flushLit = (): void => {
          if (lit.length > 0) {
            parts.push({ t: "lit", v: lit });
            lit = "";
          }
        };
        while (i < len && at(i) !== '"') {
          const c = at(i)!;
          if (c === "\\") {
            const esc = at(i + 1);
            if (esc === undefined) break; // falls into the unterminated-quote error below
            if (esc === "\n") {
              i += 2; // line continuation
              continue;
            }
            // POSIX: inside double quotes a backslash is special ONLY before
            // these; before anything else it stays an ordinary character, so
            // `"a\b"` really is `a\b`.
            if (esc === '"' || esc === "$" || esc === "\\" || esc === "`") {
              lit += esc;
              i += 2;
              continue;
            }
            lit += c;
            i++;
            continue;
          }
          if (c === "$") {
            flushLit();
            parts.push(readVar());
            continue;
          }
          if (c === "`") throw unsupported("command substitution is not supported: `...`");
          lit += c;
          i++;
        }
        // The loop also exits on a dangling backslash, hence the explicit check
        // that we actually stopped on the closing quote.
        if (at(i) !== '"') {
          throw new ErrnoError("EINVAL", { syscall: "parse", path: 'unterminated "' });
        }
        i++;
        flushLit();
      } else if (ch === "$") {
        // `$'…'` is ANSI-C quoting only here, unquoted. Inside double quotes
        // bash treats it as ordinary text (`"$'x'"` is `$'x'`), and readVar is
        // shared with that branch — so this check has to live at this call site
        // or a legal command gets rejected.
        if (at(i + 1) === "'") throw unsupported("ANSI-C quoting is not supported: $'...'");
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

    // A line continuation sitting between words is pure whitespace; letting
    // readWord see it would emit a spurious empty word (i.e. an empty argv
    // entry) for `cmd a \<newline> b`.
    if (c === "\\" && at(i + 1) === "\n") {
      i += 2;
      continue;
    }
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
