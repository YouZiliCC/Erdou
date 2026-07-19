import { describe, it, expect } from "vitest";
import type { RuntimeEvent, HttpResponse } from "@erdou/runtime-contract";
import { VmRuntime } from "./vm-runtime.js";
import { assetsPresent, defaultAssets, loadNodeInputs } from "./node.js";
import type { VmProfile } from "./profiles.js";

// ERDOU_NET_E2E — real package installs through the v86 fetch-NAT against LIVE
// registries (pypi.org, registry.npmjs.org). Node-legged: the sandbox's headless
// Chromium runs with --no-proxy-server, so egress only works from Node. Gated on
// BOTH ERDOU_NET_E2E=1 AND the per-profile baked image being present, so the
// default `pnpm test` reports these as VISIBLE skips, never as failures (M13).
//
// The egress shim (installed in V86Host.boot) rewrites pypi simple-API links
// https:// -> http:// and upgrades http:// -> https:// in the Node context; the
// baked /etc/pip.conf (index-url + trusted-host + break-system-packages) and
// /root/.npmrc (registry) mean NO extra install flags are needed. HOME=/root is
// baked into guestd's exec env, so pip user-site + npm land under /root.
const NET = process.env.ERDOU_NET_E2E === "1";
const gate = (profile: VmProfile): boolean => NET && assetsPresent(profile);
const inputsFor = (profile: VmProfile) => () => loadNodeInputs(defaultAssets(profile));

/** Run a terminating guest command to completion; return exit + drained streams. */
async function run(
  rt: VmRuntime,
  cmd: string,
  opts?: { cwd?: string; env?: Record<string, string> },
): Promise<{ code: number; signal: string | null; out: string; err: string }> {
  const p = await rt.exec(cmd, opts);
  const [out, err, status] = await Promise.all([p.stdout.text(), p.stderr.text(), p.wait()]);
  return { code: status.code, signal: status.signal, out, err };
}

const waitForEvent = async (
  events: RuntimeEvent[],
  pred: (e: RuntimeEvent) => boolean,
  ms: number,
): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (events.some(pred)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`waitForEvent: condition not met within ${ms}ms`);
};

const secs = (t0: number): string => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

// (a) base image — real pip install via the baked pip.conf + egress link-rewrite.
describe.skipIf(!gate("base"))("net.e2e — base image · pip", () => {
  it("pip install six==1.17.0 (baked pip.conf, shim link-rewrite) → import OK", async () => {
    const t0 = Date.now();
    const rt = new VmRuntime(inputsFor("base"));
    try {
      await rt.boot();
      const install = await run(rt, "pip install six==1.17.0");
      if (install.code !== 0) {
        throw new Error(`pip install six failed (code ${install.code})\nSTDOUT:\n${install.out}\nSTDERR:\n${install.err}`);
      }
      const imp = await run(rt, `python3 -c "import six; print('SIX_OK', six.__version__)"`);
      if (imp.code !== 0) throw new Error(`import six failed (code ${imp.code})\nSTDERR:\n${imp.err}`);
      expect(imp.out).toContain("SIX_OK");
      expect(imp.out).toContain("1.17.0");
    } finally {
      console.log(`[net.e2e] pip six==1.17.0: ${secs(t0)}`);
      await rt.shutdown();
    }
  }, 180_000);
});

// (b) node image — real npm install via the baked /root/.npmrc (npm needs no shim).
describe.skipIf(!gate("node"))("net.e2e — node image · npm", () => {
  it("npm install left-pad@1.3.0 (baked .npmrc) → require OK", async () => {
    const t0 = Date.now();
    const rt = new VmRuntime(inputsFor("node"));
    try {
      await rt.boot();
      await run(rt, "mkdir -p /root/proj");
      const install = await run(rt, "cd /root/proj && npm install left-pad@1.3.0 --no-audit --no-fund");
      if (install.code !== 0) {
        throw new Error(`npm install left-pad failed (code ${install.code})\nSTDOUT:\n${install.out}\nSTDERR:\n${install.err}`);
      }
      const req = await run(rt, `cd /root/proj && node -e "console.log('LEFTPAD', require('left-pad')(42,5,'0'))"`);
      if (req.code !== 0) throw new Error(`require left-pad failed (code ${req.code})\nSTDERR:\n${req.err}`);
      expect(req.out).toContain("LEFTPAD 00042");
    } finally {
      console.log(`[net.e2e] npm left-pad@1.3.0: ${secs(t0)}`);
      await rt.shutdown();
    }
  }, 180_000);
});

