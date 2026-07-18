#!/usr/bin/env node
/**
 * model-proxy — a thin, self-hostable CORS relay for browser → model-provider
 * API calls. A production deploy of apps/web/dist is static files with no dev
 * server, so when the provider blocks browser CORS (api.openai.com does), the
 * browser needs a same-reachable origin to talk through. This script is that
 * origin: it forwards <prefix>/* to <target>/* verbatim — method, path, query,
 * body, and headers (minus host/origin) — and answers CORS preflights itself.
 * Responses stream through unbuffered, so SSE token streams arrive live.
 *
 * It mirrors the Vite dev proxy exactly ("/llm/v1/..." → "<target>/v1/...").
 *
 * What it deliberately does NOT do:
 *   - No auth of its own: Authorization passes through untouched; the relay
 *     stores nothing. Anyone who can reach the port can relay through it —
 *     put it behind your own ingress (VPN, reverse proxy with auth, firewall).
 *   - No key storage, no request logging, no rate limiting, no retries.
 *   - No TLS termination: run it behind a TLS-terminating reverse proxy if
 *     the browser page is served over https.
 *   - No outbound-proxy support: Node core ignores http_proxy/https_proxy env
 *     vars, so the relay host needs direct egress to the provider.
 *
 * Zero dependencies; requires Node >= 22. Usage: run with --help.
 */

import http from "node:http";
import https from "node:https";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const HELP = `model-proxy — self-hostable CORS relay for browser → model-provider API calls

Usage:
  node scripts/model-proxy.mjs --target <base-url> [--port <n>] [--prefix <path>]

Options:
  --target    Upstream base URL, e.g. https://api.openai.com (required).
              May include a base path (https://host/v1) which is prepended.
  --port      Local port to listen on (default: 8788)
  --prefix    Path prefix stripped before forwarding (default: /llm)
  -h, --help  Show this help

Example:
  node scripts/model-proxy.mjs --target https://api.openai.com
  # browser → http://localhost:8788/llm/v1/chat/completions
  # relay   → https://api.openai.com/v1/chat/completions

The relay stores nothing and adds no auth — put it behind your own ingress.`;

/**
 * Hop-by-hop headers (RFC 9110 §7.6.1) are connection-scoped and must not be
 * forwarded; Node manages its own connection framing on both legs. "expect" is
 * also dropped: our server auto-answers 100-continue, and forwarding it can
 * stall the upstream leg waiting for a continue we never relay.
 */
const DROP_REQUEST_HEADERS = new Set([
  "host", // http.request derives the correct host from the upstream URL
  "origin", // the point of the relay: the upstream never sees the browser origin
  "connection", "keep-alive", "proxy-connection", "proxy-authenticate",
  "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
  "expect",
]);
const DROP_RESPONSE_HEADERS = new Set([
  "connection", "keep-alive", "trailer", "transfer-encoding", "upgrade",
]);

/**
 * Parse and validate CLI argv (the slice after `node script.mjs`). Unknown
 * flags, a missing --target, a malformed URL/port/prefix all throw an Error
 * with a precise message — never a silent default. Returns
 * `{ help: true }` or `{ target, port, prefix }` with target/prefix normalized
 * (no trailing slash).
 */
export function parseCliArgs(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        target: { type: "string" },
        port: { type: "string", default: "8788" },
        prefix: { type: "string", default: "/llm" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw new Error(err.message); // parseArgs errors carry the offending flag
  }
  if (values.help) return { help: true };

  if (values.target === undefined) {
    throw new Error("--target is required (e.g. --target https://api.openai.com)");
  }
  const target = normalizeTarget(values.target);

  if (!/^\d+$/.test(values.port)) {
    throw new Error(`--port must be an integer, got: ${values.port}`);
  }
  const port = Number(values.port);
  if (port > 65535) {
    throw new Error(`--port must be 0-65535, got: ${port}`);
  }

  const prefix = normalizePrefix(values.prefix);
  return { target, port, prefix };
}

/**
 * Validate the upstream base URL and normalize it to `origin + pathname`
 * without a trailing slash, so `base + "/v1/x"` concatenates cleanly.
 * Rejects non-http(s) schemes and query/fragment (there is no meaningful way
 * to merge those with per-request paths — error instead of guessing).
 */
