/**
 * Hermetic tests for model-proxy: a mock upstream http server and the proxy
 * both listen on ephemeral loopback ports — no network, no deps. Run with:
 *
 *   node --test scripts/model-proxy.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { createProxyServer, parseCliArgs } from "./model-proxy.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./model-proxy.mjs", import.meta.url));

/** Listen on an ephemeral loopback port; resolves with the port. */
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

/** Close a server without waiting out keep-alive sockets. */
function closeServer(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

/**
 * Mock upstream: records every fully-received request (method/url/headers/
 * body) in `seen`, then hands off to `handler(record, res)` to write the
 * response.
 */
function createUpstream(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const record = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      };
      seen.push(record);
      handler(record, res);
    });
  });
  return { server, seen };
}

/**
 * Raw http request (agent: false so no keep-alive socket outlives the test).
 * Buffers the response — fine for every test except the streaming one, which
 * listens to "data" events itself.
 */
function rawRequest(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method, headers, agent: false },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** Spin up upstream + proxy wired together; auto-closed via t.after. */
async function setup(t, upstreamHandler, { targetPath = "", prefix = "/llm" } = {}) {
  const { server: upstream, seen } = createUpstream(upstreamHandler);
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer({ target: `http://127.0.0.1:${upstreamPort}${targetPath}`, prefix });
  const proxyPort = await listen(proxy);
  t.after(() => closeServer(proxy));
  t.after(() => closeServer(upstream));
  return { proxyPort, upstreamPort, seen };
}

// ---------------------------------------------------------------- CLI parsing

test("parseCliArgs: missing --target fails loudly", () => {
  assert.throws(() => parseCliArgs([]), /--target is required/);
});

test("parseCliArgs: malformed target URL fails loudly", () => {
  assert.throws(() => parseCliArgs(["--target", "not a url"]), /not a valid URL/);
  assert.throws(() => parseCliArgs(["--target", "ftp://x"]), /must be http\(s\)/);
  assert.throws(() => parseCliArgs(["--target", "https://x/v1?q=1"]), /query string/);
});

test("parseCliArgs: bad port fails loudly", () => {
  assert.throws(() => parseCliArgs(["--target", "https://x", "--port", "abc"]), /--port must be an integer/);
  assert.throws(() => parseCliArgs(["--target", "https://x", "--port=-1"]), /--port must be an integer/);
  assert.throws(() => parseCliArgs(["--target", "https://x", "--port", "70000"]), /--port must be 0-65535/);
});

test("parseCliArgs: unknown flag fails loudly", () => {
  assert.throws(() => parseCliArgs(["--target", "https://x", "--bogus"]), /--bogus/);
});

test("parseCliArgs: bad prefix fails loudly", () => {
  assert.throws(() => parseCliArgs(["--target", "https://x", "--prefix", "llm"]), /--prefix must start/);
});

test("parseCliArgs: defaults and normalization", () => {
  const args = parseCliArgs(["--target", "https://api.openai.com/"]);
  assert.deepEqual(args, { target: "https://api.openai.com", port: 8788, prefix: "/llm" });
});

// ----------------------------------------------------------------- forwarding

test("forwards method, path, query, body, headers; strips host/origin; adds CORS", async (t) => {
  const { proxyPort, upstreamPort, seen } = await setup(t, (record, res) => {
    res.writeHead(200, { "content-type": "application/json", "x-upstream": "yes" });
    res.end('{"ok":true}');
  });

  const body = '{"model":"gpt-4o","stream":true}';
  const res = await rawRequest(proxyPort, {
    method: "POST",
    path: "/llm/v1/chat/completions?stream=true",
    headers: {
      authorization: "Bearer sk-test-123",
      "content-type": "application/json",
      "x-custom": "erdou",
      origin: "http://localhost:5173",
    },
    body,
  });

  assert.equal(seen.length, 1);
  const fwd = seen[0];
  assert.equal(fwd.method, "POST");
  assert.equal(fwd.url, "/v1/chat/completions?stream=true"); // prefix stripped, query kept
  assert.equal(fwd.body, body);
  assert.equal(fwd.headers.authorization, "Bearer sk-test-123"); // untouched passthrough
  assert.equal(fwd.headers["content-type"], "application/json");
  assert.equal(fwd.headers["x-custom"], "erdou");
  assert.equal(fwd.headers.origin, undefined); // upstream never sees the browser origin
  assert.equal(fwd.headers.host, `127.0.0.1:${upstreamPort}`); // rewritten to the target

  assert.equal(res.status, 200);
  assert.equal(res.body, '{"ok":true}');
  assert.equal(res.headers["x-upstream"], "yes"); // upstream headers pass through
  assert.equal(res.headers["access-control-allow-origin"], "*"); // CORS added
});

