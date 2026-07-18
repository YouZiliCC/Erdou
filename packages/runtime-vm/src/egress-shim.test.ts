import { describe, it, expect, afterEach } from "vitest";
import { wrapEgressFetch, installEgressShim, EGRESS_SHIM_MARKER, type UpstreamResponse } from "./egress-shim.js";

// Simple-API JSON body as pypi.org serves it: file (and PEP-658 metadata) URLs
// point at https://files.pythonhosted.org, project URLs at https://pypi.org.
const SIMPLE_JSON =
  '{"files":[{"filename":"six-1.17.0-py2.py3-none-any.whl",' +
  '"url":"https://files.pythonhosted.org/packages/b7/six-1.17.0-py2.py3-none-any.whl"}],' +
  '"meta":{"api-version":"1.3"},"project":"https://pypi.org/simple/six/"}';

const SIMPLE_HTML =
  '<a href="https://files.pythonhosted.org/packages/b7/six-1.17.0.tar.gz">six-1.17.0.tar.gz</a>';

interface FakeRes extends UpstreamResponse {
  textReads: number;
}

function fakeRes(opts: { url: string; contentType?: string; status?: number; body?: string; failText?: Error }): FakeRes {
  const res: FakeRes = {
    status: opts.status ?? 200,
    statusText: "OK",
    url: opts.url,
    redirected: false,
    headers: new Headers(opts.contentType ? { "content-type": opts.contentType } : {}),
    body: null,
    textReads: 0,
    text: async () => {
      res.textReads += 1;
      if (opts.failText) throw opts.failText;
      return opts.body ?? "";
    },
    arrayBuffer: async () => new TextEncoder().encode(opts.body ?? "").buffer,
  };
  return res;
}

function makeUpstream(res: FakeRes) {
  const calls: { url: string; init?: unknown }[] = [];
  const fetchFn = async (url: string, init?: unknown): Promise<UpstreamResponse> => {
    calls.push({ url, init });
    return res;
  };
  return { fetchFn, calls };
}

const decode = async (r: { arrayBuffer(): Promise<ArrayBufferLike> }): Promise<string> =>
  new TextDecoder().decode(new Uint8Array(await r.arrayBuffer()));

const stubWindow = (protocol: string): void => {
  (globalThis as { window?: unknown }).window = { location: { protocol } };
};

describe("egress shim: https upgrade", () => {
  afterEach(() => { delete (globalThis as { window?: unknown }).window; });

  it("upgrades http:// to https:// when there is no window (Node harness)", async () => {
    const { fetchFn, calls } = makeUpstream(fakeRes({ url: "https://registry.npmjs.org/left-pad" }));
    await wrapEgressFetch(fetchFn)("http://registry.npmjs.org/left-pad");
    expect(calls.map((c) => c.url)).toEqual(["https://registry.npmjs.org/left-pad"]);
  });

  it("does NOT upgrade on an https-served page — v86's NAT already does it (no double-upgrade)", async () => {
    stubWindow("https:");
    const { fetchFn, calls } = makeUpstream(fakeRes({ url: "http://registry.npmjs.org/left-pad" }));
    await wrapEgressFetch(fetchFn)("http://registry.npmjs.org/left-pad");
    expect(calls.map((c) => c.url)).toEqual(["http://registry.npmjs.org/left-pad"]);
  });

  it("upgrades on an http-served dev page (v86's upgrade branch is https-page-only)", async () => {
    stubWindow("http:");
    const { fetchFn, calls } = makeUpstream(fakeRes({ url: "https://pypi.org/simple/six/", contentType: "application/octet-stream" }));
    await wrapEgressFetch(fetchFn)("http://pypi.org/simple/six/");
    expect(calls.map((c) => c.url)).toEqual(["https://pypi.org/simple/six/"]);
  });
});