export function normalizeTarget(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--target is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`--target must be http(s), got: ${url.protocol}//`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error(`--target must not have a query string or fragment: ${raw}`);
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/**
 * Normalize the mount prefix: must start with "/" and contain no query or
 * fragment characters. Trailing slashes are stripped; "/" normalizes to ""
 * (mount at root: every path forwards).
 */
export function normalizePrefix(raw) {
  if (!/^\/[^?#]*$/.test(raw)) {
    throw new Error(`--prefix must start with "/" and contain no "?" or "#", got: ${raw}`);
  }
  return raw.replace(/\/+$/, "");
}

/**
 * Split `prefix` off the front of a raw request url ("/llm/v1/x?q=1" →
 * "/v1/x?q=1"). Returns null when the url is outside the prefix — including
 * lookalikes ("/llmfoo"): the boundary after the prefix must be "/", "?", or
 * end-of-string. The bare prefix itself maps to the target root ("/").
 */
export function splitPrefix(url, prefix) {
  if (prefix === "") return url; // mounted at root
  if (url === prefix) return "/";
  if (!url.startsWith(prefix)) return null;
  const boundary = url[prefix.length];
  if (boundary === "/") return url.slice(prefix.length);
  if (boundary === "?") return "/" + url.slice(prefix.length);
  return null;
}

/**
 * Permissive CORS. allow-origin is "*": the relay is origin-agnostic by
 * design (Authorization is a plain header, not a CORS "credential", so "*"
 * suffices for bearer-token API calls). Preflights echo the requested headers
 * because the "*" wildcard in allow-headers does not cover Authorization.
 */
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "*",
};

function preflightHeaders(req) {
  return {
    ...CORS_HEADERS,
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers":
      req.headers["access-control-request-headers"] ?? "authorization, content-type",
    "access-control-max-age": "86400",
  };
}

function filterHeaders(headers, drop) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!drop.has(name)) out[name] = value;
  }
  return out;
}

/**
 * Build the relay server (not yet listening). `target` and `prefix` must
 * already be normalized (use parseCliArgs / normalizeTarget / normalizePrefix).
 *
 * Both legs stream: the client body pipes into the upstream request and the
 * upstream response pipes back out, so chunked/SSE bodies pass through as
 * they arrive. Upstream HTTP errors (4xx/5xx) pass through verbatim — only a
 * transport failure (refused/reset/DNS) becomes a 502 carrying the error text.
 */
export function createProxyServer({ target, prefix = "/llm" }) {
  const targetBase = normalizeTarget(target); // re-validate: fail here, not per-request
  const httpModule = targetBase.startsWith("https:") ? https : http;

  return http.createServer((req, res) => {
    // All OPTIONS are treated as CORS preflights: model APIs do not use
    // OPTIONS as a data method, and answering locally is the relay's job.
    if (req.method === "OPTIONS") {
      res.writeHead(204, preflightHeaders(req));
      res.end();
      return;
    }

    const rest = splitPrefix(req.url, prefix);
    if (rest === null) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", ...CORS_HEADERS });
      res.end(`model-proxy: ${req.url} is outside the mount prefix ${prefix}/ — nothing is forwarded\n`);
      return;
    }

    const upstreamUrl = targetBase + rest;
    const upstreamReq = httpModule.request(upstreamUrl, {
      method: req.method,
      headers: filterHeaders(req.headers, DROP_REQUEST_HEADERS),
    }, (upstreamRes) => {
      res.writeHead(
        upstreamRes.statusCode,
        upstreamRes.statusMessage,
        // CORS keys overwrite same-named upstream keys (both lowercase), so a
        // provider's own allow-origin can never duplicate ours.
        { ...filterHeaders(upstreamRes.headers, DROP_RESPONSE_HEADERS), ...CORS_HEADERS },
      );
      // Upstream socket death mid-response fires "error" on upstreamRes, NOT
      // on upstreamReq — pipe() reacts by silently unpiping, which would leave
      // the client connection open forever with no data and no end. Killing
      // the client connection is the only honest signal once the status line
      // is already on the wire.
      upstreamRes.on("error", () => res.destroy());
      upstreamRes.pipe(res);
    });

    upstreamReq.on("error", (err) => {
      if (res.headersSent) {
        // Mid-stream failure: the status is already on the wire — the only
        // honest signal left is killing the connection.
        res.destroy();
        return;
      }
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8", ...CORS_HEADERS });
      res.end(`model-proxy: upstream request to ${upstreamUrl} failed: ${err.message}\n`);
    });

    // Client gone (tab closed, fetch aborted) → abort the upstream leg so a
    // cancelled SSE stream doesn't keep burning provider tokens.
    res.on("close", () => upstreamReq.destroy());
    req.on("error", () => upstreamReq.destroy());

    req.pipe(upstreamReq);
  });
}

function main() {
  let args;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`model-proxy: ${err.message}\nRun with --help for usage.\n`);
    process.exit(1);
  }
  if (args.help) {
    process.stdout.write(HELP + "\n");
    return;
  }

  const server = createProxyServer(args);
  server.on("error", (err) => {
    process.stderr.write(`model-proxy: cannot listen on port ${args.port}: ${err.message}\n`);
    process.exit(1);
  });
  server.listen(args.port, () => {
    const { port } = server.address();
    process.stdout.write(
      `model-proxy: http://localhost:${port}${args.prefix}/* → ${args.target}/*\n` +
      `model-proxy: no auth, no key storage — put this behind your own ingress\n`,
    );
  });
}

// Run only when invoked directly (`node scripts/model-proxy.mjs ...`), not
// when imported by the test file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
