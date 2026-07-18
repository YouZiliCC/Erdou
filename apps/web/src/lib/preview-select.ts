/**
 * Pure decision logic for the Preview panel — extracted so it is unit-testable
 * (the panel's JSX is not, under the node-only vitest setup).
 *
 * The panel is agent-primary: `Studio.previewRequest` (set by the agent's
 * `open_preview` tool) drives the selection, and a newly opened port fills an
 * empty view by default. A selection the user made on a still-open port is
 * never yanked without a request.
 */

/** Mirror of `Studio.previewRequest` (see studio.ts). */
export interface PreviewRequest {
  port: number | null;
  nonce: number;
}

export interface PreviewSelectionState {
  /** The port the panel wants to show. May be stale (already closed) — the
   *  panel derives what it actually renders by intersecting with openPorts. */
  selected: number | null;
  /** An agent-requested port that was NOT open when its request arrived
   *  (`open_preview` can beat `port.opened`'s async delivery): the first
   *  reduction that sees it open selects it — no polling, the port's arrival
   *  itself triggers the next reduction. */
  pendingPort: number | null;
  /** The last `previewRequest.nonce` already applied, so re-renders between
   *  requests can't re-apply (and re-yank) an old request. */
  handledNonce: number;
}

/**
 * Compute the next selection from the current one plus what changed:
 * `request` (nonce-deduped via `handledNonce`), `openPorts` (in open order —
 * Studio appends on `port.opened`), and `prevOpenPorts` (the ports as of the
 * previous reduction, to tell NEWLY opened ports apart).
 *
 * Rules, in order:
 *  1. A new request targets its port — immediately if open, else via
 *     `pendingPort`; with `port: null` it targets the most recently opened
 *     port (with none open there is nothing to aim at — rule 3 catches the
 *     port when it opens, unless the user is already viewing something).
 *  2. A pending requested port that is now open becomes the selection.
 *  3. Agent-primary default: a newly opened port fills an empty view
 *     (nothing selected, or the selected port is gone).
 */
export function reducePreviewSelection(
  state: PreviewSelectionState,
  request: PreviewRequest | null,
  openPorts: readonly number[],
  prevOpenPorts: readonly number[],
): PreviewSelectionState {
  let { selected, pendingPort, handledNonce } = state;

  // 1. A new agent request — the ONE case allowed to move the selection off a
  //    still-open port the user picked.
  if (request && request.nonce !== handledNonce) {
    handledNonce = request.nonce;
    if (request.port !== null) {
      if (openPorts.includes(request.port)) {
        selected = request.port;
        pendingPort = null;
      } else {
        // Request beat port.opened: keep showing whatever is showing (no
        // blank frame) and switch the moment the port arrives (rule 2).
        pendingPort = request.port;
      }
    } else {
      const latest = openPorts.length > 0 ? openPorts[openPorts.length - 1]! : null;
      if (latest !== null) {
        selected = latest;
        pendingPort = null;
      }
    }
  }

  // 2. The awaited requested port just opened.
  if (pendingPort !== null && openPorts.includes(pendingPort)) {
    selected = pendingPort;
    pendingPort = null;
  }

  // 3. Agent-primary default: only when the panel shows nothing, so a live
  //    user selection is never yanked. Keyed to NEWLY opened ports — a port
  //    merely closing (e.g. the user stopped the viewed one) selects nothing.
  if (selected === null || !openPorts.includes(selected)) {
    const fresh = openPorts.filter((p) => !prevOpenPorts.includes(p));
    if (fresh.length > 0) selected = fresh[fresh.length - 1]!;
  }

  return { selected, pendingPort, handledNonce };
}

/**
 * Whether the Run button should perform the bundle+serve flow (esbuild-wasm in
 * the page — the only TS/React preview path on the browser kernel) instead of
 * executing the field's command: the field is empty or still holds the
 * auto-detected prefill (passive help, not a user decision), and the project
 * has a bundleable entry. A user-typed command always wins.
 */
export function isBundleRun(cmd: string, detected: string | null, hasEntry: boolean): boolean {
  if (!hasEntry) return false;
  const typed = cmd.trim();
  return typed === "" || typed === (detected ?? "");
}
