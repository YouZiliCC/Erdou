import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const assetsPresent = existsSync(join(here, "..", "..", "..", "packages", "runtime-vm", "assets", "state.zst"));
const chromium = ["/usr/bin/chromium-browser", "/usr/bin/chromium"].find(existsSync);
const RUN = assetsPresent && process.env.ERDOU_VM_E2E === "1" && !!chromium;

describe.skipIf(!RUN)("app + VM kernel PREVIEW e2e (gated)", () => {
  it("previews a real guest HTTP server in the Preview panel", () => {
    // The driver starts the real `pnpm --filter @erdou/web dev`, drives headless
    // Chromium against it, switches to the VM kernel, writes a marker index.html
    // into the guest via the xterm PTY, serves it with python's http.server bound
    // to 0.0.0.0, and exits 0 iff RESULT ALL_PASS — i.e. the preview iframe
    // rendered the guest-served marker via the SW reverse-proxy → dispatch path.
    const out = execFileSync("node", [join(here, "..", "scripts", "app-vm-preview-e2e", "run.mjs")], {
      encoding: "utf8",
      timeout: 250_000, // < the it() timeout, so the inner one governs with a clean error
      maxBuffer: 32 * 1024 * 1024, // a dev-server boot + browser session logs a lot
      env: { ...process.env, CHROMIUM: chromium! },
    });
    expect(out).toMatch(/RESULT ALL_PASS/);
  }, 270_000);
});
