// Regression tests for the Settings modal (web-ui audit D1/D2). The dialog holds
// every field in local useState with no confirmation, so any accidental dismissal
// discards a just-typed API key — hence the gesture and key-layering policies
// pinned here. App auto-opens the dialog on first load whenever no key is stored,
// so it must also behave like a real modal: role, label, and a focus wrap that
// makes its aria-modal claim true.
//
// Node environment, no jsdom: static-markup rendering only, matching
// Composer.test.ts. renderToStaticMarkup drops every event handler, so the
// policies (createScrimGesture / handleSelectKey / wrapTabTarget) are exercised
// directly, the ARIA attributes come from the rendered markup, and the scrim's
// USE of the gesture — the one piece of wiring whose loss silently restores the
// bug — is pinned by reading the JSX source. Still unpinned here, because they
// need a browser and are covered by manual headless verification: the document
// keydown listener (Escape/Tab) and the effects (initial focus, focus restore).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsDialog, createScrimGesture, wrapTabTarget } from "./SettingsDialog";
import { handleSelectKey } from "./ui/Select";

type DialogProps = Parameters<typeof SettingsDialog>[0];

function render(partial: Partial<DialogProps> = {}) {
  const props: DialogProps = {
    initial: { provider: "openai-compatible", baseUrl: "/llm/v1", model: "gpt-4o-mini", apiKey: "" },
    approvalMode: "auto",
    onApprovalModeChange: () => {},
    onSave: () => {},
    onClose: () => {},
    ...partial,
  };
  return renderToStaticMarkup(createElement(SettingsDialog, props));
}

describe("createScrimGesture (D1: a drag across the dialog edge must not discard edits)", () => {
  const scrim = { id: "scrim" } as unknown as EventTarget;
  const apiKeyInput = { id: "input" } as unknown as EventTarget;
  const on = (target: EventTarget) => ({ target, currentTarget: scrim });

  it("dismisses a plain scrim click — press and release both on the scrim itself", () => {
    const g = createScrimGesture();
    g.onMouseDown(on(scrim));
    g.onMouseUp(on(scrim));
    expect(g.dismisses()).toBe(true);
  });

  it("does NOT dismiss a drag that started inside the dialog and released on the scrim", () => {
    const g = createScrimGesture();
    g.onMouseDown(on(apiKeyInput));
    g.onMouseUp(on(scrim));
    expect(g.dismisses()).toBe(false);
  });

  it("does NOT dismiss the reverse drag: pressed on the scrim, released inside the dialog", () => {
    const g = createScrimGesture();
    g.onMouseDown(on(scrim));
    g.onMouseUp(on(apiKeyInput));
    expect(g.dismisses()).toBe(false);
  });

  it("does not carry a previous gesture's release into the next press", () => {
    const g = createScrimGesture();
    g.onMouseDown(on(scrim));
    g.onMouseUp(on(scrim));
    // Second gesture: mouseup happens where the scrim never sees it (released
    // outside the window), so nothing may dismiss on the stale `true`.
    g.onMouseDown(on(scrim));
    expect(g.dismisses()).toBe(false);
  });
});

describe("scrim wiring (D1: the gesture above is inert unless the JSX consults it)", () => {
  const SOURCE = readFileSync(new URL("./SettingsDialog.tsx", import.meta.url), "utf8");

  /** The scrim <div>'s props: from its className to the dialog it wraps. */
  function scrimProps(): string {
    const start = SOURCE.indexOf('className="scrim"');
    const end = SOURCE.indexOf('className="dialog"', start);
    if (start < 0 || end < 0) {
      throw new Error('SettingsDialog.tsx has no className="scrim" wrapping a className="dialog" — this slice is stale');
    }
    return SOURCE.slice(start, end);
  }

  it("hands the scrim BOTH ends of the press to the gesture", () => {
    // Losing either prop leaves that end permanently false (never dismisses) or
    // unrecorded (dismisses on a cross-edge drag) — the D1 bug, both directions.
    expect(scrimProps()).toContain("onMouseDown={scrim.onMouseDown}");
    expect(scrimProps()).toContain("onMouseUp={scrim.onMouseUp}");
  });

  it("gates the click on the gesture rather than closing on any click", () => {
    // `onClick={onClose}` is exactly the pre-fix wiring: it discards every
    // unsaved field for a drag that merely ended on the scrim.
    expect(scrimProps()).toMatch(/onClick=\{[^}]*scrim\.dismisses\(\)/);
  });

  it("keeps one gesture per dialog, surviving re-renders", () => {
    // A createScrimGesture() called in the render body would forget the press
    // whenever anything re-rendered the dialog between mousedown and click.
    expect(SOURCE).toContain("useRef(createScrimGesture()).current");
  });
});

