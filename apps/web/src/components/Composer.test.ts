// Regression tests for the Composer's stop affordance (audit D1 follow-up):
// the run abort is checkpoint-based — during an in-flight model call it can't
// take effect until the HTTP response arrives — so after Stop is clicked the
// button must flip to a disabled "Stopping…" state instead of an active Stop
// that looks ignored (and invites repeat clicks). Node environment, no jsdom:
// static-markup rendering only, matching Conversation.test.ts.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Composer, isSubmitKey, type ComposerKey } from "./Composer";

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

  it("idle shows the Run button (Enter to send)", () => {
    const html = render({});
    expect(html).toContain("Run ⏎");
    expect(html).not.toMatch(/>Stop/);
  });

  it("keeps the textarea editable WHILE running (compose your next message ahead)", () => {
    const html = render({ running: true, canStop: true });
    expect(html).toMatch(/<textarea/);
    expect(html).not.toMatch(/<textarea[^>]*disabled/); // no longer hard-disabled during a run
  });
});

describe("Composer isSubmitKey (Enter sends, Shift+Enter newlines, IME-safe)", () => {
  const key = (over: Partial<ComposerKey> & { isComposing?: boolean; keyCode?: number } = {}): ComposerKey => ({
    key: over.key ?? "Enter",
    shiftKey: over.shiftKey ?? false,
    nativeEvent: { isComposing: over.isComposing ?? false, keyCode: over.keyCode ?? 13 },
  });

  it("plain Enter sends", () => {
    expect(isSubmitKey(key())).toBe(true);
  });

  it("Shift+Enter does NOT send (newline)", () => {
    expect(isSubmitKey(key({ shiftKey: true }))).toBe(false);
  });

  it("Cmd/Ctrl+Enter still sends (no Shift held)", () => {
    // metaKey/ctrlKey are irrelevant to the decision — only Shift branches to a
    // newline — so a user with ⌘⏎ muscle memory still submits.
    expect(isSubmitKey(key())).toBe(true);
  });

  it("a composing Enter (IME candidate confirmation) does NOT send", () => {
    expect(isSubmitKey(key({ isComposing: true }))).toBe(false);
  });

  it("a legacy composing Enter (keyCode 229, isComposing unset) does NOT send", () => {
    expect(isSubmitKey(key({ keyCode: 229 }))).toBe(false);
  });

  it("non-Enter keys never send", () => {
    expect(isSubmitKey(key({ key: "a" }))).toBe(false);
    expect(isSubmitKey(key({ key: "Tab" }))).toBe(false);
  });
});
