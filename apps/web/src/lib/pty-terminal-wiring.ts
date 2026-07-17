import { makePtyInputGate } from "./pty-input-gate.js";

/** Structural slice of xterm's Terminal used by the wiring. No xterm import
 *  here — the component owns Terminal construction/disposal, and tests
 *  hand-roll a fake. */
export interface TermLike {
  readonly cols: number;
  readonly rows: number;
  onData(cb: (data: string) => void): void;
  onResize(cb: (size: { cols: number; rows: number }) => void): void;
  write(data: string | Uint8Array): void;
}

/** Structural slice of @erdou/runtime-vm's PtySession. */
export interface PtySessionLike {
  write(data: Uint8Array): void;
  onData(cb: (data: Uint8Array) => void): void;
  resize(cols: number, rows: number): void;
  dispose(): Promise<void>;
}

/**
 * PtyTerminal's entire mount-effect body: bind a live terminal to the session
 * openPty() will yield. term.onData is attached HERE, synchronously, before
 * openPty settles — xterm buffers nothing, so attaching it in the then-handler
 * drops every keystroke typed while the pty opens (FU1). Returns the cleanup
 * for the effect to run on unmount (the caller still disposes the Terminal).
 */
export function wirePtyTerminal(
  term: TermLike,
  openPty: (opts: { cols: number; rows: number }) => Promise<PtySessionLike>,
): () => void {
  const enc = new TextEncoder();
  let disposed = false;
  let session: PtySessionLike | undefined;
  // Keystrokes typed before openPty() resolves are queued, then flushed in
  // order to the live session.
  const gate = makePtyInputGate();
  term.onData((str) => gate.input(enc.encode(str)));
  term.write("\x1b[2mconnecting…\x1b[0m");
  void openPty({ cols: term.cols, rows: term.rows }).then((s) => {
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
  return () => { disposed = true; gate.close(); void session?.dispose(); };
}
