import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "index.html"), "utf8");

describe("index.html", () => {
  it("references no third-party origins (app must first-paint offline)", () => {
    // The whole app is served same-origin; any https:// URL in the shell
    // page is a render-blocking external dependency (see 46623f8: design
    // moved to system fonts, Google Fonts <link> was leftover dead code).
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("keeps the same-origin shell intact", () => {
    expect(html).toContain('href="/favicon.svg"');
    expect(html).toContain('src="/src/main.tsx"');
  });
});
