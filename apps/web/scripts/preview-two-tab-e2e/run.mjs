// R35 gated e2e: the REGRESSION DRIVER for the cross-tab preview misroute.
//
// THE DEFECT. One Service Worker instance serves every tab of the origin. The
// old `appClient()` picked the page to dispatch a preview request into as "the
// first window client that is not itself a preview iframe", in a focus-ordered
// `matchAll` list, with NOTHING correlating it to the tab that issued the
// request. Two Studio tabs on two projects, both serving 8080, meant tab B's
// preview could be dispatched into tab A's runtime and render tab A's files —
// silently. The fix puts the owning page's Service Worker Client id in the URL
// (`/__preview__/<owner>/<port>/…`) and makes dispatch an EXACT
// `clients.matchAll(...).find(c => c.id === owner)` match, with a 503 (never a
// hand-off) when that tab is gone.
//
// WHAT THIS PROVES, and why it is the only thing that can. There is no Service
// Worker harness in this repo: `preview-sw-parity.test.ts` pins the two copies
// of the pure routing core against each other, but `clients.matchAll`, the
// `erdou:whoami` handshake and the actual two-tab dispatch are platform
// behaviour that only a real browser exercises. So: TWO Studio pages in ONE
// Chromium browser CONTEXT (one origin ⇒ one Service Worker — `browser.newPage()`
// would mint a fresh context per page and quietly test nothing), each serving a
// DIFFERENT project on THE SAME port 8080, each with its preview open.
//
// Why it fails against the pre-fix code:
//   - checks 4/5 (`fetch` each page's OWN preview URL from that page, while both
//     tabs are live) are ordering-independent. Pre-fix, both URLs were the same
//     string `/__preview__/8080/`, and both fetches were answered by whichever
//     single tab `matchAll` ranked first — so ONE of the two markers is always
//     wrong. Post-fix the two URLs differ in their owner segment and each
//     resolves to its own tab.
//   - check 7 is the fail-loud half: close tab B, then ask for B's preview URL.
//     Pre-fix, tab A was a perfectly good "first non-preview window client" and
//     served ITS project's files with a 200 — the silent hand-off in its purest
//     form. Post-fix it is a 503 naming the dead owner.
//   - checks 2/3 are the user-visible symptom (iframe content), made
//     ordering-independent by reloading A's iframe AFTER B exists.
// Checks 10/11 cover the two responses the new URL shape INVENTED, neither of
// which any other artifact exercises: the 400 for a pre-owner
// `/__preview__/<port>/…` URL (regressing it to passthrough would render
// Studio's own index.html inside the preview frame while every check above
// stayed green), and the 503 for a RELOADED owner — the accepted cost of
// binding a preview to a client id, and the case users actually meet through
// the detached ↗ popup.
//
// Browser kernel only: `erdou serve` runs in the VFS, so no VM assets, no
// Pyodide, no network. Dev-server + browser lifecycle and the signal-safe
// cleanup mirror scripts/pip-wheels-e2e/run.mjs. Emits "RESULT ALL_PASS" iff
// every check passes.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // apps/web/scripts/preview-two-tab-e2e
const webRoot = join(here, "..", ".."); // apps/web
const repoRoot = join(webRoot, "..", ".."); // repo root

const require = createRequire(join(webRoot, "package.json"));
const { chromium } = require("playwright-core");

// Per-run random markers so a stale iframe or a cached body can't produce a
// false PASS, and so A's marker can never be a substring of B's. Kept to
// [a-z0-9-] because they are typed into a shell command line unquoted.
const rand = () => Math.random().toString(36).slice(2, 8);
const MARKER_A = "erdou-tab-a-" + rand();
const MARKER_B = "erdou-tab-b-" + rand();
// THE SAME port in both tabs — that collision is the whole point. Each page has
// its own PortRegistry (per-runtime), so both binds succeed; only the shared
// Service Worker has to tell them apart.
const PORT = 8080;

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

