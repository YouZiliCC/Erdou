import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { Studio } from "../lib/studio.js";

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
    void studio.kernel.openPty({ cols: term.cols, rows: term.rows }).then((s) => {
      if (disposed) { void s.dispose(); return; }
      session = s;
      s.onData((d) => term.write(d));
      term.onData((str) => s.write(enc.encode(str)));
      term.onResize(({ cols, rows }) => s.resize(cols, rows));
    }).catch((err) => term.write(`\r\n[pty error] ${String(err)}\r\n`));
    return () => { disposed = true; void session?.dispose(); term.dispose(); };
  }, [studio]);
  return <div className="pty-term" ref={elRef} style={{ height: "100%", width: "100%" }} />;
}
