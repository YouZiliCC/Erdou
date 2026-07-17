import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { Studio } from "../lib/studio.js";
import { makePtyInputGate } from "../lib/pty-input-gate.js";

/** An xterm.js terminal bound to a VM PtySession (streaming). Keystrokes → pty;
 *  pty output → xterm; resize propagates to the guest. The session is opened on
 *  mount and disposed on unmount. */
export function PtyTerminal({ studio }: { studio: Studio }) {
  const elRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!elRef.current || !studio.kernel.openPty) return;
    const term = new Terminal({ cols: 80, rows: 24, convertEol: false, fontFamily: "monospace", fontSize: 13 });
    term.open(elRef.current);
    const enc = new TextEncoder();
    let disposed = false;
    let session: Awaited<ReturnType<NonNullable<typeof studio.kernel.openPty>>> | undefined;
    // Keystrokes typed before openPty() resolves are queued, then flushed in
    // order to the live session — xterm fires onData immediately and buffers
    // nothing, so wiring onData only after resolve would drop them (FU1).
    const gate = makePtyInputGate();
    term.onData((str) => gate.input(enc.encode(str)));
    term.write("\x1b[2mconnecting…\x1b[0m");
    void studio.kernel.openPty({ cols: term.cols, rows: term.rows }).then((s) => {
      if (disposed) { void s.dispose(); return; }
      session = s;
      term.write("\r\x1b[2K"); // erase the connecting… hint before guest output lands
      s.onData((d) => term.write(d)); // wire output BEFORE flushing input, so echoes render
      gate.open((b) => s.write(b));
      term.onResize(({ cols, rows }) => s.resize(cols, rows));
    }).catch((err) => {
      gate.close(); // drop queued keystrokes — there is no session to deliver them to
      if (!disposed) term.write(`\r\x1b[2K[pty error] ${String(err)}\r\n`);
    });
    return () => { disposed = true; gate.close(); void session?.dispose(); term.dispose(); };
  }, [studio]);
  return <div className="pty-term" ref={elRef} style={{ height: "100%", width: "100%" }} />;
}
