/** Registry egress shim for v86's fetch-NAT (Round 13).
 *
 *  The NAT relays guest HTTP (TCP:80 only) through the adapter's instance-property
 *  `fetch`, forwarding EVERY guest request header into a cross-origin page fetch.
 *  Three parity jobs, each forced by real-registry behavior:
 *  - PyPI answers plain http with 403 "SSL is required" (no redirect) and its
 *    simple-API bodies link https:// wheels the NAT cannot relay (non-80 ports
 *    are refused) → upgrade the scheme where v86 doesn't, and rewrite simple-API
 *    links to http (proven end-to-end in the S3 spike).
 *  - npm's transport ALWAYS decorates requests with non-CORS-safelisted telemetry
 *    headers, and registry.npmjs.org rejects every preflight → strip them (see
 *    PREFLIGHT_UNSAFE_HEADERS; without this, in-browser `npm install` cannot work
 *    at all).
 *  - Conditional-request validators are preflight-rejected everywhere except
 *    pypi.org → strip them per host (see VALIDATOR_HEADERS).
 */

/** What v86's relay consumes from the adapter fetch result: status/statusText/
 *  url/redirected/headers plus a body stream OR arrayBuffer(). A native
 *  Response satisfies this. */
export interface RelayResponse {
  status: number;
  statusText: string;
  url: string;
  redirected: boolean;
  headers: Headers;
  body?: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBufferLike>;
}

/** The NAT's original fetch result — the shim additionally reads `text()` when
 *  rewriting a simple-API body. */
export interface UpstreamResponse extends RelayResponse {
  text(): Promise<string>;
}

export type UpstreamFetch = (url: string, init?: unknown) => Promise<UpstreamResponse>;
export type EgressFetch = (url: string, init?: unknown) => Promise<RelayResponse>;

/** Marker property on a shimmed adapter fetch — makes install idempotent and
 *  lets tests assert the boot-time install happened. */
export const EGRESS_SHIM_MARKER = "__erdouEgressShim";

const PYPI_HOSTS = new Set(["pypi.org", "files.pythonhosted.org"]);

// pip negotiates application/vnd.pypi.simple.v1+json; text/html is the
// simple-API fallback. Anything else (wheel bytes!) must pass through untouched.
const SIMPLE_API_CONTENT = /^(application\/vnd\.pypi\.simple\.v\d+\+json|text\/html)\b/;

/** CORS-safelist gap that silently breaks every guest package install in a real
 *  browser: the NAT relays each guest request as a cross-origin page-context
 *  fetch, so ANY non-safelisted request header triggers a preflight (OPTIONS)
 *  that package registries reject — pypi's Access-Control-Allow-Headers is
 *  `Content-Type, If-Match, If-Modified-Since, If-None-Match, If-Unmodified-Since`
 *  only; registry.npmjs.org answers OPTIONS with 404 and no allow-headers at all
 *  (both curl-probed 2026-07-18) — the fetch is blocked, v86 returns 502, and the
 *  index/tarball is unreachable. Two classes are strippable without changing
 *  response semantics, so strip them for ALL hosts:
 *  - `Cache-Control`/`Pragma`: pip's/npm's HTTP-cache hints; a cross-origin fetch
 *    can't honor them anyway (root-caused in-browser, R13.5).
 *  - npm's telemetry/advisory decorations, present on EVERY npm 11 request
 *    (captured against a logging registry stub, npm 11.12.1 — the baked guest
 *    version): `npm-command`, `npm-auth-type`, `npm-scope` (scoped projects),
 *    `pacote-version`, `pacote-req-type`, `pacote-pkg-id`. Public-registry
 *    responses do not vary on any of them; leaving even one in makes every
 *    in-browser `npm install` fail with a NAT 502.
 *  A custom `User-Agent` does NOT preflight (Chromium-probed) — left untouched. */
const PREFLIGHT_UNSAFE_HEADERS = [
  "cache-control",
  "pragma",
  "npm-command",
  "npm-auth-type",
  "npm-scope",
  "pacote-version",
  "pacote-req-type",
  "pacote-pkg-id",
];

