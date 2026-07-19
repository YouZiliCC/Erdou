import { describe, it, expect } from "vitest";
import type { HttpResponse } from "@erdou/runtime-contract";
import {
  rewriteHtml,
  injectPreviewScripts,
  isRewritableHtml,
  WS_SHIM_SOURCE,
  PREVIEW_HOOK_SOURCE,
} from "./preview-inject.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = new TextDecoder();

function htmlRes(body: string, headers: Record<string, string> = { "content-type": "text/html" }): HttpResponse {
  return { status: 200, headers, body: enc(body) };
}

describe("rewriteHtml", () => {
  it("inserts the scripts immediately after an attributed <head …> tag, in order", () => {
    const res = htmlRes('<!DOCTYPE html><html><head lang="en"><title>t</title></head><body></body></html>');
    const out = rewriteHtml(res, ["window.a=1", "window.b=2"]);
    expect(out).not.toBe(res);
    const text = dec.decode(out.body);
    expect(text).toContain('<head lang="en"><script>window.a=1</script><script>window.b=2</script><title>');
    // the original bytes are untouched (pure — no mutation)
    expect(dec.decode(res.body)).not.toContain("window.a=1");
  });

  it("without <head>, inserts AFTER the doctype so standards mode survives", () => {
    const out = rewriteHtml(htmlRes("<!doctype html>\n<h1>x</h1>"), ["window.a=1"]);
    expect(dec.decode(out.body)).toBe("<!doctype html><script>window.a=1</script>\n<h1>x</h1>");
  });

  it("headless and doctype-less HTML gets the scripts prepended", () => {
    const out = rewriteHtml(htmlRes("<h1>x</h1>"), ["window.a=1"]);
    expect(dec.decode(out.body)).toBe("<script>window.a=1</script><h1>x</h1>");
  });

  it("returns the SAME object (byte-identical passthrough) for non-HTML, non-utf8 charsets, content-encoding, streams, and empty inserts", () => {
    const json = { status: 200, headers: { "content-type": "application/json" }, body: enc("{}") };
    expect(rewriteHtml(json, ["x"])).toBe(json);

    const latin = htmlRes("<head></head>", { "content-type": "text/html; charset=iso-8859-1" });
    expect(rewriteHtml(latin, ["x"])).toBe(latin);

    const gzip = htmlRes("<head></head>", { "content-type": "text/html", "content-encoding": "gzip" });
    expect(rewriteHtml(gzip, ["x"])).toBe(gzip);

    const streamed: HttpResponse = {
      status: 200,
      headers: { "content-type": "text/html" },
      body: new Uint8Array(),
      stream: (async function* () {})(),
    };
    expect(rewriteHtml(streamed, ["x"])).toBe(streamed);

    const html = htmlRes("<head></head>");
    expect(rewriteHtml(html, [])).toBe(html);
  });

  it("utf-8 charsets (quoted or not) are rewritable; isRewritableHtml agrees", () => {
    const a = htmlRes("<head></head>", { "content-type": "text/html; charset=utf-8" });
    const b = htmlRes("<head></head>", { "content-type": 'TEXT/HTML; charset="UTF-8"' });
    expect(rewriteHtml(a, ["x"])).not.toBe(a);
    expect(rewriteHtml(b, ["x"])).not.toBe(b);
    expect(isRewritableHtml(a)).toBe(true);
    expect(isRewritableHtml(htmlRes("x", { "content-type": "text/plain" }))).toBe(false);
  });

  it("recomputes content-length ONLY when the response carried one (any header casing)", () => {
    const body = "<head></head>";
    const withCl = htmlRes(body, { "Content-Type": "text/html", "Content-Length": String(body.length) });
    const out = rewriteHtml(withCl, ["abc"]);
    expect(out.headers["content-length"]).toBe(String(out.body.length));
    expect(out.headers["Content-Length"]).toBeUndefined(); // stale casing removed, not duplicated
    expect(out.body.length).toBeGreaterThan(body.length);

    const without = htmlRes(body);
    expect(rewriteHtml(without, ["abc"]).headers["content-length"]).toBeUndefined();
  });

  it("drops a guest Content-Security-Policy when injecting (it would block the injected scripts)", () => {
    const res = htmlRes("<head></head>", {
      "content-type": "text/html",
      "content-security-policy": "script-src 'none'",
    });
    const out = rewriteHtml(res, ["x"]);
    expect(out.headers["content-security-policy"]).toBeUndefined();
    // …but an untouched response keeps its CSP.
    const plain = { status: 200, headers: { "content-type": "text/plain", "content-security-policy": "x" }, body: enc("") };
    expect(rewriteHtml(plain, ["x"]).headers["content-security-policy"]).toBe("x");
  });
});

