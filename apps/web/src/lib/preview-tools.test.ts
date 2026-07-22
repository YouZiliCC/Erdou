import { describe, it, expect } from "vitest";
import type { WsConnection } from "@erdou/runtime-contract";
import type { ToolContext } from "@erdou/agent-tools";
import {
  isWsOpenMessage, wsUpgradeRequest, openWsTunnel, WS_UNSUPPORTED_MESSAGE,
  createPreviewTools, previewFramePort, NO_PREVIEW_MESSAGE,
  type WsOpenMessage, type TunnelPort,
  type PreviewFrameLike, type PreviewDocumentLike, type PreviewElementLike, type PreviewLogBuffer,
} from "./preview-tools.js";

const OPEN: WsOpenMessage = { type: "erdou:ws-open", port: 8080, path: "/ws?room=1", protocols: [] };

/** A recording fake for the shim's end of the tunnel — sync delivery, no real
 *  MessageChannel needed (node's delivers on a macrotask; sync keeps the tests
 *  deterministic). `emit` plays a shim→page message into the pump. */
function fakePort(): { port: TunnelPort; sent: unknown[]; closed: () => number; emit: (m: unknown) => void } {
  const sent: unknown[] = [];
  let closed = 0;
  const port: TunnelPort = {
    postMessage: (m) => sent.push(m),
    close: () => {
      closed++;
    },
    onmessage: null,
  };
  return {
    port,
    sent,
    closed: () => closed,
    emit: (m) => port.onmessage?.({ data: m } as MessageEvent),
  };
}

