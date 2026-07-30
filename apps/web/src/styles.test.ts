import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "styles.css"), "utf8");
/** Comments stripped so a `/* … *\/` between rules cannot break the "preceded
 *  by `}`" anchor that keeps `.port-chip button` out of the match below. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the bare element-level `button { … }` rule — the global
 *  reset, not any of the class rules that also mention buttons. */
function globalButtonRule(): string {
  const m = /(^|\})\s*button\s*\{([^}]*)\}/.exec(rules);
  if (!m) throw new Error("styles.css has no element-level `button { … }` rule");
  return m[2]!;
}

describe("styles.css", () => {
  it("neutralizes the UA button background in the global reset", () => {
    // Without this the browser's `background-color: buttonface` shows through
    // on any button whose own rule sets no background — #efefef in light, a
    // mid-grey in dark. Under `color-scheme: dark` that grey is often brighter
    // than the app's selected-state fill, so a segmented control renders
    // backwards: the UNSELECTED items look raised and the selected one sunken.
    // Every button in the app happens to carry its own background today; this
    // rule is what keeps the NEXT one from shipping with buttonface.
    expect(globalButtonRule()).toMatch(/background\s*:\s*none/);
  });

  it("keeps the reset at element specificity, so component rules still win", () => {
    // A reset that outranked `.btn` / `.tabs .tab` would erase the design
    // instead of backstopping it. The rule must stay a bare element selector.
    expect(rules).toMatch(/(^|\})\s*button\s*\{/m);
    expect(globalButtonRule()).not.toMatch(/!important/);
  });
});
