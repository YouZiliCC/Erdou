import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const assetsPresent = existsSync(join(here, "..", "assets", "state-base.zst"));
const chromium = ["/usr/bin/chromium-browser", "/usr/bin/chromium"].find(existsSync);
const RUN = assetsPresent && process.env.ERDOU_VM_E2E === "1" && !!chromium;

describe.skipIf(!RUN)("VmRuntime browser e2e (gated)", () => {
  it("boots in headless Chromium and passes smoke + sync-fs + PTY", () => {
    // The driver esbuild-bundles browser-entry.ts, serves it + assets, runs Chromium,
    // and exits 0 iff RESULT ALL_PASS. Delegating to a script keeps vitest out of the
    // browser process lifecycle.
    const out = execFileSync("node", [join(here, "..", "scripts", "browser-e2e", "run.mjs")], {
      encoding: "utf8",
      timeout: 110_000,                 // < the it() timeout, so the inner one governs with a clean error
      maxBuffer: 16 * 1024 * 1024,      // a browser boot logs a lot
      env: { ...process.env, CHROMIUM: chromium! },
    });
    expect(out).toMatch(/RESULT ALL_PASS/);
  }, 120_000);
});
