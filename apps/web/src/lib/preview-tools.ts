import type { HttpRequest, WsConnection } from "@erdou/runtime-contract";
import type { ToolDef, ToolResult } from "@erdou/agent-tools";

/**
 * Page-side preview plumbing that is not the bridge itself:
 *   1. the WebSocket tunnel pump (`openWsTunnel`, below) — the counterpart of
 *      the injected `WS_SHIM_SOURCE`;
 *   2. the agent's preview OBSERVATION tools (`createPreviewTools`, bottom of
 *      this file) — preview_read / preview_click / preview_logs, which let the
 *      agent verify its served app through the live preview iframe.
 *
 * The page side of the preview WebSocket tunnel.
 *
 * The shim injected into previewed documents (preview-inject.ts) cannot open a
 * real WebSocket — the Service Worker never sees ws:// handshakes — so it
 * posts `{type:"erdou:ws-open", port, path, protocols}` to the Studio window
 * with one end of a MessageChannel. The bridge (preview-bridge.ts) validates
 * the message and hands the port to `openWsTunnel`, which upgrades through the
 * CONTRACT (`runtime.upgrade(port, req)` — the optional capability method) and
 * pumps frames both ways until either side closes.
 *
 * Kernel truth, not emulation: a runtime WITHOUT `upgrade` (the browser
 * kernel) gets an immediate, precise decline — the shim surfaces it as an
 * `error` event + close 1006, exactly how a WS-less proxy behaves. Nothing is
 * buffered speculatively and nothing retries.
 *
 * Message shapes (append-only; kept in sync with `WS_SHIM_SOURCE`):
 *   shim → page  {type:"frame", data: string|ArrayBuffer|Blob} | {type:"close", code?, reason?}
 *   page → shim  {type:"open", protocol} | {type:"frame", data: string|ArrayBuffer}
 *              | {type:"close", code, reason, wasClean} | {type:"error", message}
 */

export const WS_UNSUPPORTED_MESSAGE =
  "WebSocket is not supported on this kernel — the browser kernel has no WebSocket-capable servers; run the app on a vm:* kernel.";

/** The slice of Runtime the tunnel needs: `upgrade` stays OPTIONAL — its
 *  absence is the kernel's fail-fast decline (see the contract doc). */
export interface UpgradeRuntime {
  upgrade?(port: number, req: HttpRequest): Promise<WsConnection>;
}

/** The shim's ws-open envelope (window message, one MessagePort attached). */
export interface WsOpenMessage {
  type: "erdou:ws-open";
  port: number;
  path: string;
  protocols: string[];
}

export function isWsOpenMessage(data: unknown): data is WsOpenMessage {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    d.type === "erdou:ws-open" &&
    typeof d.port === "number" &&
    Number.isInteger(d.port) &&
    d.port > 0 &&
    d.port <= 65535 &&
    typeof d.path === "string" &&
    d.path.startsWith("/") &&
    Array.isArray(d.protocols) &&
    d.protocols.every((p) => typeof p === "string")
  );
}

/** Build the contract HttpRequest for the upgrade: the handshake intent rides
 *  in the headers (subprotocol offers under `sec-websocket-protocol`); the
 *  kernel's codec synthesizes the key/version mechanics itself. */
export function wsUpgradeRequest(msg: WsOpenMessage): HttpRequest {
  const headers: Record<string, string> = { upgrade: "websocket", connection: "Upgrade" };
  if (msg.protocols.length > 0) headers["sec-websocket-protocol"] = msg.protocols.join(", ");
  return { method: "GET", url: msg.path, headers, body: new Uint8Array() };
}

/** The MessagePort surface the pump uses (DOM and Node's MessageChannel both
 *  satisfy it, so the pump is unit-testable in the node environment). */
export interface TunnelPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  close(): void;
  onmessage: ((ev: MessageEvent) => void) | null;
}

/**
 * Open one tunnel: upgrade via the runtime, then pump until either side
 * closes. Resolves AFTER the tunnel settled its opening — with a cleanup
 * function on success (idempotent; used by the bridge when the runtime is
 * re-aimed, so a dead kernel's pumps don't leak), or `null` when the upgrade
 * was declined/failed (the shim has already been told). `onClosed` fires
 * exactly once when the tunnel ends by ANY path — including the failure
 * paths — so the bridge can drop its bookkeeping.
 */
