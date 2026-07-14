/** Convert a single-segment glob pattern (no `/`) to an anchored RegExp.
 *  `*` matches any run of non-slash chars, `?` matches one. */
export function globToRegExp(segment: string): RegExp {
  let re = "^";
  for (const ch of segment) {
    if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(re + "$");
}

export const hasGlobChars = (s: string): boolean => s.includes("*") || s.includes("?");
