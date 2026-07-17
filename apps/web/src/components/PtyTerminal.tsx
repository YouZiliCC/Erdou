import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { Studio } from "../lib/studio.js";
import { wirePtyTerminal } from "../lib/pty-terminal-wiring.js";

/** An xterm.js terminal bound to a VM PtySession (streaming). Keystrokes → pty;
 *  pty output → xterm; resize propagates to the guest. The session is opened on
 *  mount (against whatever kernel `studio` points at THEN) and disposed on
 *  unmount. On a vm→vm profile switch the guest changes but `studio` is stable,
 *  so TerminalPanel keys this component on `studio.kernelGeneration` to force a
 *  fresh mount → the effect re-runs and rebinds to the new guest's PTY. All
 *  session wiring (including the FU1 input gate) lives in
 *  lib/pty-terminal-wiring.ts; this component only owns the Terminal's lifecycle.
 *
 *  Sizing (D3): a FitAddon sizes the terminal to its container — at mount
 *  (so the pty opens at the REAL dimensions, not xterm's 80x24 default) and on
 *  every container resize via a ResizeObserver. ReviewPane keeps the Terminal
 *  tab mounted while hidden (display:none ⇒ a 0×0 container), where fit()
 *  would compute garbage — those fits are skipped; un-hiding the tab resizes
 *  the container, so the same observer fires and fits then. fit() drives
 *  term.onResize, which the wiring forwards to session.resize. */
export function PtyTerminal({ studio }: { studio: Studio }) {
  const elRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const openPty = studio.kernel.openPty;
    const el = elRef.current;
    if (!el || !openPty) return;
    const term = new Terminal({ convertEol: false, fontFamily: "monospace", fontSize: 13 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    const fitIfVisible = (): void => {
      if (el.clientWidth === 0 || el.clientHeight === 0) return; // hidden tab — see module doc
      fit.fit();
    };
    fitIfVisible(); // BEFORE wiring, so openPty gets the fitted cols/rows
    const unwire = wirePtyTerminal(term, openPty);
    const ro = new ResizeObserver(fitIfVisible);
    ro.observe(el);
    return () => { ro.disconnect(); unwire(); term.dispose(); };
  }, [studio]);
  return <div className="pty-term" ref={elRef} style={{ height: "100%", width: "100%" }} />;
}
