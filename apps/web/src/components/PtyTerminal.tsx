import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { Studio } from "../lib/studio.js";
import { wirePtyTerminal } from "../lib/pty-terminal-wiring.js";

/** An xterm.js terminal bound to a VM PtySession (streaming). Keystrokes → pty;
 *  pty output → xterm; resize propagates to the guest. The session is opened on
 *  mount and disposed on unmount. All session wiring (including the FU1 input
 *  gate) lives in lib/pty-terminal-wiring.ts; this component only owns the
 *  Terminal's lifecycle. */
export function PtyTerminal({ studio }: { studio: Studio }) {
  const elRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const openPty = studio.kernel.openPty;
    if (!elRef.current || !openPty) return;
    const term = new Terminal({ cols: 80, rows: 24, convertEol: false, fontFamily: "monospace", fontSize: 13 });
    term.open(elRef.current);
    const unwire = wirePtyTerminal(term, openPty);
    return () => { unwire(); term.dispose(); };
  }, [studio]);
  return <div className="pty-term" ref={elRef} style={{ height: "100%", width: "100%" }} />;
}
