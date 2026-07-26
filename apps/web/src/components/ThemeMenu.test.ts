// Regression test for the titlebar theme picker (web-ui audit D3): `current`
// used to be seeded once with useState, so an applyTheme from OUTSIDE the menu
// — Studio.mountFolder applying a mounted folder's .erdou/config.json theme —
// repainted the page while the swatch and the picker's checkmark kept showing
// the old theme (TitleBar/ThemeMenu are rendered without a key, so they never
// remount). The menu now re-derives from the <html> data-theme attribute
// applyTheme stamps; this pins the subscription that carries that signal.
// Node environment, no jsdom: document + MutationObserver are stubbed.
import { describe, it, expect, vi, afterEach } from "vitest";
import { subscribeToTheme } from "./ThemeMenu";

interface Observed {
  target: unknown;
  options: MutationObserverInit;
}

function stubDom() {
  const html = { tag: "html" };
  const observed: Observed[] = [];
  let disconnected = 0;
  let fire: (() => void) | null = null;
  class FakeObserver {
    constructor(cb: () => void) {
      fire = cb;
    }
    observe(target: unknown, options: MutationObserverInit) {
      observed.push({ target, options });
    }
    disconnect() {
      disconnected += 1;
    }
  }
  vi.stubGlobal("MutationObserver", FakeObserver);
  vi.stubGlobal("document", { documentElement: html });
  return { html, observed, fire: () => fire?.(), disconnectedCount: () => disconnected };
}

afterEach(() => vi.unstubAllGlobals());

describe("subscribeToTheme", () => {
  it("watches <html>'s data-theme — the attribute every applyTheme caller stamps", () => {
    const dom = stubDom();
    subscribeToTheme(() => {});
    expect(dom.observed).toHaveLength(1);
    expect(dom.observed[0]!.target).toBe(dom.html);
    expect(dom.observed[0]!.options.attributeFilter).toEqual(["data-theme"]);
  });

  it("notifies on a theme change made outside this component", () => {
    const dom = stubDom();
    let notified = 0;
    subscribeToTheme(() => notified++);
    dom.fire();
    expect(notified).toBe(1);
  });

  it("stops observing when unsubscribed", () => {
    const dom = stubDom();
    const unsubscribe = subscribeToTheme(() => {});
    unsubscribe();
    expect(dom.disconnectedCount()).toBe(1);
  });
});
