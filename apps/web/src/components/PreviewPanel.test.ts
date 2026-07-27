// Regression tests for the OWNER-addressed preview: every preview URL this tab
// builds must name the Service Worker client id the SW dispatches by
// (`/__preview__/<owner>/<port>/`), and the panel must tell the two "no owner
// yet" states apart — a handshake still in flight is not a failure.
//
// Node environment, no jsdom: static-markup rendering only, matching
// DiffPanel.test.ts / Composer.test.ts. Two limits of that pattern shape what is
// pinned and how:
//   * effects never run, so PreviewPanel's `selectedPort` (set from the
//     selection effect) is always null there — the three stage states are
//     rendered through `PreviewStage`, which takes the port as a prop for
//     exactly this reason;
//   * event handlers are dropped from the markup, so the ↗ popup's URL cannot
//     be observed by rendering; it is pinned by reading the JSX source (the
//     SettingsDialog.test.ts precedent) — the drift that matters is a call site
//     rebuilding the path itself instead of going through previewUrl(), which
//     no rendered attribute can reveal.
import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BrowserRuntime } from "@erdou/runtime-browser";
import { Studio } from "../lib/studio";
import { PreviewPanel, PreviewStage } from "./PreviewPanel";

const OWNER = "tab-9f1c2d3e";

/** The slice of Studio these two components read. `previewTransport` is a
 *  getter on the real Studio (derived from previewClientId + the settled flag);
 *  a plain property satisfies the same structural type here. */
function studioFake(
  partial: { previewClientId?: string | null; previewTransport?: Studio["previewTransport"]; openPorts?: { port: number }[] } = {},
): Studio {
  return {
    fs: new BrowserRuntime().fs, // empty workspace: no run-command prefill, no bundle entry
    kernelKind: "browser",
    openPorts: partial.openPorts ?? [],
    previewRequest: null,
    switchingKernel: null,
    previewClientId: partial.previewClientId ?? null,
    previewTransport: partial.previewTransport ?? "pending",
    registerPreviewFrame: () => {},
  } as unknown as Studio;
}

const stage = (studio: Studio, viewedPort = 8080, nonce = 0): string =>
  renderToStaticMarkup(createElement(PreviewStage, { studio, viewedPort, nonce }));

describe("PreviewStage: the iframe is addressed to THIS tab", () => {
  it("builds src as /__preview__/<owner>/<port>/ — the owner segment, not the bare port", () => {
    const html = stage(studioFake({ previewClientId: OWNER, previewTransport: "ready" }));
    expect(html).toContain(`src="/__preview__/${OWNER}/8080/"`);
    // The pre-owner shape: it still LOOKS like a preview URL, but the SW parses
    // the first segment as the owner, so it can only ever 503.
    expect(html).not.toContain('src="/__preview__/8080/"');
  });

  it("tracks the owner AND the port — neither is baked in", () => {
    const other = studioFake({ previewClientId: "tab-00000001", previewTransport: "ready" });
    expect(stage(other, 3000)).toContain('src="/__preview__/tab-00000001/3000/"');
  });

  it("mounts a sandboxed iframe once the owner is known (and nothing else)", () => {
    const html = stage(studioFake({ previewClientId: OWNER, previewTransport: "ready" }));
    expect(html).toContain('sandbox="allow-scripts allow-same-origin"');
    expect(html).not.toContain("build-errors");
    expect(html).not.toContain("Starting the preview transport");
  });
});

describe("PreviewStage: pending is not failure", () => {
  it("a still-in-flight handshake says STARTING — never 'reload the page'", () => {
    // The bridge waits for the SW to activate and then for its whoami reply;
    // `erdou serve` opens a port in milliseconds, so a port routinely lands
    // inside that window on a first load. Telling the user to reload there just
    // restarts the wait they are already in.
    const html = stage(studioFake({ previewClientId: null, previewTransport: "pending" }));
    expect(html).toContain("Starting the preview transport");
    expect(html).toContain("8080"); // names the port that is waiting
    expect(html).not.toContain("Reload the page");
    expect(html).not.toContain("build-errors");
    expect(html).not.toContain("<iframe");
  });

  it("a SETTLED handshake with no id fails loud, and serves no frame", () => {
    const html = stage(studioFake({ previewClientId: null, previewTransport: "failed" }));
    expect(html).toContain("build-errors");
    expect(html).toContain("Preview transport unavailable");
    expect(html).toContain("Reload the page");
    expect(html).not.toContain("Starting the preview transport");
    expect(html).not.toContain("<iframe");
  });
});

