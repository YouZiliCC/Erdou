// R12 Task 7: gated app PREVIEW e2e driver. Drives the REAL apps/web (Vite dev)
// in headless Chromium: switches to the Linux VM kernel, writes a marker
// index.html into the guest workspace via the xterm PTY, serves it with a real
// `python3 -m http.server --bind 0.0.0.0` from the Preview panel, and asserts
// the preview iframe (SW reverse-proxy -> VmRuntime.dispatch -> v86 NAT ->
// guest server -> response) renders the marker. Signal-safe cleanup +
// dev-server process group mirror scripts/app-vm-e2e/run.mjs.
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // apps/web/scripts/app-vm-preview-e2e
const webRoot = join(here, "..", ".."); // apps/web
const repoRoot = join(webRoot, "..", ".."); // repo root

const require = createRequire(join(webRoot, "package.json"));
const { chromium } = require("playwright-core");

// A per-run random marker so a stale iframe / cached body can't produce a false
// PASS: the marker only exists because THIS run wrote it into the guest.
const MARKER = "erdou-preview-marker-" + Math.random().toString(36).slice(2, 8);
const PORT = 8000;

// Hoisted so a signal handler (below) can reach them: the vitest wrapper's
// execFileSync timeout sends SIGTERM directly to this process, and with no
// handler Node would terminate immediately, skipping main()'s `finally` and
// leaking the detached dev-server process group (port 5173) + headless
// Chromium. Both get assigned inside main() once they exist.
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

// Idempotent: safe to call from both a signal handler and main()'s `finally`
// without double-killing. Kills the dev-server process group synchronously
// (before any `await`) so the signal is sent even if a concurrent caller
// returns early on the `cleanedUp` guard and exits the process right after.
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
    console.log(`[app-vm-preview-e2e] received ${sig}; cleaning up dev server + browser before exit`);
    await cleanup();
    process.exit(1);
  });
}

