import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { Studio } from "../lib/studio.js";
import { ShellLineDiscipline, formatShellPrompt } from "../lib/shell-terminal.js";
import { PtyTerminal } from "./PtyTerminal.js";

/** Dispatches to the VM kernel's streaming PTY terminal or the browser kernel's
 *  line-discipline shell terminal — both xterm-based.
 *
 *  C2: both are keyed on `studio.kernelGeneration` so a kernel swap that keeps
 *  the same `kernelKind` — which would NOT otherwise remount — rebinds to the
 *  new kernel's pty/shell instead of driving the disposed one. (App re-renders
 *  this subtree on every notify, and a swap bumps the generation then
 *  notifies, so the new key takes effect.) */
export function TerminalPanel({ studio }: { studio: Studio }) {
  if (studio.kernelKind === "vm" && studio.kernel.openPty) {
    return <PtyTerminal key={studio.kernelGeneration} studio={studio} />;
  }
  return <ShellTerminal key={studio.kernelGeneration} studio={studio} />;
}

/** An xterm.js terminal over the persistent `studio.shell` (RpcShellSession:
 *  command-at-a-time exec, cwd/env survive across commands). The session has
 *  no PTY, so lib/shell-terminal.ts supplies the line discipline — echo,
 *  Backspace, Enter→exec, history, type-ahead while a command runs — and this
 *  component only owns the Terminal lifecycle and the exec round-trip.
 *
 *  Sizing/focus: same FitAddon + ResizeObserver dance as PtyTerminal —
 *  ReviewPane keeps the hidden Terminal tab mounted (display:none ⇒ a 0×0
 *  container) where fit() would compute garbage, so those fits are skipped;
 *  un-hiding resizes the container, and that observer tick re-fits AND
 *  refocuses, so the prompt is typeable the instant the tab shows. Focus is
 *  never dropped after Enter — nothing is disabled; xterm keeps it. */
function ShellTerminal({ studio }: { studio: Studio }) {
  const elRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const shell = studio.shell;
    const term = new Terminal({ convertEol: false, fontFamily: "monospace", fontSize: 13 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    let wasVisible = false;
    const fitIfVisible = (): void => {
      const visible = el.clientWidth > 0 && el.clientHeight > 0;
      if (visible) {
        fit.fit();
        if (!wasVisible) term.focus(); // tab just became visible — put the cursor back
      }
      wasVisible = visible;
    };
    fitIfVisible();

    let disposed = false;
    const discipline = new ShellLineDiscipline(
      () => formatShellPrompt(studio.mountName ?? "erdou", shell.cwd),
      // Live width for the discipline's wrap math (multi-row erase on history
      // recall / backspace over a wrapped line). Read per keystroke, so a
      // resize (xterm reflows the wrapped line) is picked up automatically.
      () => term.cols,
    );
    const apply = (u: { write: string; run: string | null }): void => {
      if (u.write.length > 0) term.write(u.write);
      if (u.run !== null) {
        void shell
          .exec(u.run)
          // An exec rejection surfaces like a failed command: red message,
          // exit 1 — same as the old block terminal.
          .catch((err: unknown) => ({ stdout: "", stderr: String(err), code: 1 }))
          .then((r) => {
            if (disposed) return;
            apply(discipline.commandDone(r));
          });
      }
    };
    term.write(discipline.start());
    term.onData((d) => apply(discipline.data(d)));
    term.focus();

    const ro = new ResizeObserver(fitIfVisible);
    ro.observe(el);
    return () => {
      disposed = true;
      ro.disconnect();
      term.dispose();
    };
  }, [studio]);
  return <div className="pty-term" ref={elRef} style={{ height: "100%", width: "100%" }} />;
}