// (c) THE acceptance loop — pip-install a real web framework, run it, and reverse
// -proxy a live request into it via the runtime's dispatch(). Proves the whole
// chain: fetch-NAT egress → pip → Flask serving 0.0.0.0 → port watcher → dispatch.
describe.skipIf(!gate("base"))("net.e2e — acceptance loop · pip Flask → dispatch", () => {
  it("pip install flask → serve on 0.0.0.0:8000 → dispatch returns the rendered marker", async () => {
    const t0 = Date.now();
    const rt = new VmRuntime(inputsFor("base"));
    const events: RuntimeEvent[] = [];
    try {
      await rt.boot();
      rt.subscribe((e) => events.push(e));
      const install = await run(rt, "pip install flask==3.1.3");
      if (install.code !== 0) {
        throw new Error(`pip install flask failed (code ${install.code})\nSTDOUT:\n${install.out}\nSTDERR:\n${install.err}`);
      }
      const MARKER = "ERDOU_FLASK_MARKER_9f3a2c";
      const appPy = [
        "from flask import Flask",
        "app = Flask(__name__)",
        "@app.get('/')",
        "def index():",
        `    return ${JSON.stringify(MARKER)}`,
        "app.run(host='0.0.0.0', port=8000)",
        "",
      ].join("\n");
      await rt.writeFile("/root/app.py", appPy);
      // Detached: exec resolves on process START; Flask binds after import+startup.
      await rt.exec("python3 /root/app.py");
      await waitForEvent(events, (e) => e.type === "port.opened" && e.port === 8000, 90_000);
      let resp: HttpResponse | undefined;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const r = await rt.dispatch(8000, { method: "GET", url: "/", headers: {}, body: new Uint8Array() });
        if (r.status === 200) { resp = r; break; }
        await new Promise((res) => setTimeout(res, 1000));
      }
      expect(resp, "no 200 response from Flask within 30s of port.opened").toBeDefined();
      expect(new TextDecoder().decode(resp!.body)).toContain(MARKER);
    } finally {
      console.log(`[net.e2e] pip flask → dispatch: ${secs(t0)}`);
      await rt.shutdown();
    }
  }, 300_000);
});

