import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const chromium = ["/usr/bin/chromium-browser", "/usr/bin/chromium"].find(existsSync);
// Browser kernel only — no VM state assets, no Pyodide, no network. Gated on an
// explicit flag + a Chromium binary because it boots the real Vite dev server
// and drives two Studio pages in one browser context.
const RUN = process.env.ERDOU_TWO_TAB_E2E === "1" && !!chromium;

describe.skipIf(!RUN)("two Studio tabs, one Service Worker: preview ownership e2e (gated)", () => {
  it("routes each tab's preview to ITS OWN runtime, and fails loud (503/400) instead of guessing a tab", () => {
    // The regression driver for the cross-tab preview misroute. One Service
    // Worker serves every tab of the origin; it used to pick the page to
    // dispatch into as "the first window client that is not a preview iframe"
    // — a focus-ordered guess uncorrelated with the tab that issued the
    // request, so two Studio tabs both serving 8080 could render each other's
    // files, silently. The driver opens TWO pages in ONE browser context (one
    // origin ⇒ one worker), serves a differently-marked project on the SAME
    // port 8080 in each, and asserts each preview shows its own marker; then
    // closes one tab and asserts its preview URL 503s rather than being served
    // by the survivor. It also pins the two responses this URL shape invented:
    // a 400 for a pre-owner `/__preview__/<port>/…` URL (a passthrough
    // regression would silently render Studio's own index.html in the preview
    // frame) and a 503 whose text NAMES the reload case — a reload mints a new
    // client id, which is what the detached ↗ popup dies of. There is no
    // Service Worker unit-test harness in this repo
    // (`preview-sw-parity.test.ts` pins the two copies of the pure routing
    // core, but not `clients.matchAll`, the `erdou:whoami` handshake, or actual
    // dispatch), so this driver is the only artifact that can demonstrate the
    // bug is gone. Exits 0 iff RESULT ALL_PASS.
    const out = execFileSync("node", [join(here, "..", "scripts", "preview-two-tab-e2e", "run.mjs")], {
      encoding: "utf8",
      timeout: 170_000, // < the it() timeout, so the inner one governs with a clean error
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, CHROMIUM: chromium! },
    });
    expect(out).toMatch(/RESULT ALL_PASS/);
  }, 180_000);
});