// Idempotent: safe from both a signal handler and main()'s `finally`. Kills the
// dev-server process group synchronously (before any `await`) so the signal is
// sent even if a concurrent caller returns early on the `cleanedUp` guard.
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
    console.log(`[preview-two-tab-e2e] received ${sig}; cleaning up dev server + browser before exit`);
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
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

    // ONE context for both pages — the load-bearing detail of this whole test.
    // A browser context is the Service Worker registration boundary: two pages
    // here share the origin AND its single worker, which is the condition the
    // defect needs. `browser.newPage()` (what the other drivers use, being
    // single-page) creates a NEW context each call, giving each page its own
    // worker and silently making the test vacuous.
    const context = await browser.newContext();
    // Pre-seed a model config so the Settings dialog — which auto-opens when
    // unconfigured, as a full-viewport `.scrim` — never blocks clicks.
    await context.addInitScript(() => {
      localStorage.setItem(
        "erdou:model",
        JSON.stringify({ provider: "openai-compatible", baseUrl: "/llm/v1", apiKey: "e2e-test-key", model: "gpt-4o-mini" }),
      );
    });

    const tabSel = (name) => `button.tab:text-is("${name}")`;
    const previewTab = tabSel("Preview");

    /** Open a Studio page, write a marker index.html into ITS runtime's VFS and
     *  serve it on PORT from the Preview panel, then return the preview URL the
     *  panel built (which names this page's owner id). Everything goes through
     *  the real UI — the panel is where `previewUrl(owner, port)` is called. */
    async function openStudioTab(label, marker) {
      const page = await context.newPage();
      page.on("pageerror", (e) => console.log(`[${label}:pageerror] ${e.message}`));
      page.on("console", (m) => {
        if (m.type() === "error") console.log(`[${label}:console] ${m.text()}`);
      });

      // Cold `.vite` optimize-deps re-bundles on first navigation: deferred
      // module scripts stall `domcontentloaded` (wait on "commit" instead), and
      // Vite may push a full reload that lands a <vite-error-overlay>
      // intercepting clicks. Retry on the real readiness signal.
      await page.goto(baseUrl + "/", { waitUntil: "commit", timeout: 60_000 });
      for (let i = 0; i < 3; i++) {
        try {
          await page.waitForSelector(previewTab, { timeout: 30_000 });
          break;
        } catch (e) {
          const hadOverlay = (await page.locator("vite-error-overlay").count()) > 0;
          console.log(`[${label}] Preview tab not ready (overlay=${hadOverlay}); reload ${i + 1}/3`);
          if (i === 2) throw e;
          await sleep(1000);
          await page.reload({ waitUntil: "commit", timeout: 60_000 });
        }
      }

      await page.locator(previewTab).click();
      // ONE command line does both halves: write this tab's own index.html into
      // its own in-browser VFS, then serve it. The two tabs share an IndexedDB
      // snapshot but NOT a live runtime, so each `erdou serve` reads the file
      // this tab just wrote — the distinct markers are what make a misroute
      // legible instead of invisible.
      const cmd = `echo ${marker} > index.html && erdou serve . ${PORT}`;
      // `.run-input` also matches the port field (`.run-input.port-input`), and
      // Playwright locators are strict — exclude it rather than take `.first()`.
      await page.locator(".preview-run-row input.run-input:not(.port-input)").fill(cmd);
      await page.locator(".preview-run-row button.btn").click();

      await page.waitForSelector(`.port-chip:has-text("port ${PORT}")`, { timeout: 30_000 });
      // The panel auto-selects the port the run opened, so the iframe mounts on
      // its own. If the owner handshake (`erdou:whoami`) failed there is
      // deliberately NO iframe — the panel renders an explicit error instead of
      // a frame only a guess could serve — so surface that text rather than
      // timing out on a selector that will never appear.
      try {
        await page.waitForSelector(".preview-frame", { timeout: 20_000 });
      } catch (e) {
        const err = await page.locator(".build-errors pre").textContent().catch(() => "");
        throw new Error(`[${label}] no preview iframe${err ? `; panel says: ${JSON.stringify(err.slice(0, 300))}` : ""}: ${e?.message ?? e}`);
      }
      const src = await page.locator(".preview-frame").getAttribute("src");
      console.log(`[${label}] preview src = ${src}`);
      return { page, label, marker, src };
    }

    /** The preview iframe's rendered body text, polled until `needle` shows up
     *  (or the deadline). Never throws — returns the last body seen, so a
     *  failure detail shows what DID render (e.g. the other tab's marker). */
    async function previewBody(tab, needle, timeoutMs) {
      let text = "";
      const deadline = Date.now() + timeoutMs;
      // Match the OWNER-bearing src exactly: matching on `__preview__/<port>`
      // alone would find no frame at all under the new shape and report as
      // "empty body" instead of "stale matcher".
      const find = () => tab.page.frames().find((f) => f.url().includes(tab.src));
      for (;;) {
        const frame = find();
        if (frame) text = await frame.evaluate(() => document.body?.textContent ?? "").catch(() => text);
        if (text.includes(needle) || Date.now() > deadline) return text;
        await sleep(400);
      }
    }

    /** Re-navigate a tab's preview iframe through the Service Worker. Used to
     *  re-issue tab A's preview request AFTER tab B exists, so the iframe check
     *  does not depend on `matchAll` ordering at first-load time. */
    async function reloadPreview(tab) {
      const frame = tab.page.frames().find((f) => f.url().includes(tab.src));
      if (!frame) throw new Error(`[${tab.label}] preview frame not found for reload (${tab.src})`);
      await frame.evaluate(() => location.reload()).catch(() => {});
      await sleep(500);
    }

    /** Ask for `path` FROM `tab`'s page. The request goes through the same
     *  Service Worker as the iframe's, so the answer is decided by the owner in
     *  the URL — not by which page asked. */
    async function fetchFromTab(tab, path) {
      return await tab.page.evaluate(async (p) => {
        const r = await fetch(p, { cache: "no-store" });
        return { status: r.status, body: (await r.text()).slice(0, 400) };
      }, path);
    }

    // ---- Set up both tabs, sequentially, and leave both open.
    const a = await openStudioTab("tabA", MARKER_A);
    const b = await openStudioTab("tabB", MARKER_B);

    // 1) Distinct owners. Both preview URLs carry the same port; only the owner
    // segment distinguishes them, and it MUST differ or nothing below can work.
    const ownerOf = (src) => /^\/__preview__\/([^/]+)\//.exec(src ?? "")?.[1] ?? "";
    const ownerA = ownerOf(a.src);
    const ownerB = ownerOf(b.src);
    pass(
      "two-tabs-get-distinct-owner-ids",
      ownerA !== "" && ownerB !== "" && ownerA !== ownerB,
      `A=${ownerA || "(none)"} B=${ownerB || "(none)"} port=${PORT}`,
    );

    // 2/3) The user-visible symptom: each tab's iframe shows ITS OWN project.
    // A's frame is reloaded first so BOTH preview requests are issued while both
    // tabs are live — otherwise A's frame would be judged on a request made when
    // it was the only tab, which even the buggy code got right.
    await reloadPreview(a);
    const bodyA = await previewBody(a, MARKER_A, 25_000);
    pass(
      "tab-a-iframe-shows-tab-a-project",
      bodyA.includes(MARKER_A) && !bodyA.includes(MARKER_B),
      `body=${JSON.stringify(bodyA.slice(0, 120))}`,
    );
    const bodyB = await previewBody(b, MARKER_B, 25_000);
    pass(
      "tab-b-iframe-shows-tab-b-project",
      bodyB.includes(MARKER_B) && !bodyB.includes(MARKER_A),
      `body=${JSON.stringify(bodyB.slice(0, 120))}`,
    );

    // 4/5) The ordering-independent core. Both requests are issued now, with
    // both tabs live, each from its own page for its own preview URL. Pre-fix
    // the two URLs were literally the same string and one single tab answered
    // both, so one of these two MUST have carried the other project's bytes.
    const selfA = await fetchFromTab(a, a.src);
    pass(
      "fetch-of-own-preview-url-is-served-by-own-runtime-A",
      selfA.status === 200 && selfA.body.includes(MARKER_A) && !selfA.body.includes(MARKER_B),
      `status=${selfA.status} body=${JSON.stringify(selfA.body.slice(0, 120))}`,
    );
    const selfB = await fetchFromTab(b, b.src);
    pass(
      "fetch-of-own-preview-url-is-served-by-own-runtime-B",
      selfB.status === 200 && selfB.body.includes(MARKER_B) && !selfB.body.includes(MARKER_A),
      `status=${selfB.status} body=${JSON.stringify(selfB.body.slice(0, 120))}`,
    );

    // 6) The owner in the URL — not the tab that asked — decides. Tab A asks for
    // tab B's preview URL and gets tab B's project. This is the positive
    // statement of the routing rule (and of why the ↗ popup, a `noopener`
    // window with no handle back to Studio, works at all).
    const crossed = await fetchFromTab(a, b.src);
    pass(
      "owner-in-url-decides-not-the-requesting-tab",
      crossed.status === 200 && crossed.body.includes(MARKER_B) && !crossed.body.includes(MARKER_A),
      `status=${crossed.status} body=${JSON.stringify(crossed.body.slice(0, 120))}`,
    );

    // 7) FAIL LOUD, never fall back. Close tab B; its preview URL now names a
    // dead client. Tab A is still open and is exactly the "first window client
    // that is not a preview iframe" the old code would have handed this to —
    // returning tab A's project with a 200. It must be a 503 that says the
    // owning tab is gone. Polled: client teardown is not instantaneous, and a
    // request racing the close can legitimately still hit the live client.
    await b.page.close();
    let dead = { status: 0, body: "" };
    const deadline = Date.now() + 10_000;
    for (;;) {
      dead = await fetchFromTab(a, b.src);
      if (dead.status === 503 || Date.now() > deadline) break;
      await sleep(300);
    }
    pass(
      "dead-owner-503s-instead-of-being-served-by-the-other-tab",
      dead.status === 503 && /owns this preview is gone/.test(dead.body) && !dead.body.includes(MARKER_A),
      `status=${dead.status} body=${JSON.stringify(dead.body.slice(0, 200))}`,
    );

    // 8) The surviving tab is untouched by its neighbour's death — a 503 for a
    // dead owner must not be a blanket "previews are broken now".
    const afterA = await fetchFromTab(a, a.src);
    pass(
      "surviving-tab-preview-still-works",
      afterA.status === 200 && afterA.body.includes(MARKER_A),
      `status=${afterA.status} body=${JSON.stringify(afterA.body.slice(0, 120))}`,
    );

    // 9) PASSTHROUGH SAFETY, asserted rather than assumed: the Studio app's own
    // traffic must never be answered by a guest runtime. The root-scoped worker
    // sees this request too; `routePreviewRequest` returns null for it (not
    // in-scope, and the initiating client's URL is the app document) so it is
    // re-fetched from the network untouched. If a guest had answered it, the
    // body would be a marker instead of the app's HTML.
    const appHtml = await fetchFromTab(a, "/");
    pass(
      "studio-app-traffic-passes-through-untouched",
      appHtml.status === 200 && /<div id="root">|<!doctype html>/i.test(appHtml.body) &&
        !appHtml.body.includes(MARKER_A) && !appHtml.body.includes(MARKER_B),
      `status=${appHtml.status} body=${JSON.stringify(appHtml.body.slice(0, 100))}`,
    );

    // 10) The PRE-OWNER URL shape fails loud instead of passing through. A
    // bookmark, or a ↗ popup left open across this upgrade, asks for
    // `/__preview__/8080/…`; the worker's PREVIEW_PATH refuses to parse it (the
    // port group is `\d+`, so the two-segment shape cannot be misread as
    // owner="8080" with the guest's first path segment as its port). The worker
    // owns `/__preview__/` outright — nothing else in the app serves under it —
    // so the honest answer is a 400 naming the URL. Passthrough would fetch it
    // from the network and render STUDIO'S OWN index.html inside the preview
    // frame: a stale URL wearing the costume of a broken guest app, with every
    // other check on this page still green.
    const legacy = await fetchFromTab(a, `/__preview__/${PORT}/`);
    pass(
      "pre-owner-preview-url-400s-instead-of-passing-through",
      legacy.status === 400 &&
        /unrecognized preview URL/.test(legacy.body) &&
        !/<div id="root">|<!doctype html>/i.test(legacy.body),
      `status=${legacy.status} body=${JSON.stringify(legacy.body.slice(0, 200))}`,
    );

    // 11) RELOAD — the half of "the owner is gone" that check 7 cannot reach,
    // and the one users actually hit. A reload mints a NEW Service Worker client
    // id, so a still-open tab stops answering the preview URLs its previous
    // document minted; the ↗ popup is opened `noopener` (no handle back to
    // Studio, so nothing can re-point it) and starts 503ing the moment Studio is
    // reloaded. This was accepted as a cost ONLY on the condition that the
    // message names it, so the assertion is on that word, not merely on the
    // status: a 503 that says "closed" sends the user hunting for a tab they can
    // see is open. Kept last: reloading A destroys the runtime checks 1-10 need.
    // Polled for the same reason as check 7 — client teardown is not instant.
    await a.page.reload({ waitUntil: "commit", timeout: 60_000 });
    await a.page.waitForSelector(previewTab, { timeout: 30_000 });
    let reloaded = { status: 0, body: "" };
    const reloadDeadline = Date.now() + 10_000;
    for (;;) {
      reloaded = await fetchFromTab(a, a.src);
      if (reloaded.status === 503 || Date.now() > reloadDeadline) break;
      await sleep(300);
    }
    pass(
      "reloaded-owner-503s-with-a-message-that-names-the-reload",
      reloaded.status === 503 && /RELOADED/.test(reloaded.body) && !reloaded.body.includes(MARKER_A),
      `status=${reloaded.status} body=${JSON.stringify(reloaded.body.slice(0, 200))}`,
    );
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