const results = [];
const pass = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " " + detail : ""}`);
};

function waitForServer(url, getLog, timeoutMs = 20_000) {
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
    process.stdout.write(`[vite] ${s}`);
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
    process.stdout.write(`[vite:err] ${d}`);
  });
  devServer.on("exit", (code) => {
    if (!baseUrl) rejectUrl(new Error(`dev server exited before printing a URL (code ${code})\n${devLog}`));
  });
  const urlTimer = setTimeout(() => rejectUrl(new Error(`timeout waiting for dev server URL\n${devLog}`)), 40_000);

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
    page.on("response", (r) => {
      if (r.status() >= 400) console.log(`[http ${r.status()}] ${r.url()}`);
    });
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`[page:error] ${m.text()}`);
    });

    // Pre-seed a model config so the Settings dialog — which auto-opens when
    // unconfigured, as a full-viewport `.scrim` — never blocks clicks on the
    // Kernel toggle in the TitleBar.
    await page.addInitScript(() => {
      localStorage.setItem(
        "erdou:model",
        JSON.stringify({ provider: "openai-compatible", baseUrl: "/llm/v1", apiKey: "e2e-test-key", model: "gpt-4o-mini" }),
      );
    });

    const kernelBtnSel = 'button[aria-label="Kernel"]';

    // On a cold `.vite` optimize-deps cache Vite re-bundles on first navigation:
    // deferred module scripts stall `domcontentloaded` (so wait on "commit"
    // instead), and Vite may push a full-reload that lands a <vite-error-overlay>
    // intercepting clicks. Wait for the real readiness signal (the kernel
    // button) with retries + overlay handling rather than hard-failing.
    await page.goto(baseUrl + "/", { waitUntil: "commit", timeout: 60_000 });
    for (let i = 0; i < 3; i++) {
      try {
        await page.waitForSelector(kernelBtnSel, { timeout: 30_000 });
        break;
      } catch (e) {
        const hadOverlay = (await page.locator("vite-error-overlay").count()) > 0;
        console.log(`[driver] kernel button not ready (overlay=${hadOverlay}); reload ${i + 1}/3`);
        if (i === 2) throw e;
        await new Promise((r) => setTimeout(r, 1000));
        await page.reload({ waitUntil: "commit", timeout: 60_000 });
      }
    }
    const kernelLabel = () => page.locator(`${kernelBtnSel} .ui-select-label`).textContent();

    // 1) Browser kernel active by default.
    const initialLabel = await kernelLabel();
    pass("default-browser-kernel", initialLabel === "Browser kernel", `label="${initialLabel}"`);

    // 2) Switch to the Linux VM (~40MB state fetch + ~2-3s boot).
    const t0 = Date.now();
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

    // 3) Open the Terminal tab and write a marker index.html into the guest
    // workspace via the xterm PTY. The interactive shell (ptybridge) and the
    // Preview panel's serve command (guestd exec) both run inside
    // `chroot /workspace` at cwd `/`, so a relative index.html written here is
    // exactly what `python3 -m http.server` serves below.
    await page.locator("button.tab", { hasText: "Terminal" }).click();
    await page.waitForSelector(".xterm", { timeout: 10_000 });
    await page.click(".xterm");
    await page
      .waitForFunction(() => document.activeElement?.classList?.contains("xterm-helper-textarea"), undefined, {
        timeout: 5_000,
      })
      .catch(() => {});

    const xtermText = () => page.evaluate(() => document.querySelector(".xterm-rows")?.textContent ?? "");
    // Scope the match to the delta after `sinceLen` so a needle already in
    // earlier scrollback (e.g. an echoed command line) can't produce a false
    // match. Returns the delta substring.
    const waitForXterm = async (needle, timeoutMs, sinceLen = 0) => {
      const t1 = Date.now();
      let buf = "";
      while (Date.now() - t1 < timeoutMs) {
        buf = await xtermText();
        const delta = buf.slice(sinceLen);
        if (delta.includes(needle)) return delta;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(`timeout waiting for "${needle}" in .xterm-rows delta (since offset ${sinceLen}):\n${buf}`);
    };
    const typeCmd = async (cmd) => {
      await page.keyboard.type(cmd, { delay: 15 });
      await page.keyboard.press("Enter");
    };

    // PtyTerminal opens the pty session asynchronously after mount; keystrokes
    // typed before the guest's first shell prompt renders are dropped. Wait for
    // that prompt first.
    await waitForXterm("$", 15_000);

    // Write + verify the marker file, retried because the freshly-booted guest
    // can drop the leading bytes of an interactive command. Two deliberate
    // choices make the retries clean:
    //   - NO quotes anywhere (MARKER is base36-safe): a dropped leading byte
    //     then just yields "cmd not found" — never an unclosed quote that traps
    //     the shell in a PS2 continuation that further input only worsens.
    //   - A Ctrl-C before each attempt aborts any partial/continuation line,
    //     resetting to a clean PS1 prompt.
    // `echo WROTE:$?` prints the write's exit status — the ECHOED command line
    // shows the literal `$?`, only the OUTPUT shows `WROTE:0`, so matching
    // "WROTE:0" confirms the write actually ran (exit 0), not the mere echo.
    // Then `cat` (whose command line contains no marker) confirms the file
    // really holds it — guarding the rare drop that leaves an empty redirect.
    const writeAndVerify = async (attempts = 4) => {
      let lastErr;
      for (let i = 0; i < attempts; i++) {
        if (i > 0) console.warn(`[app-vm-preview-e2e] PTY write retry: attempt ${i + 1}`);
        await page.keyboard.press("Control+C");
        await new Promise((r) => setTimeout(r, 250));
        const b0 = (await xtermText()).length;
        await typeCmd(`echo ${MARKER} > index.html; echo WROTE:$?`);
        try {
          await waitForXterm("WROTE:0", 8_000, b0); // write ran, exit 0 (output only)
        } catch (e) {
          lastErr = e;
          continue; // typing was dropped/garbled — reset + retype
        }
        const b1 = (await xtermText()).length; // after the write → excludes echoed marker
        await typeCmd("cat index.html");
        try {
          return await waitForXterm(MARKER, 6_000, b1); // genuine cat-output match
        } catch (e) {
          lastErr = e; // file empty/unwritten — retry the whole write
        }
      }
      throw lastErr;
    };
    try {
      await writeAndVerify();
      pass("guest-index-written", true);
    } catch (e) {
      pass("guest-index-written", false, String(e?.message ?? e));
    }

    // 4) Serve it from the Preview panel. The serve flow runs the command via
    // `runtime.exec` (detached) on the VM and settles on the real `port.opened`
    // event the guestd /proc/net/tcp watcher emits once python binds 0.0.0.0.
    await page.locator("button.tab", { hasText: "Preview" }).click();
    await page.fill(".run-input", `python3 -m http.server ${PORT} --bind 0.0.0.0`);
    // Scope to the Preview panel's toolbar: `button.btn.primary` alone also
    // matches the Composer's "Run ⌘⏎" send button. Within `.preview-bar` the
    // only `.btn.primary` is the Run button (Bundle & Run is `.btn.ghost`
    // whenever a command is typed).
    await page.locator(".preview-bar button.btn.primary").click();

    // python's http.server cold-start (~16s) + bind + the guestd watcher poll.
    try {
      await page.waitForSelector(`.port-chip:has-text("port ${PORT}")`, { timeout: 60_000 });
      pass("port-opened", (await page.locator(".port-chip", { hasText: `port ${PORT}` }).count()) > 0, `port ${PORT}`);
    } catch (e) {
      pass("port-opened", false, String(e?.message ?? e));
    }

    // The panel auto-selects the first opened port; the iframe mounts at
    // /__preview__/<port>/. Click View defensively in case selection lagged.
    await page
      .locator(".port-chip", { hasText: `port ${PORT}` })
      .locator("button", { hasText: "view" })
      .click()
      .catch(() => {});
    await page.waitForSelector(".preview-frame", { timeout: 15_000 }).catch(() => {});

    // 5) Assert the preview iframe renders the guest-served content — the full
    // path: SW reverse-proxy → dispatch → v86 NAT → guest server → response.
    const previewText = async () => {
      const frame = page.frames().find((f) => f.url().includes(`__preview__/${PORT}`));
      if (!frame) return "";
      return await frame.evaluate(() => document.body?.textContent ?? "").catch(() => "");
    };
    let text = "";
    const deadline = Date.now() + 50_000; // SW → dispatch → guest round-trip
    while (Date.now() < deadline) {
      text = await previewText();
      if (text.includes(MARKER)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    pass("preview-renders-guest-content", text.includes(MARKER), `body=${JSON.stringify(text.slice(0, 160))}`);
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