// (e) SSE acceptance — a real Flask event-stream through the two-phase
// dispatch: the dispatch resolves at HEAD-time (while the guest generator is
// still sleeping between events) and body chunks arrive PROGRESSIVELY over the
// live guest connection, ending when the stream completes.
describe.skipIf(!gate("base"))("net.e2e — SSE streaming · pip Flask → dispatch stream", () => {
  it("Flask Response(gen, mimetype='text/event-stream') → head-first dispatch + progressive chunks", async () => {
    const t0 = Date.now();
    const rt = new VmRuntime(inputsFor("base"));
    const events: RuntimeEvent[] = [];
    try {
      await rt.boot();
      rt.subscribe((e) => events.push(e));
      const install = await run(rt, "pip install flask==3.1.3");
      if (install.code !== 0) {
        throw new Error(`pip install flask failed (code ${install.code})\nSTDOUT:\n${install.out}\nSTDERR:\n${install.err}`);
      }
      const appPy = [
        "from flask import Flask, Response",
        "import time",
        "app = Flask(__name__)",
        "@app.get('/')",
        "def index():",
        "    return 'ok'",
        "@app.get('/events')",
        "def events():",
        "    def gen():",
        "        for i in range(5):",
        "            yield f'data: tick-{i}\\n\\n'",
        "            time.sleep(0.3)",
        "    return Response(gen(), mimetype='text/event-stream')",
        "app.run(host='0.0.0.0', port=8000)",
        "",
      ].join("\n");
      await rt.writeFile("/root/sse_app.py", appPy);
      await rt.exec("python3 /root/sse_app.py"); // detached: exec resolves on START
      await waitForEvent(events, (e) => e.type === "port.opened" && e.port === 8000, 90_000);
      // Wait until the server actually answers (buffered route — unchanged path).
      let up = false;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const r = await rt.dispatch(8000, { method: "GET", url: "/", headers: {}, body: new Uint8Array() });
        if (r.status === 200) { up = true; expect(r.stream).toBeUndefined(); break; }
        await new Promise((res) => setTimeout(res, 1000));
      }
      expect(up, "Flask did not answer GET / within 30s of port.opened").toBe(true);

      const res = await rt.dispatch(8000, { method: "GET", url: "/events", headers: {}, body: new Uint8Array() });
      const headAt = Date.now();
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/event-stream");
      expect(res.body.length).toBe(0);
      expect(res.stream, "SSE dispatch must resolve with a stream").toBeDefined();
      // Framing headers must be stripped whatever wire framing Werkzeug chose.
      expect(res.headers["content-length"]).toBeUndefined();
      expect(res.headers["transfer-encoding"]).toBeUndefined();

      const arrivals: Array<{ text: string; atMs: number }> = [];
      for await (const chunk of res.stream!) {
        arrivals.push({ text: new TextDecoder().decode(chunk), atMs: Date.now() - headAt });
      }
      const all = arrivals.map((a) => a.text).join("");
      expect(all).toContain("tick-0");
      expect(all).toContain("tick-4"); // the stream ran to completion
      // PROGRESSIVE, not buffered: the producer sleeps 0.3s between the 5
      // events (~1.2s total past the head). A buffered path could not have
      // resolved dispatch until all of it was in — so the LAST chunk arriving
      // well after the head we already held proves streaming; and the head
      // resolving before the body finished is the head-first proof.
      expect(arrivals.length).toBeGreaterThanOrEqual(2);
      expect(arrivals[arrivals.length - 1]!.atMs).toBeGreaterThan(600);
    } finally {
      console.log(`[net.e2e] flask SSE → dispatch stream: ${secs(t0)}`);
      await rt.shutdown();
    }
  }, 300_000);
});

// (f) WebSocket acceptance — a real RFC6455 upgrade + frames against a
// pure-node WS server INSIDE the guest, through the contract's
// `Runtime.upgrade`. Needs NO network egress (the guest server has zero
// deps), so it is gated like the vm e2e suite — ERDOU_VM_E2E=1 (or the NET
// gate) + the node image — and proves the whole chain the ws spike proved
// raw: probe → guest TCP conn → 101 + Sec-WebSocket-Accept + subprotocol →
// masked frames BOTH directions incl. binary >125 bytes (16-bit lengths) →
// unsolicited guest push → an 11s-idle conn stays live (no dispatch-style
// idle/cap timers) → clean close handshake.
const WS_GATE = (process.env.ERDOU_VM_E2E === "1" || NET) && assetsPresent("node");

// Hand-rolled guest server (no npm deps): upgrade + accept + first-offered
// subprotocol; echoes text as `echo:<text>` and binary verbatim; pushes
// `push-1` unsolicited after 2s; echoes a Close frame with code 1000.
const GUEST_WS_SRC = `
const http = require('http');
const crypto = require('crypto');
const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const srv = http.createServer((q, s) => { s.end('plain-http-ok'); });
srv.on('upgrade', (req, sock) => {
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + MAGIC).digest('base64');
  const proto = (req.headers['sec-websocket-protocol'] || '').split(',')[0].trim();
  sock.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept +
    (proto ? '\\r\\nSec-WebSocket-Protocol: ' + proto : '') + '\\r\\n\\r\\n');
  let buf = Buffer.alloc(0);
  const send = (op, p) => {
    const head = p.length < 126 ? Buffer.from([0x80 | op, p.length])
      : Buffer.concat([Buffer.from([0x80 | op, 126]), Buffer.from([p.length >> 8, p.length & 0xff])]);
    sock.write(Buffer.concat([head, p]));
  };
  setTimeout(() => send(1, Buffer.from('push-1')), 2000);
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let payload = buf.slice(off + (masked ? 4 : 0), need);
      if (masked) {
        const mask = buf.slice(off, off + 4);
        payload = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
      }
      buf = buf.slice(need);
      if (op === 1) send(1, Buffer.from('echo:' + payload.toString()));
      else if (op === 2) send(2, payload);
      else if (op === 8) { sock.write(Buffer.from([0x88, 0x02, 0x03, 0xe8])); sock.end(); }
    }
  });
});
srv.listen(3000, '0.0.0.0', () => console.log('WS_UP'));
`;