describe("egress shim: pypi simple-API link rewrite", () => {
  it("rewrites https pypi links to http in a simple-API JSON body", async () => {
    const res = fakeRes({
      url: "https://pypi.org/simple/six/",
      contentType: "application/vnd.pypi.simple.v1+json",
      body: SIMPLE_JSON,
    });
    const out = await wrapEgressFetch(makeUpstream(res).fetchFn)("http://pypi.org/simple/six/");
    const text = await decode(out);
    expect(text).toContain("http://files.pythonhosted.org/packages/b7/six-1.17.0-py2.py3-none-any.whl");
    expect(text).toContain("http://pypi.org/simple/six/");
    expect(text).not.toContain("https://");
    // Response-like shape the relay consumes; original headers pass through
    // (the relay itself strips content-length, so the length change is safe).
    expect(out.status).toBe(200);
    expect(out.statusText).toBe("OK");
    expect(out.url).toBe("https://pypi.org/simple/six/");
    expect(out.redirected).toBe(false);
    expect(out.headers).toBe(res.headers);
    expect(out.body).toBeNull();
  });

  it("rewrites the text/html simple-API fallback too (charset parameter tolerated)", async () => {
    const res = fakeRes({ url: "https://pypi.org/simple/six/", contentType: "text/html; charset=utf-8", body: SIMPLE_HTML });
    const out = await wrapEgressFetch(makeUpstream(res).fetchFn)("http://pypi.org/simple/six/");
    expect(await decode(out)).toContain('href="http://files.pythonhosted.org/packages/b7/six-1.17.0.tar.gz"');
  });

  it("passes non-pypi hosts through byte-identical — npm registry bodies untouched", async () => {
    const res = fakeRes({
      url: "https://registry.npmjs.org/left-pad",
      contentType: "application/json",
      body: '{"tarball":"https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz"}',
    });
    const out = await wrapEgressFetch(makeUpstream(res).fetchFn)("http://registry.npmjs.org/left-pad");
    expect(out).toBe(res); // the very same response object — body never consumed
    expect(res.textReads).toBe(0);
  });

  it("passes wheel bytes from files.pythonhosted.org through untouched (only simple-API documents rewrite)", async () => {
    const res = fakeRes({
      url: "https://files.pythonhosted.org/packages/b7/six-1.17.0-py2.py3-none-any.whl",
      contentType: "application/octet-stream",
      body: "PK...zipbytes",
    });
    const out = await wrapEgressFetch(makeUpstream(res).fetchFn)(
      "http://files.pythonhosted.org/packages/b7/six-1.17.0-py2.py3-none-any.whl",
    );
    expect(out).toBe(res);
    expect(res.textReads).toBe(0);
  });

  it("skips 304 responses — empty body, and pip's HTTP cache already stores the rewritten page", async () => {
    const res = fakeRes({ url: "https://pypi.org/simple/six/", contentType: "application/vnd.pypi.simple.v1+json", status: 304 });
    const out = await wrapEgressFetch(makeUpstream(res).fetchFn)("http://pypi.org/simple/six/");
    expect(out).toBe(res);
    expect(res.textReads).toBe(0);
  });

  it("forwards the request init verbatim (pip's Accept negotiation must reach pypi)", async () => {
    const { fetchFn, calls } = makeUpstream(fakeRes({ url: "https://pypi.org/simple/six/" }));
    const init = { method: "GET", headers: new Headers({ accept: "application/vnd.pypi.simple.v1+json" }) };
    await wrapEgressFetch(fetchFn)("http://pypi.org/simple/six/", init);
    expect(calls[0]!.init).toBe(init);
  });

  it("rethrows shim failures with context (url + cause) instead of masking them", async () => {
    const boom = new Error("boom");
    const res = fakeRes({ url: "https://pypi.org/simple/six/", contentType: "text/html", body: "x", failText: boom });
    const err = await wrapEgressFetch(makeUpstream(res).fetchFn)("http://pypi.org/simple/six/")
      .then(() => null, (e: unknown) => e as Error & { cause?: unknown });
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/egress-shim/);
    expect(err!.message).toContain("https://pypi.org/simple/six/");
    expect(err!.message).toContain("boom");
    expect(err!.cause).toBe(boom);
  });
});

