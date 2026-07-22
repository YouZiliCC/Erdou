// R34 gated e2e: proves the browser kernel installs a bundled document library
// (openpyxl) from the LOCAL wheel index — offline, same-origin — and then
// generates a real .xlsx. Drives the REAL apps/web (Vite dev) in headless
// Chromium; in-page it dynamically imports the shipped kernel module and runs
// pip + python through it (no UI driving needed). Mirrors app-vm-e2e/run.mjs's
// dev-server + browser lifecycle. openpyxl is chosen because it is pure Python
// with NO native dep, so a green run isolates the local-wheel path (only the
// Pyodide runtime + micropip come from the CDN; openpyxl + et_xmlfile come from
// /wheels/). Emits "RESULT ALL_PASS" iff every check passes.
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // apps/web/scripts/pip-wheels-e2e
const webRoot = join(here, "..", ".."); // apps/web
const repoRoot = join(webRoot, "..", ".."); // repo root

const require = createRequire(join(webRoot, "package.json"));
const { chromium } = require("playwright-core");

let devServer;
let browser;
let cleanedUp = false;

function killDevServerGroup(signal) {
  if (!devServer) return;
  try {
    if (devServer.pid) process.kill(-devServer.pid, signal);
    else devServer.kill(signal);
  } catch {
    try {
      devServer.kill(signal);
    } catch {
      // already gone
    }
  }
}

async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  killDevServerGroup("SIGTERM");
  const killTimer = setTimeout(() => killDevServerGroup("SIGKILL"), 2000);
  devServer?.once("exit", () => clearTimeout(killTimer));
  if (browser) await browser.close().catch(() => {});
  clearTimeout(killTimer);
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    console.log(`[pip-wheels-e2e] received ${sig}; cleaning up`);
    await cleanup();
    process.exit(1);
  });
}

const results = [];
const pass = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " " + detail : ""}`);
};

function waitForServer(url, getLog, timeoutMs = 15_000) {
  const t0 = Date.now();
  return (async function poll() {
    while (Date.now() - t0 < timeoutMs) {
      try {
        const r = await fetch(url);
        if (r.ok) return;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`dev server did not become reachable at ${url} within ${timeoutMs}ms\n${getLog()}`);
  })();
}

async function main() {
  execFileSync(process.execPath, [join(webRoot, "scripts", "link-vm-assets.mjs")], { stdio: "inherit" });
  execFileSync(process.execPath, [join(webRoot, "scripts", "download-wheels.mjs")], { stdio: "inherit" });

  devServer = spawn("pnpm", ["--filter", "@erdou/web", "dev"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let devLog = "";
  let resolveUrl, rejectUrl;
  let baseUrl;
  const urlWait = new Promise((res, rej) => {
    resolveUrl = res;
    rejectUrl = rej;
  });
  const onData = (d) => {
    const s = d.toString();
    devLog += s;
    if (!baseUrl) {
      const m = /Local:\s+(https?:\/\/[^\s]+)/.exec(devLog);
      if (m) {
        baseUrl = m[1].replace(/\/$/, "");
        resolveUrl(baseUrl);
      }
    }
  };
  devServer.stdout.on("data", onData);
  devServer.stderr.on("data", (d) => {
    devLog += d.toString();
  });
  devServer.on("exit", (code) => {
    if (!baseUrl) rejectUrl(new Error(`dev server exited before printing a URL (code ${code})\n${devLog}`));
  });
  const urlTimer = setTimeout(() => rejectUrl(new Error(`timeout waiting for dev server URL\n${devLog}`)), 30_000);

  try {
    baseUrl = await urlWait;
    clearTimeout(urlTimer);
    await waitForServer(baseUrl + "/", () => devLog);

    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium-browser",
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
    });
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));

    // Record which wheel/PyPI requests the page makes — the proof the install
    // used the local same-origin wheels, not a PyPI fetch.
    const wheelReqs = [];
    const pypiReqs = [];
    page.on("request", (r) => {
      const u = r.url();
      if (u.includes("/wheels/")) wheelReqs.push(u);
      if (u.includes("pythonhosted.org") || u.includes("pypi.org")) pypiReqs.push(u);
    });

    await page.goto(baseUrl + "/", { waitUntil: "domcontentloaded" });
    for (let i = 0; i < 2; i++) {
      if ((await page.locator("vite-error-overlay").count()) === 0) break;
      await new Promise((r) => setTimeout(r, 1000));
      await page.reload({ waitUntil: "domcontentloaded" });
    }

    // In-page: import the shipped kernel, install openpyxl (local wheels), and
    // generate a real .xlsx through the browser kernel's pip + python.
    const out = await page.evaluate(async () => {
      const { createBrowserKernel } = await import("/src/lib/kernel.ts");
      const kernel = createBrowserKernel();
      const sh = kernel.openShell();
      const pip = await sh.exec("pip install openpyxl");
      kernel.fs.writeFile(
        "/gen.py",
        [
          "from openpyxl import Workbook",
          "wb = Workbook()",
          "ws = wb.active",
          "ws.title = 'Sales'",
          "ws.append(['Month', 'Revenue'])",
          "ws.append(['Jan', 1000])",
          "wb.save('/out.xlsx')",
          "print('wrote xlsx')",
        ].join("\n"),
      );
      const py = await sh.exec("python /gen.py");
      const exists = kernel.fs.exists("/out.xlsx");
      const bytes = exists ? kernel.fs.readFile("/out.xlsx") : new Uint8Array();
      // .xlsx is a zip — first two bytes are "PK".
      const isZip = bytes.length > 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
      return {
        pipCode: pip.code,
        pipOut: (pip.stdout + pip.stderr).slice(0, 4000),
        pyCode: py.code,
        pyOut: (py.stdout + py.stderr).slice(0, 4000),
        exists,
        size: bytes.length,
        isZip,
      };
    });

    console.log("[in-page] pip:", JSON.stringify({ code: out.pipCode }), out.pipOut.trim().split("\n").slice(-3).join(" | "));
    console.log("[in-page] py:", JSON.stringify({ code: out.pyCode }), out.pyOut.trim());
    console.log("[in-page] wheelReqs:", wheelReqs.map((u) => u.split("/").pop()).join(", ") || "(none)");
    console.log("[in-page] pypiReqs:", pypiReqs.join(", ") || "(none)");

    pass("pip-install-openpyxl-exit0", out.pipCode === 0, `code=${out.pipCode}`);
    pass("python-generated-xlsx-exit0", out.pyCode === 0, `code=${out.pyCode}`);
    pass("xlsx-file-exists-nonempty", out.exists && out.size > 0, `size=${out.size}`);
    pass("xlsx-is-a-real-zip", out.isZip);
    pass("openpyxl-came-from-local-wheels", wheelReqs.some((u) => /openpyxl-.*\.whl/.test(u)));
    pass("et_xmlfile-came-from-local-wheels", wheelReqs.some((u) => /et_xmlfile-.*\.whl/.test(u)));
    pass("no-pypi-fetch-for-the-bundled-libs", !pypiReqs.some((u) => /openpyxl|et[-_]xmlfile/.test(u)));
  } finally {
    await cleanup();
  }

  const allOk = results.length > 0 && results.every((r) => r.ok);
  console.log(`RESULT ${allOk ? "ALL_PASS" : "SOME_FAIL"} (${results.filter((r) => r.ok).length}/${results.length} checks)`);
  return allOk ? 0 : 1;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (e) {
  console.log(`DRIVER_ERROR ${e?.stack || e}`);
  exitCode = 1;
}
process.exit(exitCode);
