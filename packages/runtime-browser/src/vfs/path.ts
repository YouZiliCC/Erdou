import { ErrnoError } from "@erdou/runtime-contract";

/**
 * Normalize an absolute POSIX path: collapse `.`/`..`, drop empty and trailing
 * segments, and keep it rooted at `/`. `..` at the root is a no-op (you cannot
 * escape the root). Relative paths are rejected with EINVAL — the kernel deals
 * in absolute paths only.
 */
export function normalize(p: string): string {
  if (!p.startsWith("/")) {
    throw new ErrnoError("EINVAL", { path: p, syscall: "normalize" });
  }
  const stack: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      stack.pop();
      continue;
    }
    stack.push(seg);
  }
  return "/" + stack.join("/");
}

/** Join path segments (the first must be absolute) and normalize the result. */
export function join(...parts: string[]): string {
  return normalize(parts.join("/"));
}

/** The path components of an absolute path, e.g. "/a/b" -> ["a", "b"], "/" -> []. */
export function split(p: string): string[] {
  return normalize(p)
    .split("/")
    .filter((s) => s.length > 0);
}

/** The parent directory of a path. dirname("/a/b/c") === "/a/b", dirname("/a") === "/". */
export function dirname(p: string): string {
  const parts = split(p);
  if (parts.length <= 1) return "/";
  return "/" + parts.slice(0, -1).join("/");
}

/** The final component of a path. basename("/a/b/c") === "c", basename("/") === "/". */
export function basename(p: string): string {
  const parts = split(p);
  return parts.length === 0 ? "/" : parts[parts.length - 1]!;
}