describe("injectPreviewScripts (the bridge's policy)", () => {
  const doc = () => htmlRes("<html><head></head><body></body></html>");

  it("injects the console hook + WebSocket shim into document/iframe destinations only, hook FIRST", () => {
    for (const dest of ["document", "iframe"]) {
      const out = injectPreviewScripts(doc(), dest);
      const text = dec.decode(out.body);
      expect(text).toContain("__erdouWsShim");
      expect(text).toContain("__erdouLogs");
      // The console wrap must be installed before the shim (or any guest code)
      // can log — hook script strictly precedes the shim script.
      expect(text.indexOf("__erdouLogs")).toBeLessThan(text.indexOf("__erdouWsShim"));
    }
    for (const dest of ["script", "style", "empty", "", undefined]) {
      const res = doc();
      expect(injectPreviewScripts(res, dest)).toBe(res); // incl. `undefined` = pre-dest SW version skew
    }
  });

  it("non-HTML documents pass through even for document destinations", () => {
    const json = { status: 200, headers: { "content-type": "application/json" }, body: enc("{}") };
    expect(injectPreviewScripts(json, "document")).toBe(json);
  });
});

describe("PREVIEW_HOOK_SOURCE", () => {
  it("is safe to embed in a <script> tag and carries the buffer marker", () => {
    expect(PREVIEW_HOOK_SOURCE).not.toContain("</script>"); // would terminate the injected tag early
    expect(PREVIEW_HOOK_SOURCE).toContain("__erdouLogs");
  });

  interface Entry {
    kind: string;
    t: number;
    text: string;
  }
  type Buffer = Entry[] & { dropped?: number };

  /** Evaluate the hook against a minimal fake window (the hook references all
   *  globals via `window.` for exactly this reason). */
  function installHook() {
    const forwarded: Record<string, unknown[][]> = { log: [], info: [], warn: [], error: [], debug: [] };
    const listeners: Record<string, (e: unknown) => void> = {};
    type ConsoleKey = "log" | "info" | "warn" | "error" | "debug";
    const wrap =
      (k: ConsoleKey) =>
      (...a: unknown[]): void => {
        forwarded[k]!.push(a);
      };
    const win: {
      console: Record<ConsoleKey, (...a: unknown[]) => void>;
      addEventListener: (name: string, cb: (e: unknown) => void) => void;
      __erdouLogs?: Buffer;
    } = {
      console: { log: wrap("log"), info: wrap("info"), warn: wrap("warn"), error: wrap("error"), debug: wrap("debug") },
      addEventListener: (name, cb) => {
        listeners[name] = cb;
      },
    };
    const run = () => new Function("window", PREVIEW_HOOK_SOURCE)(win);
    run();
    return { win, forwarded, listeners, run, logs: () => win.__erdouLogs! };
  }

  it("wraps console methods: captures {kind,t,text} AND still forwards to the original", () => {
    const h = installHook();
    h.win.console.log("hello", { a: 1 });
    h.win.console.warn("careful");
    expect(h.logs().map((e) => `${e.kind}:${e.text}`)).toEqual(['log:hello {"a":1}', "warn:careful"]);
    expect(h.logs()[0]!.t).toBeTypeOf("number");
    expect(h.forwarded.log).toEqual([["hello", { a: 1 }]]); // DevTools still sees it
    expect(h.forwarded.warn).toEqual([["careful"]]);
  });

  it("is idempotent: running the hook twice never double-wraps", () => {
    const h = installHook();
    h.run(); // second injection (e.g. a duplicated script) is a no-op
    h.win.console.log("once");
    expect(h.logs()).toHaveLength(1);
    expect(h.forwarded.log).toEqual([["once"]]);
  });

  it("formats Errors with their stack and survives unstringifiable args", () => {
    const h = installHook();
    h.win.console.error(new Error("ka-boom"));
    const circular: Record<string, unknown> = {};
    circular.self = circular; // JSON.stringify throws -> String() fallback
    h.win.console.log(circular);
    expect(h.logs()[0]!.text).toContain("ka-boom");
    expect(h.logs()[1]!.text).toBe("[object Object]");
  });

  it("caps each entry's text at 2000 chars", () => {
    const h = installHook();
    h.win.console.log("x".repeat(5000));
    expect(h.logs()[0]!.text).toHaveLength(2001); // 2000 + the ellipsis
    expect(h.logs()[0]!.text.endsWith("…")).toBe(true);
  });

  it("caps the buffer at 500 entries, dropping the OLDEST and counting drops", () => {
    const h = installHook();
    for (let i = 0; i < 507; i++) h.win.console.log(`m${i}`);
    expect(h.logs()).toHaveLength(500);
    expect(h.logs().dropped).toBe(7);
    expect(h.logs()[0]!.text).toBe("m7"); // oldest went first
    expect(h.logs()[499]!.text).toBe("m506");
  });

  it("captures uncaught errors (with file:line) and unhandled rejections via window events", () => {
    const h = installHook();
    expect(Object.keys(h.listeners).sort()).toEqual(["error", "unhandledrejection"]);
    h.listeners.error!({ message: "boom-click", filename: "/app.js", lineno: 34 });
    h.listeners.error!({}); // a pathological empty ErrorEvent still records something
    h.listeners.unhandledrejection!({ reason: new Error("early-rejection") });
    h.listeners.unhandledrejection!({ reason: "plain-reason" });
    const got = h.logs().map((e) => `${e.kind}:${e.text}`);
    expect(got[0]).toBe("uncaught:boom-click @/app.js:34");
    expect(got[1]).toBe("uncaught:error @?:0");
    expect(got[2]).toContain("unhandledrejection:");
    expect(got[2]).toContain("early-rejection");
    expect(got[3]).toBe("unhandledrejection:plain-reason");
  });
});

