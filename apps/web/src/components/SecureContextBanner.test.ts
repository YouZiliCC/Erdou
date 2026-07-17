// Regression tests for the insecure-context banner copy (audit C5): on a plain
// http://<ip> origin the banner must (a) scope the breakage to preview +
// folder-mount and name what still works — the agent, terminal and model
// calls — and (b) offer a concrete remedy
// (SSH port-forward / TLS reverse proxy) — not just "use https or localhost",
// which is useless on a remote box. Node environment: window/navigator are
// stubbed per-test, no jsdom.
import { describe, it, expect, afterEach, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SecureContextBanner } from "./SecureContextBanner";

afterEach(() => vi.unstubAllGlobals());

function render() {
  return renderToStaticMarkup(createElement(SecureContextBanner));
}

describe("SecureContextBanner", () => {
  it("renders nothing when the context is secure and a Service Worker exists", () => {
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", { serviceWorker: {} });
    expect(render()).toBe("");
  });

  it("on an insecure context, scopes the breakage and names what still works", () => {
    vi.stubGlobal("window", { isSecureContext: false });
    vi.stubGlobal("navigator", {});
    const html = render();
    expect(html).toContain('role="alert"');
    expect(html).toContain("Preview");
    expect(html).toContain("folder-mount");
    // Must reassure that the agent, terminal and model calls are unaffected.
    // The agent claim is only true because startRun() uses newRunId()
    // (crypto.getRandomValues — not secure-context-gated) instead of the
    // [SecureContext]-only crypto.randomUUID; if that regresses, drop "agent"
    // from the banner copy again.
    expect(html).toContain("still work");
    expect(html).toMatch(/agent/i);
    expect(html).toMatch(/terminal/i);
    expect(html).toMatch(/model calls/i);
  });

  it("offers concrete remedies: SSH local port-forward and a TLS reverse proxy", () => {
    vi.stubGlobal("window", { isSecureContext: false });
    vi.stubGlobal("navigator", {});
    const html = render();
    expect(html).toContain("ssh -L 5173:localhost:5173 user@host");
    expect(html).toContain("http://localhost:5173");
    expect(html).toMatch(/reverse proxy/i);
  });

  it("renders when secure-context is true but Service Workers are unavailable", () => {
    // Both capabilities are required; missing SW alone must still surface.
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {});
    expect(render()).toContain('role="alert"');
  });
});
