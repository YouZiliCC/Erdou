/** PyPI egress shim for v86's fetch-NAT (Round 13).
 *
 *  The NAT relays guest HTTP (TCP:80 only) through the adapter's instance-property
 *  `fetch`. npm needs nothing (registry.npmjs.org serves plain http; npm rewrites
 *  tarball hosts itself), but PyPI answers plain http with 403 "SSL is required"
 *  (no redirect) and its simple-API bodies link https:// wheels the NAT cannot
 *  relay (non-80 ports are refused). So: upgrade the scheme where v86 doesn't,
 *  and rewrite simple-API links to http. Proven end-to-end in the S3 spike.
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
 *  browser: pip's/npm's HTTP-cache layer adds a `Cache-Control` (and sometimes
 *  `Pragma`) REQUEST header. The NAT relays each guest request as a cross-origin
 *  page-context fetch, and neither header is CORS-safelisted, so the browser
 *  sends a preflight (OPTIONS) that package registries reject — pypi's
 *  Access-Control-Allow-Headers omits `cache-control`; npm answers OPTIONS with
 *  404 and no allow-headers at all — so the fetch is blocked, v86 returns 502,
 *  and the index/wheel is unreachable ("from versions: none"). These
 *  request-caching hints can't be honored by a cross-origin fetch anyway, so
 *  strip them for ALL hosts. Correctness is preserved: pip still revalidates via
 *  ETag/`If-None-Match`, which are CORS-safelist-conditional and CDN-allowed. */
const PREFLIGHT_UNSAFE_HEADERS = ["cache-control", "pragma"];

/** Return an init whose headers omit the preflight-tripping request headers.
 *  init.headers may be a plain object, an array of pairs, or a Headers instance;
 *  `new Headers()` copies all three, so the caller's object is never mutated. If
 *  there is nothing to strip, the original init is forwarded verbatim. */
function stripPreflightRequestHeaders(init: unknown): unknown {
  const i = init as { headers?: HeadersInit } | null | undefined;
  if (!i || !i.headers) return init;
  const headers = new Headers(i.headers);
  if (!PREFLIGHT_UNSAFE_HEADERS.some((h) => headers.has(h))) return init;
  for (const h of PREFLIGHT_UNSAFE_HEADERS) headers.delete(h);
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
    const safeInit = stripPreflightRequestHeaders(init);
    const target = needsHttpsUpgrade() ? url.replace(/^http:\/\//, "https://") : url;
    const res = await realFetch(target, safeInit); // NAT fetch errors keep the NAT's own 502 contract
    // 304 bodies are empty — nothing to rewrite, and pip's HTTP cache already
    // stores the (rewritten) page the 304 revalidates.
    if (res.status === 304) return res;
    try {
      const contentType = res.headers.get("content-type") ?? "";
      if (!PYPI_HOSTS.has(new URL(target).host) || !SIMPLE_API_CONTENT.test(contentType)) return res;
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
