import type { AuthCallback } from "isomorphic-git";

/**
 * Helpers for the network subcommands (clone / fetch / pull / push): argv
 * parsing, credential extraction, and token redaction. Everything here is
 * pure — no I/O — so it unit-tests without a git server.
 *
 * Security invariant: a token may enter via the URL userinfo
 * (`https://user:token@host/…`) or the GIT_TOKEN env var, and must NEVER
 * appear in stdout/stderr. Every string echoed by a network command passes
 * through `redactUrl`/`redactSecrets` first.
 */

/** Parsed argv tail of a network subcommand. */
export interface NetArgs {
  positionals: string[];
  /** Resolved CORS proxy: the `--cors-proxy` flag, else GIT_CORS_PROXY from the exec env. No default — Node needs none, browsers opt in. */
  corsProxy: string | undefined;
  force: boolean;
}

/**
 * Parse a network subcommand's argv tail. Recognized flags: `--cors-proxy
 * <url>` (flag wins over the GIT_CORS_PROXY env var) and — only where
 * `allowForce` — `--force`. Any other `-`/`--` argument is an error: an
 * unsupported flag must fail loudly, never be silently treated as a
 * positional.
 */
export function parseNetArgs(
  args: string[],
  env: Record<string, string>,
  opts: { allowForce?: boolean } = {},
): NetArgs {
  const positionals: string[] = [];
  let corsProxy: string | undefined;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--cors-proxy") {
      const v = args[++i];
      if (v === undefined || v.startsWith("-")) {
        throw new Error("--cors-proxy requires a value (the proxy base URL)");
      }
      corsProxy = v;
    } else if (a === "--force" && opts.allowForce) {
      force = true;
    } else if (a.startsWith("-")) {
      throw new Error(`unknown flag '${a}'`);
    } else {
      positionals.push(a);
    }
  }
  return { positionals, corsProxy: corsProxy ?? env["GIT_CORS_PROXY"] ?? undefined, force };
}

/** Replace the userinfo (`user:token@`) of a URL with `***@`. URLs without credentials pass through unchanged. */
export function redactUrl(url: string): string {
  return url.replace(/^([a-zA-Z][\w+.-]*:\/\/)[^/@]+@/, "$1***@");
}

/** Scrub credential-bearing `scheme://userinfo@` anywhere inside a message (isomorphic-git errors can embed request URLs). */
export function redactSecrets(msg: string): string {
  return msg.replace(/([a-zA-Z][\w+.-]*:\/\/)[^/@\s]+@/g, "$1***@");
}

/** A URL split into its credential-free form + the credentials it carried. */
export interface UrlAuth {
  url: string;
  username: string | undefined;
  password: string | undefined;
}

/**
 * Split embedded credentials out of an http(s) URL. The clean URL is what we
 * hand to isomorphic-git — it is what gets persisted as the remote URL on
 * clone, and tokens must never land in .git/config — while the credentials
 * feed `onAuth`. Anything that is not an absolute http(s) URL (ssh,
 * `git@host:…`, relative paths) errors precisely; smart-HTTP is the only
 * transport this executor supports.
 */
export function splitUrlAuth(rawUrl: string): UrlAuth {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error(`invalid URL '${redactUrl(rawUrl)}' — expected an absolute http(s) URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(
      `unsupported protocol '${u.protocol}' in '${redactUrl(rawUrl)}' — only http(s) remotes are supported (no ssh)`,
    );
  }
  const username = u.username ? decodeURIComponent(u.username) : undefined;
  const password = u.password ? decodeURIComponent(u.password) : undefined;
  u.username = "";
  u.password = "";
  return { url: u.toString(), username, password };
}

/**
 * Build isomorphic-git's `onAuth` callback (invoked only after a 401/203
 * challenge). Precedence: credentials embedded in the command's URL win over
 * the GIT_TOKEN env var. A bare GIT_TOKEN becomes the Basic-auth username —
 * GitHub's documented PAT form. Returns undefined when no credentials exist
 * so an auth challenge fails fast as a plain HTTP 401.
 */
export function makeOnAuth(
  urlAuth: { username?: string | undefined; password?: string | undefined } | undefined,
  env: Record<string, string>,
): AuthCallback | undefined {
  if (urlAuth && (urlAuth.username || urlAuth.password)) {
    return () => ({ username: urlAuth.username ?? "", password: urlAuth.password ?? "" });
  }
  const token = env["GIT_TOKEN"];
  if (token) return () => ({ username: token });
  return undefined;
}

/**
 * Flatten an error and its `cause` chain into one redacted line. Undici's
 * fetch reports every transport failure as TypeError "fetch failed" with the
 * real reason (DNS ENOTFOUND, ECONNREFUSED, TLS, "Connect Timeout Error
 * (attempted address: host:443)") buried in `cause` — dropping it makes the
 * error loud but undiagnosable. Each link contributes its message, joined with
 * " — "; an AggregateError with no message of its own (Node's happy-eyeballs
 * multi-address connect failure) contributes its sub-errors' messages instead.
 * Depth-capped so a cyclic chain cannot loop forever.
 */
export function describeError(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; cur !== undefined && cur !== null && depth < 5; depth++) {
    if (cur instanceof AggregateError && !cur.message) {
      parts.push(cur.errors.map((s) => (s instanceof Error ? s.message : String(s))).join("; "));
    } else {
      parts.push(cur instanceof Error ? cur.message : String(cur));
    }
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  return redactSecrets(parts.filter(Boolean).join(" — ") || String(e));
}

/**
 * Run one network operation; on failure rethrow with the full (redacted)
 * message chain plus the redacted remote URL. Fail fast — no retries, no
 * fallbacks. The rethrown Error carries no `cause`: the chain is already
 * flattened into the message, so downstream describeError won't double-report.
 */
export async function withRemoteContext<T>(displayUrl: string, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (e) {
    throw new Error(`${describeError(e)} (remote: ${redactUrl(displayUrl)})`);
  }
}