describe("handleSelectKey (Escape must close the innermost layer only)", () => {
  function fakeEvent(key: string) {
    const touched = { stopPropagation: 0, preventDefault: 0 };
    return {
      touched,
      e: {
        key,
        preventDefault: () => void touched.preventDefault++,
        stopPropagation: () => void touched.stopPropagation++,
      },
    };
  }
  const noop = { openList: () => {}, move: () => {}, choose: () => {}, close: () => {} };

  it("closes an OPEN popover and stops the keydown so the hosting dialog never sees it", () => {
    const { e, touched } = fakeEvent("Escape");
    let closed = 0;
    handleSelectKey(e, true, { ...noop, close: () => closed++ });
    expect(closed).toBe(1);
    // SyntheticEvent.stopPropagation forwards to the native event React 18 is
    // dispatching at the root container; without it the keydown reaches
    // SettingsDialog's document listener, which closes the whole dialog and
    // discards every unsaved field.
    expect(touched.stopPropagation).toBe(1);
  });

  it("leaves Escape alone when the popover is CLOSED, so the dialog can still close", () => {
    const { e, touched } = fakeEvent("Escape");
    handleSelectKey(e, false, noop);
    expect(touched).toEqual({ stopPropagation: 0, preventDefault: 0 });
  });

  it("consumes the keys it acts on: ArrowDown moves the active option in an open popover", () => {
    const { e, touched } = fakeEvent("ArrowDown");
    const moves: number[] = [];
    handleSelectKey(e, true, { ...noop, move: (d) => moves.push(d) });
    expect(moves).toEqual([1]);
    expect(touched.stopPropagation).toBe(1);
  });

  it("ignores keys it does not act on, open or closed", () => {
    for (const open of [true, false]) {
      const { e, touched } = fakeEvent("a");
      handleSelectKey(e, open, noop);
      expect(touched).toEqual({ stopPropagation: 0, preventDefault: 0 });
    }
  });
});

describe("wrapTabTarget (D2: aria-modal is only honest if Tab cannot leave the dialog)", () => {
  const items = ["provider", "baseUrl", "model", "apiKey", "save"];

  it("sends Tab from the last control back to the first", () => {
    expect(wrapTabTarget(items, "save", false)).toBe("provider");
  });

  it("sends Shift+Tab from the first control to the last", () => {
    expect(wrapTabTarget(items, "provider", true)).toBe("save");
  });

  it("lets the browser handle Tab in the middle of the dialog", () => {
    expect(wrapTabTarget(items, "model", false)).toBeNull();
    expect(wrapTabTarget(items, "model", true)).toBeNull();
  });

  it("pulls focus back in when it sits outside the dialog (clicking the scrim leaves it on <body>)", () => {
    expect(wrapTabTarget(items, "titlebar-button", false)).toBe("provider");
    expect(wrapTabTarget(items, null, false)).toBe("provider");
    expect(wrapTabTarget(items, null, true)).toBe("save");
  });

  it("does nothing when there is nothing to focus", () => {
    expect(wrapTabTarget([], "anything", false)).toBeNull();
  });
});

describe("SettingsDialog modal semantics (D2 a11y)", () => {
  it("marks the dialog as a modal labelled by its own heading", () => {
    const html = render();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(html);
    expect(labelledBy).not.toBeNull();
    // The referenced id must actually be the "Model connection" heading.
    expect(html).toContain(`<h2 id="${labelledBy![1]}">Model connection</h2>`);
  });
});
