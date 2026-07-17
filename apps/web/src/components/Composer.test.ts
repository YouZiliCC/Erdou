// Regression tests for the Composer's stop affordance (audit D1 follow-up):
// the run abort is checkpoint-based — during an in-flight model call it can't
// take effect until the HTTP response arrives — so after Stop is clicked the
// button must flip to a disabled "Stopping…" state instead of an active Stop
// that looks ignored (and invites repeat clicks). Node environment, no jsdom:
// static-markup rendering only, matching Conversation.test.ts.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Composer } from "./Composer";

type ComposerProps = Parameters<typeof Composer>[0];

function render(partial: Partial<ComposerProps>) {
  const props: ComposerProps = {
    running: false,
    canStop: false,
    stopping: false,
    replying: false,
    mode: "auto",
    prefill: { text: "", nonce: 0 },
    onModeChange: () => {},
    onRun: () => {},
    onStop: () => {},
    ...partial,
  };
  return renderToStaticMarkup(createElement(Composer, props));
}

describe("Composer stop button (D1 stopping state)", () => {
  it("shows an ENABLED Stop while a stoppable run is in flight", () => {
    const html = render({ running: true, canStop: true });
    expect(html).toMatch(/<button class="btn run">Stop<\/button>/);
    expect(html).not.toContain("Stopping…");
  });

  it("flips to a DISABLED 'Stopping…' once stop was requested", () => {
    const html = render({ running: true, canStop: true, stopping: true });
    expect(html).toMatch(/<button class="btn run" disabled="">Stopping…<\/button>/);
    expect(html).not.toMatch(/>Stop</);
  });

  it("running without canStop (e.g. a kernel switch) shows Working…, not Stop", () => {
    const html = render({ running: true, canStop: false });
    expect(html).toContain("Working…");
    expect(html).not.toMatch(/>Stop(ping…)?</);
  });

  it("idle shows the Run button", () => {
    const html = render({});
    expect(html).toContain("Run ⌘⏎");
    expect(html).not.toMatch(/>Stop/);
  });
});
