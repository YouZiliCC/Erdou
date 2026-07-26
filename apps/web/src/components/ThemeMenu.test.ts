// Regression tests for the titlebar theme picker (web-ui audit D3): `current`
// used to be seeded once with useState, so an applyTheme from OUTSIDE the menu
// — Studio.mountFolder applying a mounted folder's .erdou/config.json theme —
// repainted the page while the swatch and the picker's checkmark kept showing
// the old theme (TitleBar/ThemeMenu are rendered without a key, so they never
// remount). The menu now re-derives from the <html> data-theme attribute
// applyTheme stamps; this pins the subscription carrying that signal and the
// cached snapshot it feeds useSyncExternalStore.
// Node environment, no jsdom: document, localStorage and MutationObserver are
// stubbed — but the stub ROUTES an attribute write to the observers registered
// for it, so every test below drives the real applyTheme → <html> → subscriber
// path instead of poking the stub's stored callback.
import { describe, it, expect, vi, afterEach } from "vitest";
import { subscribeToTheme, themeSnapshot } from "./ThemeMenu";
import { applyTheme } from "../lib/theme";

interface Registration {
  target: unknown;
  options: MutationObserverInit;
  fire: () => void;
}

function stubDom(saved = "dark") {
  const live: Registration[] = [];
  const observed: Registration[] = []; // every observe() ever made, disconnected or not
  const html = {
    tag: "html",
    /** The one path an outside applyTheme has into the menu: hand the write to
     *  each LIVE observer watching this element for that attribute. */
    setAttribute(name: string, _value: string) {
      for (const r of [...live]) {
        if (r.target === html && r.options.attributeFilter?.includes(name)) r.fire();
      }
    },
  };
  class FakeObserver {
    private readonly cb: () => void;
    private reg: Registration | null = null;
    constructor(cb: () => void) {
      this.cb = cb;
    }
    observe(target: unknown, options: MutationObserverInit) {
      this.reg = { target, options, fire: this.cb };
      live.push(this.reg);
      observed.push(this.reg);
    }
    disconnect() {
      const i = this.reg ? live.indexOf(this.reg) : -1;
      if (i >= 0) live.splice(i, 1);
    }
  }
  const stored = new Map([["erdou.theme", saved]]);
  let reads = 0;
  vi.stubGlobal("MutationObserver", FakeObserver);
  vi.stubGlobal("document", { documentElement: html });
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => {
      reads += 1;
      return stored.get(k) ?? null;
    },
    setItem: (k: string, v: string) => void stored.set(k, v),
  });
  return { html, observed, liveCount: () => live.length, reads: () => reads };
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
    stubDom("dark");
    let notified = 0;
    subscribeToTheme(() => notified++);
    applyTheme("cream"); // what Studio.mountFolder does for a mounted folder's config
    expect(notified).toBe(1);
  });

  it("stops observing when unsubscribed", () => {
    const dom = stubDom("dark");
    let notified = 0;
    const unsubscribe = subscribeToTheme(() => notified++);
    unsubscribe();
    applyTheme("cream");
    expect(notified).toBe(0);
    expect(dom.liveCount()).toBe(0);
  });
});

describe("themeSnapshot (useSyncExternalStore re-reads it on every render)", () => {
  it("reads localStorage once per theme change, not once per read", () => {
    const dom = stubDom("dark");
    subscribeToTheme(() => {});
    expect(themeSnapshot()).toBe("dark");
    const afterFirstRead = dom.reads();
    expect(themeSnapshot()).toBe("dark");
    expect(themeSnapshot()).toBe("dark");
    expect(dom.reads()).toBe(afterFirstRead); // cached: no getItem per render
    applyTheme("cream"); // the notification that invalidates it
    expect(themeSnapshot()).toBe("cream");
  });

  it("re-reads on re-subscribe — a change landed while no observer was live", () => {
    stubDom("dark");
    const unsubscribe = subscribeToTheme(() => {});
    expect(themeSnapshot()).toBe("dark");
    unsubscribe();
    applyTheme("cream"); // menu unmounted: nothing left to clear the cache
    subscribeToTheme(() => {}); // remount — React re-reads the snapshot right after
    expect(themeSnapshot()).toBe("cream");
  });
});