export async function openWsTunnel(
  runtime: UpgradeRuntime,
  msg: WsOpenMessage,
  port: TunnelPort,
  onClosed: () => void = () => {},
): Promise<(() => void) | null> {
  let closed = false;
  const finish = (code: number, reason: string, wasClean: boolean): void => {
    if (closed) return;
    closed = true;
    port.postMessage({ type: "close", code, reason, wasClean });
    port.close();
    onClosed();
  };
  const fail = (message: string): null => {
    port.postMessage({ type: "error", message });
    finish(1006, message, false);
    return null;
  };

  if (typeof runtime.upgrade !== "function") return fail(WS_UNSUPPORTED_MESSAGE);
  let ws: WsConnection;
  try {
    ws = await runtime.upgrade(msg.port, wsUpgradeRequest(msg));
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  // guest → shim. Binary frames travel as a TRANSFERRED ArrayBuffer (the shim
  // wraps it per its binaryType).
  ws.onMessage((data) => {
    if (closed) return;
    if (typeof data === "string") {
      port.postMessage({ type: "frame", data });
    } else {
      const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      port.postMessage({ type: "frame", data: ab }, [ab]);
    }
  });
  ws.onClose((code, reason) => finish(code, reason, code !== 1006));

  // shim → guest. Handled through a promise chain so an async payload decode
  // (Blob → bytes) cannot reorder frames.
  let chain: Promise<void> = Promise.resolve();
  const handle = async (m: unknown): Promise<void> => {
    if (closed || typeof m !== "object" || m === null) return;
    const d = m as { type?: unknown; data?: unknown; code?: unknown; reason?: unknown };
    if (d.type === "close") {
      ws.close(typeof d.code === "number" ? d.code : undefined, typeof d.reason === "string" ? d.reason : "");
      return;
    }
    if (d.type !== "frame") return;
    let payload: string | Uint8Array;
    if (typeof d.data === "string") payload = d.data;
    else if (d.data instanceof ArrayBuffer) payload = new Uint8Array(d.data);
    else if (ArrayBuffer.isView(d.data)) payload = new Uint8Array(d.data.buffer, d.data.byteOffset, d.data.byteLength);
    else if (typeof Blob !== "undefined" && d.data instanceof Blob) payload = new Uint8Array(await d.data.arrayBuffer());
    else {
      // Unknown payload shape = a shim/bridge version mismatch — fail fast and
      // visibly, never forward silently-wrong bytes.
      ws.close(1002, "unsupported frame payload from the preview shim");
      fail(`preview WebSocket tunnel: unsupported frame payload (${Object.prototype.toString.call(d.data)})`);
      return;
    }
    try {
      ws.send(payload);
    } catch {
      // Send raced a close: the connection is already down and the close has
      // been (or is being) reported — a late frame is discarded, per spec.
    }
  };
  port.onmessage = (ev) => {
    chain = chain.then(() => handle(ev.data));
  };

  port.postMessage({ type: "open", protocol: ws.protocol });

  return () => {
    if (closed) return;
    try {
      ws.close(1001, "preview bridge released");
    } catch {
      /* connection already down */
    }
    finish(1001, "the preview bridge was re-aimed at a new runtime", false);
  };
}

/* ------------------------------------------------------------------------- *
 * Agent preview-observation tools (spike 3).
 *
 * Three app-level ToolDefs that let the agent OBSERVE the app it just served:
 * read the rendered DOM, click an element, and drain the console/error buffer
 * that `PREVIEW_HOOK_SOURCE` (preview-inject.ts) maintains inside the guest
 * document. They work through the live preview iframe that PreviewPanel
 * registers on Studio (`registerPreviewFrame`) — direct `contentDocument` /
 * `contentWindow` access, which exists ONLY because the preview is served
 * same-origin under the R7 `allow-same-origin` sandbox decision (see the
 * iframe comment in PreviewPanel.tsx: a separate-origin hardening would sever
 * these tools with it).
 *
 * All DOM inputs are duck-typed structural interfaces (`PreviewFrameLike`
 * etc.) that a real `HTMLIFrameElement` satisfies, so the node-environment
 * vitest suite can drive the real execute() functions against plain fakes.
 *
 * Failure policy: fail fast with a precise message — no preview frame, a
 * never-ready document, a selector with no match, a missing log hook. Every
 * failure is returned as `{ok:false}` (the ToolDef contract), never thrown.
 * ------------------------------------------------------------------------- */

/** One captured console/error entry (shape produced by PREVIEW_HOOK_SOURCE). */
export interface PreviewLogEntry {
  kind: string;
  t: number;
  text: string;
}

/** The guest-window buffer: an Array plus a `dropped` counter for entries the
 *  500-entry cap discarded (drop-oldest). */
export interface PreviewLogBuffer extends Array<PreviewLogEntry> {
  dropped?: number;
}

/** Structural subset of an element the tools touch. `click` is optional
 *  because DOM `querySelectorAll` yields `Element`s (SVG etc. have no
 *  `click()`) — preview_click fails fast on a non-clickable match. */
export interface PreviewElementLike {
  readonly outerHTML: string;
  click?(): void;
}

/** Structural subset of `HTMLElement` for the body-text snapshot. The clone
 *  is treated as another `PreviewBodyLike` (typed `unknown` so the real
 *  `cloneNode(): Node` signature remains assignable). */
export interface PreviewBodyLike {
  cloneNode(deep: boolean): unknown;
  querySelectorAll(selectors: string): ArrayLike<{ remove(): void }>;
  readonly textContent: string | null;
}

/** Structural subset of `Document`. */
export interface PreviewDocumentLike {
  readonly readyState: string;
  readonly title: string;
  readonly URL: string;
  readonly body: PreviewBodyLike | null;
  querySelectorAll(selectors: string): ArrayLike<PreviewElementLike>;
}

/** Structural subset of the guest `Window`: only the hook buffer.
 *  `location` is declared (optional, opaque) ONLY so this interface is not
 *  "weak" (all-optional with zero overlap) — TypeScript's weak-type detection
 *  would otherwise reject the DOM `Window` → `PreviewWindowLike` assignment,
 *  breaking the studio wiring `createPreviewTools(() => this.previewFrame)`
 *  at typecheck. Every real Window has `location`; the fakes may omit it. */
export interface PreviewWindowLike {
  __erdouLogs?: PreviewLogBuffer;
  readonly location?: unknown;
}

/** Structural subset of `HTMLIFrameElement`. */
export interface PreviewFrameLike {
  readonly src: string;
  readonly contentDocument: PreviewDocumentLike | null;
  readonly contentWindow: PreviewWindowLike | null;
}

/** Readiness-poll knobs — injectable so tests don't wait wall-clock seconds. */
export interface PreviewTiming {
  /** Poll interval while the guest document is still loading. */
  pollMs: number;
  /** Give-up bound for a document that never becomes ready. */
  timeoutMs: number;
}

const DEFAULT_TIMING: PreviewTiming = { pollMs: 150, timeoutMs: 5000 };

export const NO_PREVIEW_MESSAGE = "No preview is open — serve your app and call open_preview first.";

// Output caps (spike-designed): a DOM dump must never flood the transcript —
// the failure mode is "narrow with a selector", stated in the output itself.
const SNAPSHOT_TEXT_CAP = 4000; // no-selector body text
const MATCH_CAP = 5; //            selector mode: max elements shown
const MATCH_HTML_CAP = 2000; //    selector mode: outerHTML chars per element
const LOG_ENTRY_CAP = 100; //      preview_logs: max entries per drain
const LOG_TEXT_CAP = 4000; //      preview_logs: total text cap

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Parse the inspected port from the frame's src (`…/__preview__/<port>/…`). */
export function previewFramePort(src: string): number | null {
  const m = /\/__preview__\/(\d+)\//.exec(src);
  const port = m?.[1];
  return port !== undefined ? Number(port) : null;
}

function portLabel(frame: PreviewFrameLike): string {
  const port = previewFramePort(frame.src);
  return port !== null ? `[preview port ${port}]` : `[preview ${frame.src}]`;
}

/** Resolve the live preview document, waiting (poll `pollMs`, bound
 *  `timeoutMs`) through a still-loading navigation. Throws precise errors —
 *  the execute() wrappers turn them into `{ok:false}` results. */
async function resolveDoc(
  getFrame: () => PreviewFrameLike | null,
  timing: PreviewTiming,
): Promise<{ frame: PreviewFrameLike; doc: PreviewDocumentLike }> {
  const frame = getFrame();
  if (!frame) throw new Error(NO_PREVIEW_MESSAGE);
  const deadline = Date.now() + timing.timeoutMs;
  for (;;) {
    // Re-read contentDocument every turn: a navigation swaps the document.
    // The initial `about:blank` a freshly mounted iframe carries reports
    // readyState "complete" BEFORE the real preview document commits — it is
    // "still loading" for our purposes, never a readable snapshot.
    const doc = frame.contentDocument;
    if (
      doc &&
      (doc.readyState === "interactive" || doc.readyState === "complete") &&
      doc.URL !== "about:blank"
    ) {
      return { frame, doc };
    }
    if (Date.now() >= deadline) {
      throw new Error(
        doc
          ? `the preview document is still loading (readyState "${doc.readyState}", url ${doc.URL}, waited ${timing.timeoutMs}ms) — retry in a moment`
          : `the preview frame has no accessible document (waited ${timing.timeoutMs}ms) — re-open the preview`,
      );
    }
    await sleep(timing.pollMs);
  }
}

/** Collapse-whitespace text of the document body, scripts/styles removed.
 *  `textContent`-based on purpose: `innerText` degrades to "" while the
 *  Preview tab is hidden-but-mounted (display:none) — spike A3. */
function bodyText(doc: PreviewDocumentLike): string {
  const body = doc.body;
  if (!body) return "";
  const clone = body.cloneNode(true) as PreviewBodyLike;
  const strip = clone.querySelectorAll("script,style,noscript");
  for (let i = 0; i < strip.length; i++) strip[i]!.remove();
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

function capText(text: string, cap: number, note: string): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}… [truncated ${text.length - cap} chars${note}]`;
}

function querySelectorAllChecked(doc: PreviewDocumentLike, selector: string): ArrayLike<PreviewElementLike> {
  try {
    return doc.querySelectorAll(selector);
  } catch (err) {
    throw new Error(`invalid CSS selector ${JSON.stringify(selector)}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function fail(output: string): ToolResult {
  return { ok: false, output };
}

/**
 * Build the three preview-observation ToolDefs over `getFrame` (the live
 * iframe Studio holds via `registerPreviewFrame`; null = no preview mounted).
 *
 *   preview_read({selector?})  — trimmed DOM snapshot: title + collapsed body
 *                                text, or outerHTML of up to 5 selector
 *                                matches; hard output caps, read-only.
 *   preview_click({selector})  — dispatch `click()` on the first match and
 *                                report the resulting URL/title. UNGATED by
 *                                design (spike 3): it can only invoke the
 *                                previewed app's own client JS inside the
 *                                sandboxed iframe — the agent authored that
 *                                code, and serving it was the gated step — so
 *                                gating would only break the click→read→logs
 *                                verify loop in Confirm mode. (Reversal is one
 *                                string in agent-core's GATED_TOOLS.)
 *   preview_logs()             — drain the injected hook's console/error
 *                                buffer (`window.__erdouLogs`): entries since
 *                                the last call, current document only.
 *
 * The tools ignore ToolContext.runtime — they observe the PREVIEW, which is
 * app UI surface (same layering as open_preview, not a runtime capability).
 */
export function createPreviewTools(
  getFrame: () => PreviewFrameLike | null,
  timing: PreviewTiming = DEFAULT_TIMING,
): ToolDef[] {
  const read: ToolDef = {
    name: "preview_read",
    description:
      "Read the previewed app's rendered DOM (the live preview iframe). Without `selector`: the document title, URL " +
      "and collapsed visible text. With a CSS `selector`: the outerHTML of up to 5 matching elements. Output is " +
      "hard-capped — narrow with a selector for detail. Use it after open_preview to verify what the user actually sees.",
    parameters: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "Optional CSS selector; omit for a whole-page text snapshot.",
        },
      },
    },
    execute: async (_ctx, args) => {
      try {
        const { frame, doc } = await resolveDoc(getFrame, timing);
        const label = portLabel(frame);
        const selector = typeof args.selector === "string" && args.selector.trim() !== "" ? args.selector : null;
        if (selector === null) {
          const text = capText(bodyText(doc), SNAPSHOT_TEXT_CAP, " — narrow with a selector");
          return {
            ok: true,
            output: `${label} ${doc.URL}\ntitle: ${doc.title}\nbody text: ${text === "" ? "(empty)" : text}`,
          };
        }
        const matches = querySelectorAllChecked(doc, selector);
        if (matches.length === 0) {
          return fail(`${label} no element matches selector ${JSON.stringify(selector)} in the preview document.`);
        }
        const shown = Math.min(matches.length, MATCH_CAP);
        const lines: string[] = [
          `${label} ${matches.length} match${matches.length === 1 ? "" : "es"} for ${JSON.stringify(selector)}` +
            (matches.length > shown ? ` (showing first ${shown})` : "") +
            ":",
        ];
        for (let i = 0; i < shown; i++) {
          lines.push(`${i + 1}. ${capText(matches[i]!.outerHTML, MATCH_HTML_CAP, "")}`);
        }
        return { ok: true, output: lines.join("\n") };
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const click: ToolDef = {
    name: "preview_click",
    description:
      "Click an element in the previewed app: dispatches `click()` on the FIRST match of the CSS `selector` and " +
      "reports the resulting URL and title (following a triggered navigation). Fires the click activation only — no " +
      "pointerdown/hover sequence, so pointer-event-driven UIs won't respond. Verify the effect afterwards with " +
      "preview_read / preview_logs.",
    parameters: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector for the element to click (first match is used).",
        },
      },
      required: ["selector"],
    },
    execute: async (_ctx, args) => {
      const selector = typeof args.selector === "string" ? args.selector.trim() : "";
      if (selector === "") return fail("preview_click requires `selector` — the CSS selector of the element to click.");
      try {
        const { frame, doc } = await resolveDoc(getFrame, timing);
        const label = portLabel(frame);
        const matches = querySelectorAllChecked(doc, selector);
        if (matches.length === 0) {
          return fail(`${label} no element matches selector ${JSON.stringify(selector)} in the preview document.`);
        }
        const el = matches[0]!;
        if (typeof el.click !== "function") {
          return fail(`${label} the first match for ${JSON.stringify(selector)} does not support click().`);
        }
        el.click();
        // Let a triggered mutation land or a navigation commit, then report
        // where the document ended up (re-resolved: navigation swaps it).
        await sleep(timing.pollMs);
        try {
          const after = await resolveDoc(getFrame, timing);
          return {
            ok: true,
            output: `${label} clicked ${JSON.stringify(selector)} — now at ${after.doc.URL} (title: ${JSON.stringify(after.doc.title)})`,
          };
        } catch (err) {
          // The click DID happen; the resulting document just isn't readable
          // yet. Report both facts instead of failing the click.
          return {
            ok: true,
            output: `${label} clicked ${JSON.stringify(selector)}, but the resulting document is not readable yet: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const logs: ToolDef = {
    name: "preview_logs",
    description:
      "Read the previewed document's console output and uncaught errors (`[log|warn|error|uncaught|unhandledrejection] " +
      "text` lines) captured since your last call. The buffer DRAINS on read; a reload or navigation restarts capture " +
      "for the new document. Use it after open_preview or preview_click to check for runtime errors.",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      try {
        const { frame } = await resolveDoc(getFrame, timing);
        const label = portLabel(frame);
        const win = frame.contentWindow;
        const buffer = win?.__erdouLogs;
        if (!Array.isArray(buffer)) {
          return fail(
            `${label} no log hook in this preview document — re-open the preview (the hook is injected only into documents served through the preview).`,
          );
        }
        const total = buffer.length;
        const dropped = buffer.dropped ?? 0;
        const entries = buffer.slice(-LOG_ENTRY_CAP);
        // Drain: "since your last call" semantics, proven host-side in the spike.
        buffer.length = 0;
        buffer.dropped = 0;
        if (total === 0 && dropped === 0) {
          return { ok: true, output: `${label} no console output since the last check (current document).` };
        }
        let body = entries.map((e) => `[${e.kind}] ${e.text}`).join("\n");
        if (body.length > LOG_TEXT_CAP) body = `…${body.slice(-LOG_TEXT_CAP)}`; // keep the NEWEST text
        const notes = [
          total > entries.length ? `showing the last ${entries.length} of ${total}` : "",
          dropped > 0 ? `${dropped} older entries dropped at the 500-entry cap` : "",
        ].filter((n) => n !== "");
        const header = `${label} ${total} console entr${total === 1 ? "y" : "ies"} since the last check${notes.length > 0 ? ` (${notes.join("; ")})` : ""}:`;
        return { ok: true, output: `${header}\n${body}` };
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  };

  return [read, click, logs];
}
