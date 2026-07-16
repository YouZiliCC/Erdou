import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const assetsPresent = existsSync(join(here, "..", "..", "..", "packages", "runtime-vm", "assets", "state.zst"));
const chromium = ["/usr/bin/chromium-browser", "/usr/bin/chromium"].find(existsSync);
const RUN = assetsPresent && process.env.ERDOU_VM_E2E === "1" && !!chromium;

describe.skipIf(!RUN)("app + VM kernel e2e (gated)", () => {
  it("switches to the VM kernel, runs a command in the xterm PTY, switches back", () => {
    // The driver starts the real `pnpm --filter @erdou/web dev`, drives headless
    // Chromium against it, and exits 0 iff RESULT ALL_PASS. Delegating to a
    // script keeps vitest out of the dev-server + browser process lifecycle.
    const out = execFileSync("node", [join(here, "..", "scripts", "app-vm-e2e", "run.mjs")], {
      encoding: "utf8",
      timeout: 170_000, // < the it() timeout, so the inner one governs with a clean error
      maxBuffer: 32 * 1024 * 1024, // a dev-server boot + browser session logs a lot
      env: { ...process.env, CHROMIUM: chromium! },
    });
    expect(out).toMatch(/RESULT ALL_PASS/);
  }, 180_000);
});
