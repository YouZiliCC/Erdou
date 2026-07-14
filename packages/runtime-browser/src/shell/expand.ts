import type { Word } from "./ast.js";
import type { Vfs } from "../vfs/vfs.js";
import { join, normalize, split } from "../vfs/path.js";
import { globToRegExp, hasGlobChars } from "./glob.js";

function joinPath(dir: string, name: string): string {
  return dir === "/" ? "/" + name : dir + "/" + name;
}

/** Expand a glob pattern against the filesystem. Returns matching paths, in the
 *  same relativity as the pattern. If nothing matches, returns the literal
 *  pattern (POSIX default). */
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
        for (const entry of vfs.readdir(dir)) {
          if (re.test(entry.name)) next.push(joinPath(dir, entry.name));
        }
      } else {
        const child = joinPath(dir, seg);
        if (vfs.exists(child)) next.push(child);
      }
    }
    candidates = next;
  }

  if (candidates.length === 0) return [pattern];
  candidates.sort();
  if (absolute) return candidates;
  const prefix = cwd === "/" ? 1 : cwd.length + 1;
  return candidates.map((p) => p.slice(prefix));
}

/**
 * Expand a word into zero-or-more argv fragments: literals pass through,
 * `$VAR` substitutes from env (unknown → empty, as in POSIX), and unquoted
 * glob words expand against the filesystem.
 */
export function expandWord(word: Word, env: Record<string, string>, vfs: Vfs, cwd: string): string[] {
  let pattern = "";
  let isGlob = false;
  for (const part of word.parts) {
    if (part.t === "lit") pattern += part.v;
    else if (part.t === "var") pattern += env[part.name] ?? "";
    else {
      pattern += part.v;
      isGlob = true;
    }
  }
  return isGlob ? expandGlob(vfs, cwd, pattern) : [pattern];
}