describe("WS_SHIM_SOURCE", () => {
  it("is safe to embed in a <script> tag and carries the shim marker + tunnel envelope", () => {
    expect(WS_SHIM_SOURCE).not.toContain("</script>"); // would terminate the injected tag early
    expect(WS_SHIM_SOURCE).toContain("__erdouWsShim");
    expect(WS_SHIM_SOURCE).toContain("erdou:ws-open");
    expect(WS_SHIM_SOURCE).toContain("location.origin"); // origin-targeted post, never "*"
  });

  it("is syntactically valid JS that installs the patch on a window-like global", () => {
    // Evaluate the shim against a minimal fake window: it must run, mark
    // itself installed, and replace WebSocket with the patched class.
    class FakeNativeWS {}
    const win: Record<string, unknown> = { WebSocket: FakeNativeWS };
    const run = new Function(
      "window", "location", "parent",
      `const self=window; ${WS_SHIM_SOURCE}`,
    );
    // A non-preview location: the shim still installs (it falls through to the
    // native WebSocket at construction time for non-tunnelable targets).
    run(win, { pathname: "/", href: "http://x/", origin: "http://x" }, {});
    expect(win.__erdouWsShim).toBe(true);
    expect(win.WebSocket).not.toBe(FakeNativeWS);
    expect((win.WebSocket as { __erdouShim?: boolean }).__erdouShim).toBe(true);
  });
});
