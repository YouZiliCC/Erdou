import type { Word } from "./ast.js";
import type { Vfs } from "../vfs/vfs.js";
import { join, normalize, split } from "../vfs/path.js";
import {
  escapeGlobBackslashes,
  escapeGlobLiteral,
  globToRegExp,
  hasGlobChars,
  unescapeGlob,
} from "./glob.js";

function joinPath(dir: string, name: string): string {
  return dir === "/" ? "/" + name : dir + "/" + name;
}

/** Relative path from `from` to `to` (both absolute, normalized). */
function relativePath(from: string, to: string): string {
  const f = split(from);
  const t = split(to);
  let i = 0;
  while (i < f.length && i < t.length && f[i] === t[i]) i++;
  const parts = [...f.slice(i).map(() => ".."), ...t.slice(i)];
  return parts.length === 0 ? "." : parts.join("/");
}

/** Expand a glob pattern against the filesystem. Returns matching paths, in the
 *  same relativity as the pattern. If nothing matches, returns the literal
 *  pattern (POSIX default). `pattern` is escaped in the sense of glob.ts: every
 *  `*`/`?` that was quoted in the source carries a backslash, so it is unescaped
 *  again wherever the text itself is wanted rather than matched. */
function expandGlob(vfs: Vfs, cwd: string, pattern: string): string[] {
  const absolute = pattern.startsWith("/");
  const abs = absolute ? normalize(pattern) : join(cwd, pattern);
  const segments = split(abs);

  let candidates: string[] = ["/"];
  for (const seg of segments) {
    const next: string[] = [];
    const re = hasGlobChars(seg) ? globToRegExp(seg) : null;
    for (const dir of candidates) {
      if (!vfs.exists(dir) || vfs.stat(dir).type !== "directory") continue;
      if (re) {
        // A leading dot must be matched explicitly (POSIX): `*` doesn't match dotfiles.
        const includeDot = seg.startsWith(".");
        for (const entry of vfs.readdir(dir)) {
          if (!includeDot && entry.name.startsWith(".")) continue;
          if (re.test(entry.name)) next.push(joinPath(dir, entry.name));
        }
      } else {
        const child = joinPath(dir, unescapeGlob(seg));
        if (vfs.exists(child)) next.push(child);
      }
    }
    candidates = next;
  }

  if (candidates.length === 0) return [unescapeGlob(pattern)];
  candidates.sort();
  if (absolute) return candidates;
  return candidates.map((p) => relativePath(cwd, p));
}

/**
 * Expand a word into zero-or-more argv fragments: literals pass through,
 * `$VAR` substitutes from env (unknown → empty, as in POSIX), and unquoted
 * glob words expand against the filesystem.
 */
export function expandWord(word: Word, env: Record<string, string>, vfs: Vfs, cwd: string): string[] {
  // Two strings at once, because concatenating the parts is what destroys the
  // quoting information: this loop is the last place that knows a `*` came from
  // a `lit` part. `text` is the word with no globbing; `pattern` is the same
  // text with the quoted metacharacters escaped, so `\*d*` and `"*"d*` glob on
  // their second star only, as bash does.
  let text = "";
  let pattern = "";
  let isGlob = false;
  for (const part of word.parts) {
    if (part.t === "lit") {
      text += part.v;
      pattern += escapeGlobLiteral(part.v);
    } else if (part.t === "var") {
      const value = env[part.name] ?? "";
      text += value;
      pattern += escapeGlobBackslashes(value);
    } else {
      text += part.v;
      pattern += escapeGlobBackslashes(part.v);
      isGlob = true;
    }
  }
  return isGlob ? expandGlob(vfs, cwd, pattern) : [text];
}
