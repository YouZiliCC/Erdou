/** Patterns here are backslash-escaped: `\x` matches a literal `x`. The escapes
 *  exist because a word's parts are concatenated into one pattern before the
 *  globber sees them, which throws away which characters were quoted — without
 *  them `\*d*` and `"*"d*` reached the matcher as `*d*` and `echo \*d*` printed
 *  `d.txt` instead of `*d*`. expandWord adds them; nothing else should. */

const escapeRe = (ch: string): string => ch.replace(/[.+^${}()|[\]\\*?]/g, "\\$&");

/** Convert a single-segment glob pattern (no `/`) to an anchored RegExp. An
 *  unescaped `*` matches any run of non-slash chars, an unescaped `?` matches
 *  one; a backslash makes the next character match itself. */
export function globToRegExp(segment: string): RegExp {
  let re = "^";
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (ch === "\\" && i + 1 < segment.length) re += escapeRe(segment[++i]!);
    else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += escapeRe(ch);
  }
  return new RegExp(re + "$");
}

/** Escape text that must match itself — a quoted or backslash-escaped run of a
 *  word. Its `*`/`?` are ordinary characters, and its backslashes are filename
 *  characters rather than the escape being introduced here. */
export const escapeGlobLiteral = (s: string): string => s.replace(/[*?\\]/g, "\\$&");

/** Escape text whose `*`/`?` still glob — an unquoted run written in the
 *  source (expansion values never glob here; see expandWord). Only the
 *  backslashes are protected: `a\b*` has to look for a name starting `a\b`,
 *  not `ab`. */
export const escapeGlobBackslashes = (s: string): string => s.replace(/\\/g, "\\\\");

/** Strip one level of escaping, for the two places that need the pattern's own
 *  text back: the POSIX no-match result (`echo \*d*` with no match prints
 *  `*d*`) and a segment that turned out to be a plain name to look up. */
export const unescapeGlob = (s: string): string => s.replace(/\\(.)/g, "$1");

/** True only for an UNESCAPED metacharacter — an even number of backslashes
 *  before it. `\*` is a literal star, so a segment holding just that is a name
 *  to stat, not a pattern to match every entry against. */
export const hasGlobChars = (s: string): boolean => /(^|[^\\])(\\\\)*[*?]/.test(s);
