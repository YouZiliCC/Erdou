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
