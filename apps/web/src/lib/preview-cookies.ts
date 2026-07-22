/**
 * The preview's cookie jar.
 *
 * A browser never stores cookies from a Service-Worker-SYNTHESIZED response, and
 * `Cookie`/`Set-Cookie` are forbidden header names the browser hides from the SW
 * — so a previewed server's cookie sessions would never round-trip. This jar
 * closes that gap: the page bridge (preview-bridge.ts) stores each guest
 * response's `Set-Cookie`s here and re-injects a `Cookie` request header on later
 * requests to the SAME guest port, emulating the browser's cookie handling for
 * the previewed app.
 *
 * Scope: per guest PORT (each previewed app is its own cookie space — there is
 * no cross-app cookie leakage, and no interference with the Studio app's own
 * origin cookies, which the SW never sees anyway). Cookie paths are matched
 * against the GUEST path (the request URL the runtime sees, already stripped of
 * the `/__preview__/<port>/` scope). In-memory for the session — a page reload
 * restarts the preview and its servers, so the jar starts fresh with them.
 *
 * Supported (RFC 6265, the parts a real app relies on): name=value, Path (with
 * the default-path rule), Expires + Max-Age (Max-Age wins), deletion via an
 * expired/Max-Age=0 cookie, same-name+path overwrite, and longest-path-first
 * ordering in the emitted header. Domain/Secure/SameSite are irrelevant to a
 * same-origin, per-port proxy and are ignored.
 */

export interface StoredCookie {
  name: string;
  value: string;
  path: string;
  /** Epoch ms when the cookie expires; null = a session cookie (jar lifetime). */
  expiresAt: number | null;
}

const MAX_PER_PORT = 60; // a sane cap so a pathological server can't grow it unbounded

/** The default cookie Path for a request (RFC 6265 §5.1.4): the request path up
 *  to (not including) the last '/', or '/' when there is no such segment. */
export function defaultPath(requestPath: string): string {
  const p = (requestPath.split("?")[0] ?? "") || "/";
  if (!p.startsWith("/")) return "/";
  const lastSlash = p.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : p.slice(0, lastSlash);
}

/** Whether a cookie with `cookiePath` applies to a request at `requestPath`
 *  (RFC 6265 §5.1.4 path-match). */
export function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (cookiePath === requestPath) return true;
  if (requestPath.startsWith(cookiePath)) {
    return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
  }
  return false;
}

/** Parse one raw `Set-Cookie` VALUE into a StoredCookie, or null if it has no
 *  usable name. `requestPath` supplies the default Path; `now` resolves Max-Age. */
export function parseSetCookie(line: string, requestPath: string, now: number): StoredCookie | null {
  const parts = line.split(";");
  const nv = parts[0] ?? "";
  const eq = nv.indexOf("=");
  if (eq < 1) return null; // an empty name is not a cookie
  const name = nv.slice(0, eq).trim();
  if (name === "") return null;
  const value = nv.slice(eq + 1).trim();

  let path = defaultPath(requestPath);
  let expiresAt: number | null = null;
  let maxAgeSeen = false;
  for (let i = 1; i < parts.length; i++) {
    const attr = parts[i] ?? "";
    const ai = attr.indexOf("=");
    const an = (ai === -1 ? attr : attr.slice(0, ai)).trim().toLowerCase();
    const av = ai === -1 ? "" : attr.slice(ai + 1).trim();
    if (an === "path" && av.startsWith("/")) {
      path = av;
    } else if (an === "max-age") {
      const s = Number(av);
      if (Number.isFinite(s)) {
        expiresAt = now + s * 1000; // Max-Age <= 0 => already expired => a delete
        maxAgeSeen = true;
      }
    } else if (an === "expires" && !maxAgeSeen) {
      const t = Date.parse(av);
      if (Number.isFinite(t)) expiresAt = t;
    }
  }
  return { name, value, path, expiresAt };
}

export class PreviewCookieJar {
  private readonly byPort = new Map<number, StoredCookie[]>();

  /** Injectable clock so the store/expiry logic is unit-testable. */
  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Absorb a guest response's `Set-Cookie` values for `port` (the request that
   *  produced them was at `requestPath`), applying set / overwrite / delete. */
  store(port: number, requestPath: string, setCookies: readonly string[]): void {
    if (setCookies.length === 0) return;
    const now = this.now();
    const jar = this.byPort.get(port) ?? [];
    for (const line of setCookies) {
      const c = parseSetCookie(line, requestPath, now);
      if (!c) continue;
      // Same name+path always replaces (RFC 6265 §5.3): drop the old one first.
      const idx = jar.findIndex((e) => e.name === c.name && e.path === c.path);
      if (idx !== -1) jar.splice(idx, 1);
      // An expired cookie (past Expires / Max-Age<=0) is a DELETE — the removal
      // above already did it; just don't re-add.
      if (c.expiresAt === null || c.expiresAt > now) jar.push(c);
    }
    if (jar.length > MAX_PER_PORT) jar.splice(0, jar.length - MAX_PER_PORT); // evict oldest
    if (jar.length > 0) this.byPort.set(port, jar);
    else this.byPort.delete(port);
  }

  /** The `Cookie` request-header value for a request to `port` at `requestPath`,
   *  or null when no live cookie applies. Prunes expired cookies as a side
   *  effect. Longest-path-first, per RFC 6265 §5.4. */
  header(port: number, requestPath: string): string | null {
    const jar = this.byPort.get(port);
    if (!jar || jar.length === 0) return null;
    const now = this.now();
    const path = (requestPath.split("?")[0] ?? "") || "/";
    const live = jar.filter((c) => c.expiresAt === null || c.expiresAt > now);
    if (live.length !== jar.length) {
      if (live.length > 0) this.byPort.set(port, live);
      else this.byPort.delete(port);
    }
    const matched = live
      .filter((c) => pathMatches(c.path, path))
      .sort((a, b) => b.path.length - a.path.length);
    if (matched.length === 0) return null;
    return matched.map((c) => `${c.name}=${c.value}`).join("; ");
  }

  /** Forget a single guest's cookies (e.g. its port was stopped/re-served). */
  clearPort(port: number): void {
    this.byPort.delete(port);
  }

  /** Forget everything — the bridge calls this on a kernel switch, since the old
   *  kernel's servers (and their sessions) are gone. */
  clear(): void {
    this.byPort.clear();
  }
}