/** Conditional-request validators, sent on cache revalidation (npm's cacache in
 *  /root/.npm and pip's cache persist via workspace snapshots, so SECOND-session
 *  installs revalidate). Only pypi.org's preflight allows them (see the ACAH list
 *  above); registry.npmjs.org (OPTIONS 404) and files.pythonhosted.org (OPTIONS
 *  405, no allow-headers) hard-block them — Chromium-probed 2026-07-18. For every
 *  host but pypi.org, strip: a conditional GET becomes a plain GET — the same
 *  authoritative 200, minus the 304 short-cut — instead of a dead install. */
const VALIDATOR_HEADERS = ["if-none-match", "if-modified-since"];
const VALIDATOR_ALLOWED_HOSTS = new Set(["pypi.org"]);

/** Return an init whose headers omit the preflight-tripping request headers for
 *  `host`. init.headers may be a plain object, an array of pairs, or a Headers
 *  instance; `new Headers()` copies all three, so the caller's object is never
 *  mutated. If there is nothing to strip, the original init is forwarded
 *  verbatim. */
function stripPreflightRequestHeaders(init: unknown, host: string): unknown {
  const i = init as { headers?: HeadersInit } | null | undefined;
  if (!i || !i.headers) return init;
  const strip = VALIDATOR_ALLOWED_HOSTS.has(host)
    ? PREFLIGHT_UNSAFE_HEADERS
    : [...PREFLIGHT_UNSAFE_HEADERS, ...VALIDATOR_HEADERS];
  const headers = new Headers(i.headers);
  if (!strip.some((h) => headers.has(h))) return init;
  for (const h of strip) headers.delete(h);
  return { ...i, headers };
}

/** v86's NAT upgrades guest http:// to https:// by itself when the page is
 *  https-served (window.location branch in on_data_http) — only Node harnesses
 *  and http-served dev pages need the explicit upgrade. Checked per request so
 *  tests can stub `window`. */
function needsHttpsUpgrade(): boolean {
  return typeof window === "undefined" || window.location.protocol !== "https:";
}

/** Wrap the NAT's fetch. Request init is forwarded verbatim (pip's Accept
 *  negotiation must reach pypi untouched); non-pypi responses are returned
 *  as-is, body never consumed. */
export function wrapEgressFetch(realFetch: UpstreamFetch): EgressFetch {
  return async (url, init) => {
    const target = needsHttpsUpgrade() ? url.replace(/^http:\/\//, "https://") : url;
    const host = new URL(target).host;
    const safeInit = stripPreflightRequestHeaders(init, host);
    const res = await realFetch(target, safeInit); // NAT fetch errors keep the NAT's own 502 contract
    // 304 bodies are empty — nothing to rewrite, and pip's HTTP cache already
    // stores the (rewritten) page the 304 revalidates.
    if (res.status === 304) return res;
    try {
      const contentType = res.headers.get("content-type") ?? "";
      if (!PYPI_HOSTS.has(host) || !SIMPLE_API_CONTENT.test(contentType)) return res;
      const text = await res.text();
      const rewritten = text
        .replaceAll("https://files.pythonhosted.org", "http://files.pythonhosted.org")
        .replaceAll("https://pypi.org", "http://pypi.org");
      const buf = new TextEncoder().encode(rewritten);
      // body:null routes the relay to arrayBuffer(); the relay strips
      // content-length/encoding itself, so the length change is safe.
      return {
        status: res.status,
        statusText: res.statusText,
        url: res.url,
        redirected: res.redirected,
        headers: res.headers,
        body: null,
        arrayBuffer: async () => buf.buffer,
      };
    } catch (e) {
      // Fail fast and attributably: a shim failure must read as the shim's,
      // never as a mysterious upstream response.
      throw new Error(
        `egress-shim: pypi rewrite failed for ${target} (status ${res.status}): ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }
  };
}

/** Install on v86's FetchNetworkAdapter — instance-property wrap (the relay
 *  calls `this.net.fetch`). Idempotent via the marker so re-boot on a shared
 *  adapter cannot stack upgrades/rewrites. */
export function installEgressShim(adapter: { fetch: UpstreamFetch }): void {
  const current = adapter.fetch as UpstreamFetch & { [EGRESS_SHIM_MARKER]?: true };
  if (current[EGRESS_SHIM_MARKER]) return;
  const wrapped = wrapEgressFetch(current) as EgressFetch & { [EGRESS_SHIM_MARKER]?: true };
  wrapped[EGRESS_SHIM_MARKER] = true;
  (adapter as { fetch: EgressFetch }).fetch = wrapped;
}
