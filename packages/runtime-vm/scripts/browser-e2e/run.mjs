// Drive the runtime-vm browser e2e (browser-entry.ts's bootAndSelfTest) in headless
// system Chromium via playwright-core. Ported from R11b Spike D's run-browser.mjs:
//
//   1) esbuild-bundle browser-entry.ts with `v86` marked EXTERNAL — libv86.mjs
//      references node crypto/fs/perf_hooks (for its Node fallback path) that esbuild
//      cannot resolve for a browser bundle; marking it external skips that and lets
//      page.html's import map resolve "v86" to the served libv86.mjs at runtime.
//   2) spawn server.mjs to serve page.html + the bundle + v86's build/ + assets/.
//   3) launch headless Chromium, navigate, and wait for a `RESULT `/`HARNESS_ERROR`
//      console line. Exit 0 iff `RESULT ALL_PASS` was seen.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..", ".."); // packages/runtime-vm

const outDir = mkdtempSync(join(tmpdir(), "erdou-vm-e2e-"));
const bundlePath = join(outDir, "bundle.js");

async function main() {
  await esbuild.build({
    entryPoints: [join(pkgRoot, "src", "browser-entry.ts")],
    bundle: true,
    format: "esm",
    outfile: bundlePath,
    platform: "browser",
    external: ["v86"], // resolved in-browser by page.html's import map -> served libv86.mjs
  });

  const v86PkgUrl = import.meta.resolve("v86/package.json");
  const v86BuildDir = join(dirname(fileURLToPath(v86PkgUrl)), "build");
  const assetsDir = join(pkgRoot, "assets");
  const port = Number(process.env.PORT ?? 8931);
  const url = `http://127.0.0.1:${port}/`;

  const server = spawn(process.execPath, [join(here, "server.mjs")], {
    env: { ...process.env, PORT: String(port), BUNDLE_PATH: bundlePath, V86_BUILD_DIR: v86BuildDir, ASSETS_DIR: assetsDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  server.stdout.on("data", (d) => { serverLog += d; console.log(`[server] ${d}`.trimEnd()); });
  server.stderr.on("data", (d) => { serverLog += d; console.log(`[server:err] ${d}`.trimEnd()); });
  server.on("exit", (code) => { if (code !== null && code !== 0) console.log(`[server] exited early with code ${code}`); });

  try {
    await waitForServer(url, () => serverLog);

    const executablePath = process.env.CHROMIUM ?? "/usr/bin/chromium-browser";
    const browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
    });
    const page = await browser.newPage();

    let done, verdictLine = null;
    const finished = new Promise((r) => (done = r));
    page.on("console", (msg) => {
      const loc = msg.location();
      const text = msg.text() + (msg.type() === "error" && loc?.url ? ` <- ${loc.url}` : "");
      console.log(`[page] ${text}`);
      if (text.startsWith("RESULT ") || text.startsWith("HARNESS_ERROR")) { verdictLine = text; done(); }
    });
    page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
    page.on("requestfailed", (r) => console.log(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
    page.on("response", (r) => { if (r.status() >= 400) console.log(`[http ${r.status()}] ${r.url()}`); });

    const t0 = Date.now();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const timeoutMs = Number(process.env.TIMEOUT_MS ?? 90_000);
    const timer = setTimeout(() => { verdictLine = "TIMEOUT"; done(); }, timeoutMs);
    await finished;
    clearTimeout(timer);
    console.log(`[driver] wall-clock ${(Date.now() - t0) / 1000}s verdict: ${verdictLine}`);
    await browser.close();
    return verdictLine?.startsWith("RESULT ALL_PASS") ? 0 : 1;
  } finally {
    server.kill();
  }
}

async function waitForServer(url, getLog, timeoutMs = 10_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not become ready at ${url} within ${timeoutMs}ms\n${getLog()}`);
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (e) {
  console.log(`[driver] ERROR ${e?.stack || e}`);
  exitCode = 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
process.exit(exitCode);
