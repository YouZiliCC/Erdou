// R11c Task 7: gated app e2e driver — drives the REAL apps/web (Vite dev) in
// headless Chromium: boots on the browser kernel, switches to the Linux VM
// kernel (real Alpine guest, ~40MB state), runs a command in the xterm PTY,
// and switches back. Ported from R11c Spike G's drive.mjs (which drove a
// throwaway /vm-spike.html + window.__spike hook) to instead interact with
// the real app UI (KernelToggle's Select, ReviewPane's Terminal tab, xterm's
// DOM renderer) since no spike hook exists in the shipped app.
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // apps/web/scripts/app-vm-e2e
const webRoot = join(here, "..", ".."); // apps/web
const repoRoot = join(webRoot, "..", ".."); // repo root

const require = createRequire(join(webRoot, "package.json"));
const { chromium } = require("playwright-core");

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
        // server not up yet
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`dev server did not become reachable at ${url} within ${timeoutMs}ms\n${getLog()}`);
  })();
}

async function main() {
  // Ensure /vm-assets resolves (idempotent; `predev` also does this when the
  // dev server below is spawned via pnpm's script pre-hook).
  execFileSync(process.execPath, [join(webRoot, "scripts", "link-vm-assets.mjs")], { stdio: "inherit" });

  // Start the real dev server as its own process group, so cleanup can kill
  // vite + any of its children even though pnpm forks it.
  const devServer = spawn("pnpm", ["--filter", "@erdou/web", "dev"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let devLog = "";
  let resolveUrl, rejectUrl;
  let baseUrl;
  const urlWait = new Promise((res, rej) => { resolveUrl = res; rejectUrl = rej; });
  const onData = (d) => {
    const s = d.toString();
    devLog += s;
    process.stdout.write(`[vite] ${s}`);
    if (!baseUrl) {
      const m = /Local:\s+(https?:\/\/[^\s]+)/.exec(devLog);
      if (m) { baseUrl = m[1].replace(/\/$/, ""); resolveUrl(baseUrl); }
    }
  };
  devServer.stdout.on("data", onData);
  devServer.stderr.on("data", (d) => { devLog += d.toString(); process.stdout.write(`[vite:err] ${d}`); });
  devServer.on("exit", (code) => {
    if (!baseUrl) rejectUrl(new Error(`dev server exited before printing a URL (code ${code})\n${devLog}`));
  });
  const urlTimer = setTimeout(() => rejectUrl(new Error(`timeout waiting for dev server URL\n${devLog}`)), 30_000);

  let browser;
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
    page.on("requestfailed", (r) => console.log(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
    page.on("response", (r) => { if (r.status() >= 400) console.log(`[http ${r.status()}] ${r.url()}`); });
    page.on("console", (m) => { if (m.type() === "error") console.log(`[page:error] ${m.text()}`); });

    // Pre-seed a model config so the Settings dialog — which auto-opens when
    // unconfigured, as a full-viewport `.scrim` (position: fixed; inset: 0;
    // z-index: 40) — never blocks clicks on the Kernel toggle in the TitleBar.
    await page.addInitScript(() => {
      localStorage.setItem(
        "erdou:model",
        JSON.stringify({ provider: "openai-compatible", baseUrl: "/llm/v1", apiKey: "e2e-test-key", model: "gpt-4o-mini" }),
      );
    });

    const t0 = Date.now();
    const kernelBtnSel = 'button[aria-label="Kernel"]';

    // On a cold `.vite` optimize-deps cache, Vite can still be re-bundling
    // when we first navigate; it then pushes a full-reload over its HMR
    // socket that can land a <vite-error-overlay> intercepting clicks (see
    // Spike G's notes). Detect it and reload once rather than hard-failing.
    await page.goto(baseUrl + "/", { waitUntil: "domcontentloaded" });
    for (let i = 0; i < 2; i++) {
      const overlay = await page.locator("vite-error-overlay").count();
      if (overlay === 0) break;
      console.log("[driver] vite-error-overlay detected after navigation; reloading");
      await new Promise((r) => setTimeout(r, 1000));
      await page.reload({ waitUntil: "domcontentloaded" });
    }
    await page.waitForSelector(kernelBtnSel, { timeout: 20_000 });
    const kernelLabel = () => page.locator(`${kernelBtnSel} .ui-select-label`).textContent();

    // 1) Browser kernel active by default.
    const initialLabel = await kernelLabel();
    pass("default-browser-kernel", initialLabel === "Browser kernel", `label="${initialLabel}"`);

    // 2) Switch to the Linux VM (~40MB state fetch + ~2s boot).
    await page.click(kernelBtnSel);
    await page.locator(".ui-select-pop .ui-select-opt", { hasText: "Linux VM" }).click();
    try {
      await page.waitForFunction(
        () => document.querySelector('button[aria-label="Kernel"] .ui-select-label')?.textContent === "Linux VM",
        undefined,
        { timeout: 40_000 },
      );
      pass("switch-to-vm", true, `wall=${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      pass("switch-to-vm", false, String(e?.message ?? e));
    }

    // 3) Open the Terminal tab; the VM kernel's PtyTerminal renders `.xterm`.
    await page.locator("button.tab", { hasText: "Terminal" }).click();
    await page.waitForSelector(".xterm", { timeout: 10_000 }).catch(() => {});
    const hasXterm = (await page.locator(".xterm").count()) > 0;
    pass("terminal-xterm-present", hasXterm);

    const xtermText = () => page.evaluate(() => document.querySelector(".xterm-rows")?.textContent ?? "");
    const waitForXterm = async (needle, timeoutMs) => {
      const t1 = Date.now();
      let buf = "";
      while (Date.now() - t1 < timeoutMs) {
        buf = await xtermText();
        if (buf.includes(needle)) return buf;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(`timeout waiting for "${needle}" in .xterm-rows:\n${buf}`);
    };
    const typeCmd = async (cmd) => {
      await page.keyboard.type(cmd, { delay: 15 });
      await page.keyboard.press("Enter");
    };
    // Right after boot the guest can occasionally drop or garble the first
    // few characters of a command typed immediately after its prompt renders
    // (observed: a busy guest swallowing the leading bytes of the very first
    // interactive line). Rather than guess a magic settle delay, retype on a
    // miss — each retry starts at a fresh prompt line, so it's a clean resend.
    const typeAndWaitFor = async (cmd, needle, { attempts = 3, timeoutMs = 8_000 } = {}) => {
      let lastErr;
      for (let i = 0; i < attempts; i++) {
        await typeCmd(cmd);
        try {
          return await waitForXterm(needle, timeoutMs);
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr;
    };

    if (hasXterm) {
      await page.click(".xterm");
      // Confirm focus actually landed on xterm's hidden input textarea
      // before typing (a click->focus race would otherwise drop the first
      // few keystrokes into whatever was previously focused).
      await page
        .waitForFunction(() => document.activeElement?.classList?.contains("xterm-helper-textarea"), undefined, {
          timeout: 5_000,
        })
        .catch(() => {});

      // 4) python3 -c 'print(6*7)' -> 42, executed by the real Alpine guest.
      try {
        // PtyTerminal opens the pty session asynchronously after mount
        // (`openPty` resolves post-boot); `term.onData` isn't wired until
        // that promise settles, so keystrokes typed before the guest's first
        // shell prompt renders are silently dropped. Wait for that prompt.
        await waitForXterm("$", 15_000);
        await typeAndWaitFor("python3 -c 'print(6*7)'", "42", { timeoutMs: 10_000 });
        pass("pty-python-42", true);
      } catch (e) {
        pass("pty-python-42", false, String(e?.message ?? e));
      }

      // 5) ls / -> real guest root entries render.
      try {
        const buf = await typeAndWaitFor("ls /", "bin", { timeoutMs: 10_000 });
        pass("pty-ls-root", /\bbin\b/.test(buf) || /\busr\b/.test(buf));
      } catch (e) {
        pass("pty-ls-root", false, String(e?.message ?? e));
      }
    } else {
      pass("pty-python-42", false, "no .xterm element to type into");
      pass("pty-ls-root", false, "no .xterm element to type into");
    }

    // 6) Switch back to the browser kernel.
    await page.click(kernelBtnSel);
    await page.locator(".ui-select-pop .ui-select-opt", { hasText: "Browser kernel" }).click();
    try {
      await page.waitForFunction(
        () => document.querySelector('button[aria-label="Kernel"] .ui-select-label')?.textContent === "Browser kernel",
        undefined,
        { timeout: 15_000 },
      );
      pass("switch-back-to-browser", true);
    } catch (e) {
      pass("switch-back-to-browser", false, String(e?.message ?? e));
    }

    console.log("---- final .xterm-rows tail ----");
    console.log((await xtermText()).trimEnd().split("\n").slice(-20).join("\n"));
  } finally {
    if (browser) await browser.close().catch(() => {});
    try {
      if (devServer.pid) process.kill(-devServer.pid, "SIGTERM");
    } catch {
      devServer.kill("SIGTERM");
    }
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