/** A scripted contract WsConnection. */
function fakeWs(protocol = "") {
  let messageCb: ((data: string | Uint8Array) => void) | null = null;
  let closeCb: ((code: number, reason: string) => void) | null = null;
  const sent: Array<string | Uint8Array> = [];
  const closes: Array<[number | undefined, string]> = [];
  let dead = false;
  const ws: WsConnection = {
    protocol,
    send: (d) => {
      if (dead) throw new Error("WsConnection.send: the connection is closed");
      sent.push(d);
    },
    onMessage: (cb) => {
      messageCb = cb;
    },
    onClose: (cb) => {
      closeCb = cb;
    },
    close: (code, reason) => {
      closes.push([code, reason ?? ""]);
    },
  };
  return {
    ws,
    sent,
    closes,
    kill: () => {
      dead = true;
    },
    emitMessage: (d: string | Uint8Array) => messageCb!(d),
    emitClose: (code: number, reason: string) => closeCb!(code, reason),
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("isWsOpenMessage", () => {
  it("accepts the shim's envelope and rejects malformed shapes", () => {
    expect(isWsOpenMessage(OPEN)).toBe(true);
    expect(isWsOpenMessage({ ...OPEN, protocols: ["a", "b"] })).toBe(true);
    expect(isWsOpenMessage(null)).toBe(false);
    expect(isWsOpenMessage({})).toBe(false);
    expect(isWsOpenMessage({ ...OPEN, type: "erdou:req" })).toBe(false);
    expect(isWsOpenMessage({ ...OPEN, port: 0 })).toBe(false);
    expect(isWsOpenMessage({ ...OPEN, port: 70000 })).toBe(false);
    expect(isWsOpenMessage({ ...OPEN, port: 1.5 })).toBe(false);
    expect(isWsOpenMessage({ ...OPEN, path: "ws" })).toBe(false); // must be /-rooted
    expect(isWsOpenMessage({ ...OPEN, protocols: "chat" })).toBe(false);
    expect(isWsOpenMessage({ ...OPEN, protocols: [1] })).toBe(false);
  });
});

describe("wsUpgradeRequest", () => {
  it("builds a GET with the upgrade intent; subprotocols only when offered", () => {
    expect(wsUpgradeRequest(OPEN)).toEqual({
      method: "GET",
      url: "/ws?room=1",
      headers: { upgrade: "websocket", connection: "Upgrade" },
      body: new Uint8Array(),
    });
    expect(wsUpgradeRequest({ ...OPEN, protocols: ["chat", "log"] }).headers["sec-websocket-protocol"]).toBe(
      "chat, log",
    );
  });
});

describe("openWsTunnel", () => {
  it("declines fail-fast on a kernel without upgrade (the browser kernel): error + close 1006, port closed", async () => {
    const p = fakePort();
    let closedCbs = 0;
    const cleanup = await openWsTunnel({}, OPEN, p.port, () => closedCbs++);
    expect(cleanup).toBeNull();
    expect(p.sent).toEqual([
      { type: "error", message: WS_UNSUPPORTED_MESSAGE },
      { type: "close", code: 1006, reason: WS_UNSUPPORTED_MESSAGE, wasClean: false },
    ]);
    expect(p.closed()).toBe(1);
    expect(closedCbs).toBe(1);
  });

  it("surfaces an upgrade rejection verbatim (precise kernel error, not a generic failure)", async () => {
    const p = fakePort();
    const runtime = { upgrade: async () => Promise.reject(new Error("no server listening on port 8080")) };
    const cleanup = await openWsTunnel(runtime, OPEN, p.port);
    expect(cleanup).toBeNull();
    expect(p.sent[0]).toEqual({ type: "error", message: "no server listening on port 8080" });
    expect(p.sent[1]).toMatchObject({ type: "close", code: 1006 });
  });

  it("pumps both directions: open+protocol, text/binary frames, marshalling at each edge", async () => {
    const p = fakePort();
    const f = fakeWs("chat");
    const upgraded: Array<{ port: number; url: string }> = [];
    const runtime = {
      upgrade: async (port: number, req: { url: string }) => {
        upgraded.push({ port, url: req.url });
        return f.ws;
      },
    };
    const cleanup = await openWsTunnel(runtime, { ...OPEN, protocols: ["chat"] }, p.port);
    expect(cleanup).not.toBeNull();
    expect(upgraded).toEqual([{ port: 8080, url: "/ws?room=1" }]);
    expect(p.sent[0]).toEqual({ type: "open", protocol: "chat" });

    // shim → guest: strings pass through; ArrayBuffer + views become Uint8Array
    p.emit({ type: "frame", data: "hello" });
    p.emit({ type: "frame", data: new Uint8Array([1, 2, 3]).buffer });
    p.emit({ type: "frame", data: new Uint8Array([4, 5]) });
    await tick();
    expect(f.sent).toEqual(["hello", new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]);

    // guest → shim: text stays a string; binary becomes a (transferable) ArrayBuffer
    f.emitMessage("pong");
    f.emitMessage(new Uint8Array([9, 9]));
    expect(p.sent[1]).toEqual({ type: "frame", data: "pong" });
    const bin = p.sent[2] as { type: string; data: ArrayBuffer };
    expect(bin.type).toBe("frame");
    expect(new Uint8Array(bin.data)).toEqual(new Uint8Array([9, 9]));
  });

  it("Blob payloads are decoded asynchronously WITHOUT reordering later frames", async () => {
    const p = fakePort();
    const f = fakeWs();
    await openWsTunnel({ upgrade: async () => f.ws }, OPEN, p.port);
    p.emit({ type: "frame", data: new Blob([new Uint8Array([1])]) });
    p.emit({ type: "frame", data: "after-blob" }); // sync payload queued behind the async one
    await tick();
    await tick();
    expect(f.sent).toEqual([new Uint8Array([1]), "after-blob"]);
  });

  it("shim close → ws.close(code, reason); the guest's close echo comes back as a clean close", async () => {
    const p = fakePort();
    const f = fakeWs();
    let closedCbs = 0;
    await openWsTunnel({ upgrade: async () => f.ws }, OPEN, p.port, () => closedCbs++);
    p.emit({ type: "close", code: 1000, reason: "done" });
    await tick();
    expect(f.closes).toEqual([[1000, "done"]]);
    f.emitClose(1000, "done"); // the kernel completes the handshake
    expect(p.sent[1]).toEqual({ type: "close", code: 1000, reason: "done", wasClean: true });
    expect(p.closed()).toBe(1);
    expect(closedCbs).toBe(1);
  });

  it("a guest-side abnormal drop (1006) reaches the shim as wasClean:false, exactly once", async () => {
    const p = fakePort();
    const f = fakeWs();
    await openWsTunnel({ upgrade: async () => f.ws }, OPEN, p.port);
    f.emitClose(1006, "TCP connection closed without a WebSocket Close frame");
    f.emitClose(1006, "again"); // must not double-report
    const closeMsgs = p.sent.filter((m) => (m as { type: string }).type === "close");
    expect(closeMsgs).toEqual([
      { type: "close", code: 1006, reason: "TCP connection closed without a WebSocket Close frame", wasClean: false },
    ]);
  });

  it("cleanup() (bridge re-aimed) closes the guest side and tells the shim, idempotently", async () => {
    const p = fakePort();
    const f = fakeWs();
    let closedCbs = 0;
    const cleanup = (await openWsTunnel({ upgrade: async () => f.ws }, OPEN, p.port, () => closedCbs++))!;
    cleanup();
    cleanup(); // idempotent
    expect(f.closes).toEqual([[1001, "preview bridge released"]]);
    const closeMsgs = p.sent.filter((m) => (m as { type: string }).type === "close");
    expect(closeMsgs).toEqual([
      { type: "close", code: 1001, reason: "the preview bridge was re-aimed at a new runtime", wasClean: false },
    ]);
    expect(closedCbs).toBe(1);
    // frames after teardown are dropped, not forwarded to a dead kernel
    p.emit({ type: "frame", data: "late" });
    await tick();
    expect(f.sent).toEqual([]);
  });

  it("a send racing the close is discarded silently (per spec), never an unhandled throw", async () => {
    const p = fakePort();
    const f = fakeWs();
    await openWsTunnel({ upgrade: async () => f.ws }, OPEN, p.port);
    f.kill(); // guest connection died; its onClose is still in flight
    p.emit({ type: "frame", data: "racing" });
    await tick(); // would reject unhandled if the pump didn't guard
    expect(f.sent).toEqual([]);
  });

  it("an unknown frame payload shape fails fast: guest side closed 1002, shim told with a precise error", async () => {
    const p = fakePort();
    const f = fakeWs();
    await openWsTunnel({ upgrade: async () => f.ws }, OPEN, p.port);
    p.emit({ type: "frame", data: 42 });
    await tick();
    expect(f.closes).toEqual([[1002, "unsupported frame payload from the preview shim"]]);
    expect(p.sent.some((m) => (m as { type: string }).type === "error")).toBe(true);
  });
});

/* ------------------------- preview observation tools ------------------------- */

const CTX = {} as ToolContext; // the preview tools never touch ctx.runtime

/** Fast poll timings so failure-path tests don't wait wall-clock seconds. */
const FAST = { pollMs: 2, timeoutMs: 40 };

function el(outerHTML: string, onClick?: () => void): PreviewElementLike {
  return onClick ? { outerHTML, click: onClick } : { outerHTML, click: () => {} };
}

/** An Element-like WITHOUT click() (what a DOM `Element`, e.g. SVG, looks like). */
function unclickableEl(outerHTML: string): PreviewElementLike {
  return { outerHTML };
}

interface FakeDocOpts {
  readyState?: string;
  title?: string;
  url?: string;
  bodyText?: string;
  /** Fakes removable script/style nodes on the body clone. */
  strippable?: Array<{ remove(): void }>;
  matches?: Record<string, PreviewElementLike[]>;
}

function fakeDoc(opts: FakeDocOpts = {}): PreviewDocumentLike {
  const body =
    opts.bodyText === undefined
      ? null
      : {
          cloneNode: (): unknown => body,
          querySelectorAll: () => opts.strippable ?? [],
          textContent: opts.bodyText,
        };
  return {
    readyState: opts.readyState ?? "complete",
    title: opts.title ?? "Fake Page",
    URL: opts.url ?? "http://localhost/__preview__/8080/",
    body,
    querySelectorAll: (sel: string) => {
      const m = opts.matches?.[sel];
      if (m) return m;
      if (sel.startsWith("@")) throw new Error(`'${sel}' is not a valid selector`);
      return [];
    },
  };
}

function fakeFrame(
  doc: PreviewDocumentLike | null,
  logs?: PreviewLogBuffer,
): PreviewFrameLike & { swap: (d: PreviewDocumentLike) => void } {
  let current = doc;
  return {
    src: "/__preview__/8080/",
    get contentDocument() {
      return current;
    },
    contentWindow: logs === undefined ? {} : { __erdouLogs: logs },
    swap: (d) => {
      current = d;
    },
  };
}

/** A match carrying fake computed styles, read back by `styledFrame`'s
 *  getComputedStyle — lets a test drive the computed-style readout. */
type StyledEl = PreviewElementLike & { _computed: Record<string, string> };
function styledEl(outerHTML: string, computed: Record<string, string>): StyledEl {
  return { outerHTML, _computed: computed };
}

/** A frame whose contentWindow.getComputedStyle resolves each element's own
 *  `_computed` map (what a real Window does over real Elements). */
function styledFrame(doc: PreviewDocumentLike): PreviewFrameLike {
  return {
    src: "/__preview__/8080/",
    get contentDocument() {
      return doc;
    },
    contentWindow: {
      getComputedStyle: (elt: PreviewElementLike) => ({
        getPropertyValue: (prop: string) => (elt as StyledEl)._computed?.[prop] ?? "",
      }),
    },
  };
}

// COMPILE-TIME regression guard (bites via `pnpm --filter web typecheck`,
// which covers src tests): the studio wiring hands the REAL DOM iframe
// straight in — `...createPreviewTools(() => this.previewFrame)` with
// `previewFrame: HTMLIFrameElement | null` — so HTMLIFrameElement must stay
// structurally assignable to PreviewFrameLike. It once wasn't: an
// all-optional PreviewWindowLike tripped TS weak-type detection on `Window`
// (fixed by the optional `location` member; see preview-tools.ts).
const domFrameIsPreviewFrame: (el: HTMLIFrameElement | null) => PreviewFrameLike | null = (el) => el;
void domFrameIsPreviewFrame;

function tools(getFrame: () => PreviewFrameLike | null) {
  const byName = new Map(createPreviewTools(getFrame, FAST).map((t) => [t.name, t]));
  return {
    read: (args: Record<string, unknown> = {}) => byName.get("preview_read")!.execute(CTX, args),
    click: (args: Record<string, unknown> = {}) => byName.get("preview_click")!.execute(CTX, args),
    logs: (args: Record<string, unknown> = {}) => byName.get("preview_logs")!.execute(CTX, args),
  };
}

describe("previewFramePort", () => {
  it("parses the port from relative and absolute preview srcs", () => {
    expect(previewFramePort("/__preview__/8080/")).toBe(8080);
    expect(previewFramePort("http://localhost:5173/__preview__/3000/index.html")).toBe(3000);
    expect(previewFramePort("http://localhost:5173/somewhere/")).toBeNull();
  });
});

describe("createPreviewTools", () => {
  it("every tool fails fast with the no-preview message when no frame is mounted", async () => {
    const t = tools(() => null);
    for (const r of [await t.read(), await t.click({ selector: "#x" }), await t.logs()]) {
      expect(r.ok).toBe(false);
      expect(r.output).toBe(NO_PREVIEW_MESSAGE);
    }
  });

  it("a never-ready document fails with the OBSERVED readyState after the poll bound", async () => {
    const t = tools(() => fakeFrame(fakeDoc({ readyState: "loading" })));
    const r = await t.read();
    expect(r.ok).toBe(false);
    expect(r.output).toContain('still loading (readyState "loading"');
  });

  it("waits through a load: a doc that becomes ready mid-poll is read, not failed", async () => {
    const frame = fakeFrame(fakeDoc({ readyState: "loading" }));
    setTimeout(() => frame.swap(fakeDoc({ bodyText: "late but ready" })), 10);
    const r = await tools(() => frame).read();
    expect(r.ok).toBe(true);
    expect(r.output).toContain("late but ready");
  });

  it("a fresh iframe's initial about:blank counts as still-loading, not as a readable page", async () => {
    // A just-mounted iframe carries about:blank at readyState "complete" until
    // the real preview document commits — the tools must wait it out.
    const frame = fakeFrame(fakeDoc({ url: "about:blank", title: "", bodyText: "" }));
    setTimeout(() => frame.swap(fakeDoc({ bodyText: "real page" })), 10);
    const r = await tools(() => frame).read();
    expect(r.ok).toBe(true);
    expect(r.output).toContain("real page");
    // …and one that NEVER commits fails naming about:blank, not with a bogus snapshot.
    const stuck = await tools(() => fakeFrame(fakeDoc({ url: "about:blank" }))).read();
    expect(stuck.ok).toBe(false);
    expect(stuck.output).toContain("url about:blank");
  });

  describe("preview_read", () => {
    it("no selector: port prefix + URL + title + collapsed body text, scripts stripped", async () => {
      const removed: string[] = [];
      const doc = fakeDoc({
        title: "My App",
        bodyText: "  Hello \n\n  world\t! ",
        strippable: [{ remove: () => removed.push("script") }, { remove: () => removed.push("style") }],
      });
      const r = await tools(() => fakeFrame(doc)).read();
      expect(r.ok).toBe(true);
      expect(r.output).toBe(
        "[preview port 8080] http://localhost/__preview__/8080/\ntitle: My App\nbody text: Hello world !",
      );
      expect(removed).toEqual(["script", "style"]); // the clone's script/style nodes were removed
    });

    it("no selector: body text over the 4000-char cap is truncated with an explicit, actionable tail", async () => {
      const r = await tools(() => fakeFrame(fakeDoc({ bodyText: "x".repeat(6000) }))).read();
      expect(r.ok).toBe(true);
      expect(r.output).toContain("… [truncated 2000 chars — narrow with a selector]");
      expect(r.output.length).toBeLessThan(4200); // hard cap holds (4000 + framing)
    });

    it("no selector: an empty body reads as (empty), not as silence", async () => {
      const r = await tools(() => fakeFrame(fakeDoc({ bodyText: "" }))).read();
      expect(r.ok).toBe(true);
      expect(r.output).toContain("body text: (empty)");
    });

    it("selector: shows at most 5 matches, each outerHTML capped at 2000 chars", async () => {
      const matches = Array.from({ length: 7 }, (_, i) => el(`<li id="i${i}">${"y".repeat(i === 0 ? 3000 : 5)}</li>`));
      const r = await tools(() => fakeFrame(fakeDoc({ matches: { li: matches } }))).read({ selector: "li" });
      expect(r.ok).toBe(true);
      expect(r.output).toContain('7 matches for "li" (showing first 5):');
      expect(r.output).toContain("… [truncated"); // the 3000-char first match got capped
      expect(r.output).toContain('id="i4"');
      expect(r.output).not.toContain('id="i5"'); // beyond the cap
    });

    it("selector with no match fails fast, naming the selector", async () => {
      const r = await tools(() => fakeFrame(fakeDoc())).read({ selector: "#nope" });
      expect(r.ok).toBe(false);
      expect(r.output).toBe('[preview port 8080] no element matches selector "#nope" in the preview document.');
    });

    it("an invalid selector fails with the underlying parser error, not a crash", async () => {
      const r = await tools(() => fakeFrame(fakeDoc())).read({ selector: "@bad" });
      expect(r.ok).toBe(false);
      expect(r.output).toContain('invalid CSS selector "@bad"');
      expect(r.output).toContain("not a valid selector");
    });

    it("selector: reports key computed styles per match so the agent can see CSS actually applied", async () => {
      const header = styledEl("<header>H</header>", {
        display: "flex",
        color: "rgb(38, 59, 55)",
        "background-color": "rgb(244, 240, 233)",
        "font-family": "'DM Sans'",
        "font-size": "14px",
      });
      const r = await tools(() => styledFrame(fakeDoc({ matches: { header: [header] } }))).read({ selector: "header" });
      expect(r.ok).toBe(true);
      expect(r.output).toContain("<header>H</header>");
      expect(r.output).toContain("computed:");
      expect(r.output).toContain("display: flex");
      expect(r.output).toContain("background-color: rgb(244, 240, 233)");
      expect(r.output).toContain("font-family: 'DM Sans'");
    });

    it("selector: surfaces DEFAULT computed styles when CSS did NOT apply (the render failure the agent kept missing)", async () => {
      // A broken stylesheet leaves defaults: transparent bg, black text, block
      // display — the exact signal that a <style> exists but isn't taking effect.
      const header = styledEl("<header>H</header>", {
        display: "block",
        color: "rgb(0, 0, 0)",
        "background-color": "rgba(0, 0, 0, 0)",
        "font-family": "serif",
        "font-size": "16px",
      });
      const r = await tools(() => styledFrame(fakeDoc({ matches: { header: [header] } }))).read({ selector: "header" });
      expect(r.ok).toBe(true);
      expect(r.output).toContain("display: block");
      expect(r.output).toContain("background-color: rgba(0, 0, 0, 0)");
    });

    it("selector: omits the computed line when the window cannot compute styles (no getComputedStyle)", async () => {
      // fakeFrame's contentWindow has no getComputedStyle — must degrade, not throw.
      const r = await tools(() => fakeFrame(fakeDoc({ matches: { li: [el("<li>x</li>")] } }))).read({ selector: "li" });
      expect(r.ok).toBe(true);
      expect(r.output).toContain("<li>x</li>");
      expect(r.output).not.toContain("computed:");
    });
  });

  describe("preview_click", () => {
    it("clicks the FIRST match and reports the resulting URL/title", async () => {
      const clicked: string[] = [];
      const doc = fakeDoc({
        title: "After",
        url: "http://localhost/__preview__/8080/page",
        matches: { "#btn": [el("<button id=btn>", () => clicked.push("first")), el("<button>", () => clicked.push("second"))] },
      });
      const r = await tools(() => fakeFrame(doc)).click({ selector: "#btn" });
      expect(clicked).toEqual(["first"]); // first match only
      expect(r.ok).toBe(true);
      expect(r.output).toBe(
        '[preview port 8080] clicked "#btn" — now at http://localhost/__preview__/8080/page (title: "After")',
      );
    });

    it("a click that triggers a NAVIGATION waits out the load and reports the new document's URL/title", async () => {
      const target = fakeDoc({ title: "Page Two", url: "http://localhost/__preview__/8080/two" });
      const loading = fakeDoc({ readyState: "loading" });
      const frame = fakeFrame(
        fakeDoc({
          matches: {
            a: [
              el("<a href=two>", () => {
                frame.swap(loading); // navigation began…
                setTimeout(() => frame.swap(target), 10); // …and commits mid-poll
              }),
            ],
          },
        }),
      );
      const r = await tools(() => frame).click({ selector: "a" });
      expect(r.ok).toBe(true);
      expect(r.output).toContain("now at http://localhost/__preview__/8080/two");
      expect(r.output).toContain('"Page Two"');
    });

    it("fails fast: missing selector, no match, and a match without click()", async () => {
      const doc = fakeDoc({ matches: { svg: [unclickableEl("<svg/>")] } });
      const t = tools(() => fakeFrame(doc));
      const missing = await t.click({});
      expect(missing.ok).toBe(false);
      expect(missing.output).toContain("requires `selector`");
      const none = await t.click({ selector: "#gone" });
      expect(none.ok).toBe(false);
      expect(none.output).toBe('[preview port 8080] no element matches selector "#gone" in the preview document.');
      const svg = await t.click({ selector: "svg" });
      expect(svg.ok).toBe(false);
      expect(svg.output).toContain("does not support click()");
    });
  });

  describe("preview_logs", () => {
    const entry = (kind: string, text: string) => ({ kind, t: 0, text });

    it("formats [kind] text lines and DRAINS the buffer (second call reports nothing new)", async () => {
      const buffer: PreviewLogBuffer = [entry("log", "early-inline-log"), entry("error", "boom @/app.js:3")];
      const t = tools(() => fakeFrame(fakeDoc(), buffer));
      const first = await t.logs();
      expect(first.ok).toBe(true);
      expect(first.output).toBe(
        "[preview port 8080] 2 console entries since the last check:\n[log] early-inline-log\n[error] boom @/app.js:3",
      );
      expect(buffer).toHaveLength(0); // drained in the guest window itself
      const second = await t.logs();
      expect(second.ok).toBe(true);
      expect(second.output).toBe("[preview port 8080] no console output since the last check (current document).");
    });

    it("shows the last 100 of an overfull buffer and reports the hook's drop counter, then resets it", async () => {
      const buffer: PreviewLogBuffer = Array.from({ length: 120 }, (_, i) => entry("log", `m${i}`));
      buffer.dropped = 9;
      const t = tools(() => fakeFrame(fakeDoc(), buffer));
      const r = await t.logs();
      expect(r.ok).toBe(true);
      expect(r.output).toContain("(showing the last 100 of 120; 9 older entries dropped at the 500-entry cap)");
      expect(r.output).toContain("[log] m119");
      expect(r.output).not.toContain("[log] m19\n"); // only the last 100
      expect(buffer.dropped).toBe(0);
    });

    it("keeps the NEWEST text when the formatted output exceeds the cap", async () => {
      const buffer: PreviewLogBuffer = Array.from({ length: 50 }, (_, i) => entry("log", `${i}-${"z".repeat(200)}`));
      const r = await tools(() => fakeFrame(fakeDoc(), buffer)).logs();
      expect(r.ok).toBe(true);
      expect(r.output).toContain("[log] 49-"); // newest survived
      expect(r.output).not.toContain("[log] 0-"); // oldest text was cut
      expect(r.output.length).toBeLessThan(4300); // 4000 + header
    });

    it("fails fast with a precise message when the document carries no hook", async () => {
      const r = await tools(() => fakeFrame(fakeDoc())).logs(); // window without __erdouLogs
      expect(r.ok).toBe(false);
      expect(r.output).toBe(
        "[preview port 8080] no log hook in this preview document — re-open the preview (the hook is injected only into documents served through the preview).",
      );
    });
  });
});