test("target base path is prepended to the forwarded path", async (t) => {
  const { proxyPort, seen } = await setup(
    t,
    (record, res) => res.end("ok"),
    { targetPath: "/v1" },
  );
  await rawRequest(proxyPort, { path: "/llm/models" });
  assert.equal(seen[0].url, "/v1/models");
});

test("paths outside the prefix 404 without touching upstream", async (t) => {
  const { proxyPort, seen } = await setup(t, (record, res) => res.end("ok"));
  const other = await rawRequest(proxyPort, { path: "/other" });
  assert.equal(other.status, 404);
  assert.match(other.body, /outside the mount prefix/);
  const lookalike = await rawRequest(proxyPort, { path: "/llmfoo" }); // boundary check
  assert.equal(lookalike.status, 404);
  assert.equal(seen.length, 0);
});

// ----------------------------------------------------------------------- CORS

test("preflight OPTIONS is answered locally, upstream untouched", async (t) => {
  const { proxyPort, seen } = await setup(t, (record, res) => res.end("ok"));
  const res = await rawRequest(proxyPort, {
    method: "OPTIONS",
    path: "/llm/v1/chat/completions",
    headers: {
      origin: "http://localhost:5173",
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization, content-type",
    },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers["access-control-allow-origin"], "*");
  assert.match(res.headers["access-control-allow-methods"], /POST/);
  assert.equal(res.headers["access-control-allow-headers"], "authorization, content-type"); // echoed
  assert.equal(seen.length, 0);
});

// ------------------------------------------------------------------ streaming

test("streams chunks as they arrive (no buffering)", { timeout: 5000 }, async (t) => {
  // The upstream sends chunk one, then WAITS until the client has observed it
  // before sending chunk two. A buffering proxy would deadlock here (client
  // sees nothing until end; end never comes until the gate opens) and trip
  // the test timeout — arrival of chunk one alone proves live passthrough.
  let openGate;
  const gate = new Promise((resolve) => (openGate = resolve));
  const { proxyPort } = await setup(t, async (record, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: one\n\n");
    await gate;
    res.write("data: two\n\n");
    res.end();
  });

  const full = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: proxyPort, path: "/llm/v1/stream", agent: false },
      (res) => {
        let acc = "";
        res.on("data", (chunk) => {
          acc += chunk.toString();
          if (acc.includes("one") && !acc.includes("two")) openGate();
        });
        res.on("end", () => resolve(acc));
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(full, "data: one\n\ndata: two\n\n");
});

// ------------------------------------------------------------------ https leg

// Self-signed cert for 127.0.0.1 (SAN IP, expires 2126) so the https upstream
// leg is testable hermetically. The relay child process trusts it via
// NODE_EXTRA_CA_CERTS — additive trust, no verification bypass.
const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCL77pexUsafQeT
7XQm/nmCBB5Sf2A26n7qQXN+N/eDk8rSIfEjuBdP4ne+9F+Zh3+6Oa+h87eMmKMR
6GjGlISYnDO1T4HNRR81HSkxlN1XHtrgNfbXm9zRsyTWuBfti2WwXWqHrFnRIJ4q
PZKVzTxuKi/02ceFvMFkGXVZzsjoO9LKxiAor4/2nLtxndUoAUURoJrJZtOE7NGb
djGi4CPqmyWlDB389paP3XInfhmJMW2sGhXyacEeKlCwbRIVqRtH9LVTeCe/8XlO
4pUfguVj6V3pO+sXRv3x/T66RrIrfoPa4TpUnLU/3OIe8zb5/SXfEtW+CvDdwIug
YShoPbkVAgMBAAECggEAG3f41P6UYgQ19xcu7DKapmdpjlcbi1wXgqNLaPTSfL0H
nJz2CUVrKg6x48VzeJ8s9uC49ajyGEKkC/Fbk9N2fcB3s/kB6UnOuO3a9rUah63y
V/2v0R3yyCUKr61eYQ4ybV7A+RXfYZouAeupOQea+6MDW+Rd8oYdTiljLDhXnqJJ
OtLXW07WCGsj1jKrQxYZUzihjiNNHJlqMzR28oj46twsqtTJglIgTLJL0Mr9YvRU
p9HpqZztlDynU4Gj/YDd2s9VjHVZF/AUWuu9jFGi8PaEEcd+4LjHFMf55btAV4Md
+CbOhTr5vi+swkeSbQYn5PrJLN2RdOQDyTp00+R5xwKBgQDF0nHjCZx6SHyoxGbx
Wl7g6T/vMrAGsEVGp7DFKgE52EpwuDthV1Ghm+Tb+qhUxm6TacdgDOgnfn6GfB6E
iWWCXynnUdEnXPQskoOHkvMEhX76WyZ2+WP4DC0m1GO0sVAS8Q/pwvWsSGialK1+
U75OT5xWEhXKRUNEOyHLJQsM5wKBgQC1FzZGsK/bnh9Z+wWwRx1u2PLgw/BlGGwl
ZsxbEeGfJHjQaA4mj6mUxW8Cd7i4rD2DJSD7Qaj6UrlhT0gV6GwqbC0m5xQNDBLv
U5Zf8VSfLYcdDesYCVE92Dhf0khRbdCGUfKIrOzVdoFxt++Fg+CE2r1tnqFBzzG8
a8KFs6UuowKBgAO4xt2/o4sFbBr8vvcRfTF8EfDdIkSt8k+2/fNnq+g7soLWZH+b
VfTVawPcfmhB53ish8y90WxUy+qZ0TUrJJbEVZR9jJLSA+IGy6S0VhAittXc+ydH
3+Kd0Aen/Uw7/catdGAwg9C++ADYhT8YMj9k7gsMgg5xKSfSePtKch/HAoGAD1Gv
XbuEpOdzb4E0sfzSGJZxtWHd7C9stp1DnFCe7X+AWOD0kX6Fsfghs+u8zKKFcZqq
d5bOXJ6y3/B9AJ1wyQXtq+TQZWooD+baSbN4nR6U13hd8uKW5MxtuG1pgLnxcets
wPMf9c7YlG4i7QCC9borXCKXMaH9axsSkYzo5FECgYBAn3C8Yh5GR9BkDqSECOF0
q9C2m90a0tmj+iG9sXR0MQOsf1dTAeFYV+a5/E/wfOIWy+vMUG0xTOW+yuENuytw
6Doy079xqElKvLBsmStHep5pgfvKa7lgju3yQX+zCzjZoc7eDM3hQ20Oc+rz9ppg
/a6r83zYY+9DczEcAP1gwA==
-----END PRIVATE KEY-----`;
const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDHDCCAgSgAwIBAgIUS1EoGiUMXNCa4neg6CsKBv0hyYEwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMCAXDTI2MDcxODA4MDg0N1oYDzIxMjYw
NjI0MDgwODQ3WjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCL77pexUsafQeT7XQm/nmCBB5Sf2A26n7qQXN+N/eD
k8rSIfEjuBdP4ne+9F+Zh3+6Oa+h87eMmKMR6GjGlISYnDO1T4HNRR81HSkxlN1X
HtrgNfbXm9zRsyTWuBfti2WwXWqHrFnRIJ4qPZKVzTxuKi/02ceFvMFkGXVZzsjo
O9LKxiAor4/2nLtxndUoAUURoJrJZtOE7NGbdjGi4CPqmyWlDB389paP3XInfhmJ
MW2sGhXyacEeKlCwbRIVqRtH9LVTeCe/8XlO4pUfguVj6V3pO+sXRv3x/T66RrIr
foPa4TpUnLU/3OIe8zb5/SXfEtW+CvDdwIugYShoPbkVAgMBAAGjZDBiMB0GA1Ud
DgQWBBQhmBIC0TkPR7hjoaZNfOyNC78nwzAfBgNVHSMEGDAWgBQhmBIC0TkPR7hj
oaZNfOyNC78nwzAPBgNVHRMBAf8EBTADAQH/MA8GA1UdEQQIMAaHBH8AAAEwDQYJ
KoZIhvcNAQELBQADggEBADiVyGKtzm10CWMecT2kDyoM8UrVLr8FiezpXphJ5rh2
6qo8KUkZ6ctD6X0zxJWXWeU592amKXEJv9DJtLpJJnaU+fgGqRzIC0ux6qLkUhTE
MCC88s0oT2CDC0zrWL1m5MUGB1vjd0G7ZPOvBKJK5FdEvgoXjj3bDzNwYflylwTA
2002EbENemqFdLk2fuy6D5RFH1zhEQMHADEUU4D5/CqRgu9otQNNP0W1zYiz1t7v
hYC58LOstRl4vob9/UmtZkxpMEwiBPFXu0tmnbWa+uRk01xt+iDIgMWcsFJyLJcn
PgwkCUOfK9mZzDaCKeLsEQCniWpQ+OUtJaE693NdyE4=
-----END CERTIFICATE-----`;

test("https target: real CLI process relays through TLS", { timeout: 10000 }, async (t) => {
  // End-to-end through the actual CLI entrypoint: spawned child, --port 0,
  // banner parsed for the bound port, https upstream on loopback.
  const seen = [];
  const upstream = https.createServer({ key: TLS_KEY, cert: TLS_CERT }, (req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("tls-ok");
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const dir = await mkdtemp(join(tmpdir(), "model-proxy-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const caPath = join(dir, "ca.pem");
  await writeFile(caPath, TLS_CERT);

  const child = spawn(
    process.execPath,
    [SCRIPT_PATH, "--target", `https://127.0.0.1:${upstreamPort}`, "--port", "0"],
    { env: { ...process.env, NODE_EXTRA_CA_CERTS: caPath }, stdio: ["ignore", "pipe", "inherit"] },
  );
  t.after(() => child.kill());

  let banner = "";
  while (!/localhost:(\d+)/.test(banner)) {
    const [chunk] = await once(child.stdout, "data");
    banner += chunk.toString();
  }
  const proxyPort = Number(banner.match(/localhost:(\d+)/)[1]);

  const res = await rawRequest(proxyPort, {
    path: "/llm/v1/models",
    headers: { authorization: "Bearer sk-tls" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body, "tls-ok");
  assert.equal(res.headers["access-control-allow-origin"], "*");
  assert.deepEqual(seen, [{ url: "/v1/models", authorization: "Bearer sk-tls" }]);
});

// --------------------------------------------------------------------- errors

test("upstream 5xx passes through as-is, not rewritten to 502", async (t) => {
  const { proxyPort } = await setup(t, (record, res) => {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("upstream exploded");
  });
  const res = await rawRequest(proxyPort, { path: "/llm/v1/models" });
  assert.equal(res.status, 500);
  assert.equal(res.body, "upstream exploded");
  assert.equal(res.headers["access-control-allow-origin"], "*"); // CORS even on errors
});

test("dead upstream becomes a 502 carrying the connection error", async (t) => {
  // Grab a loopback port that is definitely closed: listen, note it, close.
  const probe = http.createServer();
  const deadPort = await listen(probe);
  await closeServer(probe);

  const proxy = createProxyServer({ target: `http://127.0.0.1:${deadPort}`, prefix: "/llm" });
  const proxyPort = await listen(proxy);
  t.after(() => closeServer(proxy));

  const res = await rawRequest(proxyPort, { path: "/llm/v1/models" });
  assert.equal(res.status, 502);
  assert.match(res.body, /model-proxy: upstream request to http:\/\/127\.0\.0\.1:\d+\/v1\/models failed/);
  assert.match(res.body, /ECONNREFUSED/); // the real upstream error text, not a vague message
  assert.equal(res.headers["access-control-allow-origin"], "*");
});

test("upstream socket death mid-response kills the client connection (no hang)", { timeout: 5000 }, async (t) => {
  // Gated like the streaming test so the kill is deterministically MID-stream:
  // the upstream sends headers + one SSE chunk, waits until the client has
  // observed that chunk (proving both hops' headers are on the wire), then
  // destroys its raw socket. That failure fires "error" on the upstream
  // *response* stream, not the request, so without explicit propagation
  // pipe() silently unpipes and the client hangs forever — this test would
  // trip its timeout. The client must observe an abrupt response error; a
  // clean "end" would disguise the truncation as a complete response.
  let killUpstream;
  const clientGotChunk = new Promise((resolve) => (killUpstream = resolve));
  const { proxyPort } = await setup(t, async (record, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: one\n\n");
    await clientGotChunk;
    res.socket.destroy();
  });

  const outcome = await new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: proxyPort, path: "/llm/v1/stream", agent: false },
      (res) => {
        res.on("data", () => killUpstream());
        res.on("end", () => resolve("clean-end"));
        res.on("error", () => resolve("response-error"));
      },
    );
    req.on("error", () => resolve("request-error"));
    req.end();
  });
  assert.equal(outcome, "response-error");
});
