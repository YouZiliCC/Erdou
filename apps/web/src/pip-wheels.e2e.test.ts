import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const chromium = ["/usr/bin/chromium-browser", "/usr/bin/chromium"].find(existsSync);
// Browser-kernel only — no VM state assets needed. Gated on an explicit flag +
// a Chromium binary because it boots the real Vite dev server and loads Pyodide
// (~10MB) from the CDN.
const RUN = process.env.ERDOU_WHEELS_E2E === "1" && !!chromium;

describe.skipIf(!RUN)("browser kernel pip local-wheel install e2e (gated)", () => {
  it("installs openpyxl from the local wheel index (no PyPI) and generates a real .xlsx", () => {
    const out = execFileSync("node", [join(here, "..", "scripts", "pip-wheels-e2e", "run.mjs")], {
      encoding: "utf8",
      timeout: 170_000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, CHROMIUM: chromium! },
    });
    expect(out).toMatch(/RESULT ALL_PASS/);
  }, 180_000);
});