describe.skipIf(!WS_GATE)("net.e2e — WebSocket · guest node WS server → Runtime.upgrade", () => {
  it("101+subprotocol, text/binary echo (incl. 300-byte frames), server push, 11s-idle survival, clean close", async () => {
    const t0 = Date.now();
    const rt = new VmRuntime(inputsFor("node"), { profile: "node" });
    const events: RuntimeEvent[] = [];
    try {
      await rt.boot();
      rt.subscribe((e) => events.push(e));
      await rt.writeFile("/root/ws.js", GUEST_WS_SRC);
      await rt.exec("node /root/ws.js"); // detached: exec resolves on START
      await waitForEvent(events, (e) => e.type === "port.opened" && e.port === 3000, 120_000);

      const ws = await rt.upgrade(3000, {
        method: "GET",
        url: "/ws?room=1",
        headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-protocol": "chat, log" },
        body: new Uint8Array(),
      });
      expect(ws.protocol).toBe("chat");

      const messages: Array<string | Uint8Array> = [];
      const closes: Array<[number, string]> = [];
      ws.onMessage((d) => messages.push(d));
      ws.onClose((code, reason) => closes.push([code, reason]));
      const waitMsg = async (pred: (m: string | Uint8Array) => boolean, ms: number, what: string): Promise<void> => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          if (messages.some(pred)) return;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error(`no ${what} within ${ms}ms; got: ${JSON.stringify(messages.map(String))}`);
      };

      ws.send("hello-1");
      await waitMsg((m) => m === "echo:hello-1", 30_000, "text echo");

      // Binary, >125 bytes: 16-bit extended lengths on BOTH directions.
      const blob = new Uint8Array(300).map((_, i) => i % 251);
      ws.send(blob);
      await waitMsg((m) => m instanceof Uint8Array && m.length === 300, 30_000, "binary echo");
      const echoed = messages.find((m): m is Uint8Array => m instanceof Uint8Array && m.length === 300)!;
      expect(echoed).toEqual(blob);

      // Unsolicited push: guest timer, zero client stimulus.
      await waitMsg((m) => m === "push-1", 30_000, "server push");

      // Long-lived conn: 11s idle (beyond any dispatch heuristic), then another
      // round-trip on the SAME connection.
      await new Promise((r) => setTimeout(r, 11_000));
      ws.send("hello-2");
      await waitMsg((m) => m === "echo:hello-2", 30_000, "post-idle echo");

      // Clean close handshake: guest echoes code 1000.
      ws.close(1000, "done");
      const deadline = Date.now() + 30_000;
      while (closes.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      expect(closes).toEqual([[1000, ""]]);
      expect(() => ws.send("late")).toThrow(/closed/);
    } finally {
      console.log(`[net.e2e] guest node WS → upgrade: ${secs(t0)}`);
      await rt.shutdown();
    }
  }, 240_000);
});

// (d) sci image — numpy/pandas are baked via apk (no network needed for the
// import); grouped here as the sci profile's real-interpreter smoke.
describe.skipIf(!gate("sci"))("net.e2e — sci image · numpy/pandas import", () => {
  it("python3 -c 'import numpy, pandas' → versions non-empty", async () => {
    const t0 = Date.now();
    const rt = new VmRuntime(inputsFor("sci"));
    try {
      await rt.boot();
      const r = await run(rt, `python3 -c "import numpy, pandas; print('SCI', numpy.__version__, pandas.__version__)"`);
      if (r.code !== 0) throw new Error(`import numpy/pandas failed (code ${r.code})\nSTDERR:\n${r.err}`);
      const m = r.out.match(/SCI\s+(\S+)\s+(\S+)/);
      expect(m, `no SCI marker in output: ${r.out}`).toBeTruthy();
      expect((m![1] ?? "").length).toBeGreaterThan(0);
      expect((m![2] ?? "").length).toBeGreaterThan(0);
    } finally {
      console.log(`[net.e2e] sci numpy/pandas import: ${secs(t0)}`);
      await rt.shutdown();
    }
  }, 180_000);
});