describe("PreviewPanel ports bar: the ↗ popup follows the same transport", () => {
  const bar = (t: Studio["previewTransport"], id: string | null) =>
    renderToStaticMarkup(
      createElement(PreviewPanel, {
        studio: studioFake({ previewClientId: id, previewTransport: t, openPorts: [{ port: 8080 }] }),
      }),
    );

  it("is enabled with the plain title once this tab has an owner id", () => {
    const html = bar("ready", OWNER);
    expect(html).toContain('title="Open in new tab"');
    expect(html).not.toMatch(/<button[^>]*title="Open in new tab"[^>]*disabled/);
  });

  it("is DISABLED while the handshake is in flight, and says so as 'starting', not 'unavailable'", () => {
    // A popup opened now would carry a URL with no owner — the SW's 503 path.
    const html = bar("pending", null);
    expect(html).toMatch(/title="Starting the preview transport[^"]*" disabled=""/);
    expect(html).not.toContain("Open in new tab");
  });

  it("is DISABLED with the terminal wording once the handshake settled empty", () => {
    const html = bar("failed", null);
    expect(html).toMatch(/title="Unavailable: this tab has no preview transport" disabled=""/);
    expect(html).not.toContain("Open in new tab");
  });
});

// The panel tests above FEED previewTransport in as a fake value, so they say
// nothing about where the real one comes from — and a page stuck reporting
// "pending" forever renders the same "starting…" hint as a healthy one, i.e. the
// failure is silent. This pins the seam: the derivation, and the boot wiring
// that moves it off "pending". (fake-indexeddb because Studio.boot loads run
// history from IndexedDB — the studio lifecycle tests' idiom.)
describe("Studio.previewTransport — the value those three states are derived from", () => {
  it("a fresh page is PENDING: previewClientId is null here too, the settled flag is what differs", () => {
    const studio = new Studio();
    expect(studio.previewClientId).toBeNull();
    expect(studio.previewTransport).toBe("pending");
  });

  it("settled without an id is failed; settled with one is ready", () => {
    const studio = new Studio();
    studio.previewProxySettled = true;
    expect(studio.previewTransport).toBe("failed");
    studio.previewClientId = OWNER;
    expect(studio.previewTransport).toBe("ready");
  });

  it("boot SETTLES it — a no-Service-Worker environment ends up failed, never stuck pending", async () => {
    // The node test env has no navigator.serviceWorker, so startPreviewProxy
    // resolves null immediately: exactly the path that must still flip the
    // settled flag, or the panel would wait for a handshake nobody is running.
    const studio = new Studio();
    await studio.boot();
    expect(studio.previewProxySettled).toBe(true);
    expect(studio.previewTransport).toBe("failed");
  });
});

describe("both preview URLs are built by previewUrl()", () => {
  // Static-markup rendering drops onClick, so the ↗ popup's URL is unobservable
  // in markup — and a call site that rebuilt the path inline would still render
  // an identical ports bar while 503-ing at the SW. Source-level, like
  // SettingsDialog.test.ts pins its scrim gesture.
  const src = readFileSync(new URL("./PreviewPanel.tsx", import.meta.url), "utf8");

  it("the iframe src and the ↗ popup both call the shared builder", () => {
    expect(src).toContain("src={previewUrl(owner, viewedPort)}");
    expect(src).toContain('window.open(previewUrl(owner, p.port), "_blank", "noopener")');
  });

  it("nothing in the panel spells the preview path out itself", () => {
    // Any interpolated /__preview__/… here means a second place that must be
    // kept in sync with the SW's parser — the drift the builder exists to stop.
    expect(src).not.toMatch(/["'`]\/__preview__\/\$?\{/);
  });
});