describe("egress shim: strips preflight-tripping request headers (cache hints, npm telemetry, per-host validators)", () => {
  // The forwarded init.headers may be a Headers instance (after strip) or the
  // original form; normalize through Headers for assertions.
  const forwarded = (calls: { url: string; init?: unknown }[]): Headers =>
    new Headers((calls[0]!.init as { headers?: HeadersInit }).headers);

  it("strips Cache-Control + Pragma from a plain-object headers (case-insensitive), keeps the rest, and does not mutate the caller's object", async () => {
    const { fetchFn, calls } = makeUpstream(fakeRes({ url: "https://pypi.org/simple/six/" }));
    const headers = {
      Accept: "application/vnd.pypi.simple.v1+json",
      "Cache-Control": "max-age=0",
      Pragma: "no-cache",
      "If-None-Match": '"abc"',
      "X-Custom": "keep",
    };
    await wrapEgressFetch(fetchFn)("http://pypi.org/simple/six/", { method: "GET", headers });
    const h = forwarded(calls);
    expect(h.has("cache-control")).toBe(false);
    expect(h.has("pragma")).toBe(false);
    expect(h.get("accept")).toBe("application/vnd.pypi.simple.v1+json");
    expect(h.get("if-none-match")).toBe('"abc"');
    expect(h.get("x-custom")).toBe("keep");
    // caller's original object untouched
    expect(headers["Cache-Control"]).toBe("max-age=0");
    expect(headers.Pragma).toBe("no-cache");
  });

  it("strips them from a Headers instance without mutating the caller's Headers", async () => {
    const { fetchFn, calls } = makeUpstream(fakeRes({ url: "https://pypi.org/simple/six/" }));
    const headers = new Headers({ accept: "application/json", "cache-control": "no-cache", pragma: "no-cache" });
    await wrapEgressFetch(fetchFn)("http://pypi.org/simple/six/", { headers });
    const h = forwarded(calls);
    expect(h.has("cache-control")).toBe(false);
    expect(h.has("pragma")).toBe(false);
    expect(h.get("accept")).toBe("application/json");
    // caller's Headers not mutated
    expect(headers.get("cache-control")).toBe("no-cache");
    expect(headers.get("pragma")).toBe("no-cache");
  });

  it("strips them from an array-of-pairs headers, keeps the rest, and does not mutate the caller's array", async () => {
    const { fetchFn, calls } = makeUpstream(fakeRes({ url: "https://registry.npmjs.org/left-pad" }));
    const headers: [string, string][] = [
      ["accept", "*/*"],
      ["cache-control", "max-age=0"],
      ["pragma", "no-cache"],
      ["user-agent", "pip/24"],
    ];
    await wrapEgressFetch(fetchFn)("http://registry.npmjs.org/left-pad", { headers });
    const h = forwarded(calls);
    expect(h.has("cache-control")).toBe(false);
    expect(h.has("pragma")).toBe(false);
    expect(h.get("accept")).toBe("*/*");
    expect(h.get("user-agent")).toBe("pip/24");
    // caller's array untouched
    expect(headers).toHaveLength(4);
  });

  it("applies to ALL hosts, not just pypi (npm registry too — npm rejects the preflight the same way)", async () => {
    const { fetchFn, calls } = makeUpstream(fakeRes({ url: "https://registry.npmjs.org/left-pad" }));
    await wrapEgressFetch(fetchFn)("http://registry.npmjs.org/left-pad", { headers: { "Cache-Control": "no-cache" } });
    expect(forwarded(calls).has("cache-control")).toBe(false);
  });

  // npm 11.12.1 (the baked guest version) decorates EVERY install request with
  // these telemetry headers (captured against a logging registry stub); none is
  // CORS-safelisted and registry.npmjs.org rejects all preflights (OPTIONS 404,
  // no allow-headers) — leaving any one in kills every in-browser npm install.
  it("strips npm's telemetry headers (npm-command/npm-auth-type/npm-scope/pacote-*), keeps Accept + User-Agent", async () => {
    const { fetchFn, calls } = makeUpstream(fakeRes({ url: "https://registry.npmjs.org/left-pad" }));
    await wrapEgressFetch(fetchFn)("http://registry.npmjs.org/left-pad", {
      headers: {
        "user-agent": "npm/11.12.1 node/v24.17.0 linux x86 workspaces/false",
        "pacote-version": "21.5.0",
        "pacote-req-type": "packument",
        "pacote-pkg-id": "registry:left-pad",
        accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*",
        "npm-auth-type": "web",
        "npm-command": "install",
        "npm-scope": "@myorg",
      },
    });
    const h = forwarded(calls);
    for (const gone of ["npm-command", "npm-auth-type", "npm-scope", "pacote-version", "pacote-req-type", "pacote-pkg-id"]) {
      expect(h.has(gone), gone).toBe(false);
    }
    // Accept (safelisted) and User-Agent (no preflight, Chromium-probed) survive.
    expect(h.get("accept")).toBe("application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*");
    expect(h.get("user-agent")).toBe("npm/11.12.1 node/v24.17.0 linux x86 workspaces/false");
  });

  // Second-session installs revalidate (npm's cacache in /root/.npm persists via
  // workspace snapshots) — npm's OPTIONS 404 blocks the validator, so it must go:
  // an unconditional GET (same authoritative 200) instead of a dead install.
  it("strips If-None-Match/If-Modified-Since for registry.npmjs.org (preflight-rejected there)", async () => {
    const { fetchFn, calls } = makeUpstream(fakeRes({ url: "https://registry.npmjs.org/left-pad" }));
    await wrapEgressFetch(fetchFn)("http://registry.npmjs.org/left-pad", {
      headers: { "If-None-Match": '"pk1"', "If-Modified-Since": "Wed, 17 Jun 2026 09:44:09 GMT", accept: "application/json" },
    });
    const h = forwarded(calls);
    expect(h.has("if-none-match")).toBe(false);
    expect(h.has("if-modified-since")).toBe(false);
    expect(h.get("accept")).toBe("application/json");
  });

  it("strips validators for files.pythonhosted.org too (OPTIONS 405, no allow-headers)", async () => {
    const { fetchFn, calls } = makeUpstream(fakeRes({ url: "https://files.pythonhosted.org/packages/b7/six-1.17.0-py2.py3-none-any.whl" }));
    await wrapEgressFetch(fetchFn)("http://files.pythonhosted.org/packages/b7/six-1.17.0-py2.py3-none-any.whl", {
      headers: { "if-none-match": '"abc"' },
    });
    expect(forwarded(calls).has("if-none-match")).toBe(false);
  });

  it("KEEPS validators for pypi.org — its Access-Control-Allow-Headers lists the If-* family, so pip's 304 revalidation stays intact", async () => {
    const { fetchFn, calls } = makeUpstream(fakeRes({ url: "https://pypi.org/simple/six/" }));
    await wrapEgressFetch(fetchFn)("http://pypi.org/simple/six/", {
      headers: { "if-none-match": '"abc"', "if-modified-since": "Wed, 17 Jun 2026 09:44:09 GMT" },
    });
    const h = forwarded(calls);
    expect(h.get("if-none-match")).toBe('"abc"');
    expect(h.get("if-modified-since")).toBe("Wed, 17 Jun 2026 09:44:09 GMT");
  });
});

describe("installEgressShim", () => {
  it("replaces adapter.fetch with a marked wrapper and is idempotent (no double wrap)", () => {
    const { fetchFn } = makeUpstream(fakeRes({ url: "https://pypi.org/simple/six/" }));
    const adapter = { fetch: fetchFn };
    installEgressShim(adapter);
    const wrapped = adapter.fetch as typeof adapter.fetch & { [EGRESS_SHIM_MARKER]?: true };
    expect(wrapped).not.toBe(fetchFn);
    expect(wrapped[EGRESS_SHIM_MARKER]).toBe(true);
    installEgressShim(adapter);
    expect(adapter.fetch).toBe(wrapped);
  });
});
