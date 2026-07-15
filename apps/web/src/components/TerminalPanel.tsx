import { useState, useRef, useEffect } from "react";
import type { KeyboardEvent } from "react";
import type { Studio } from "../lib/studio.js";

interface Block {
  cwd: string;
  cmd: string;
  stdout: string;
  stderr: string;
  code: number;
}

/** Interactive terminal over a persistent `ShellSession` — cwd/env survive across commands. */
export function TerminalPanel({ studio }: { studio: Studio }) {
  const shell = studio.shell;
  const workspace = studio.mountName ?? "erdou";

  const [blocks, setBlocks] = useState<Block[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [histIndex, setHistIndex] = useState<number | null>(null);
  const outRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    outRef.current?.scrollTo({ top: outRef.current.scrollHeight });
  }, [blocks.length, busy]);

  async function run() {
    const cmd = input.trim();
    if (cmd.length === 0 || busy) return;
    // Capture cwd BEFORE exec — the prompt shows the dir the command ran IN.
    const cwd = shell.cwd;
    setInput("");
    setBusy(true);
    try {
      const r = await shell.exec(cmd);
      setBlocks((b) => [...b, { cwd, cmd, stdout: r.stdout, stderr: r.stderr, code: r.code }]);
    } catch (err) {
      setBlocks((b) => [...b, { cwd, cmd, stdout: "", stderr: String(err), code: 1 }]);
    } finally {
      setBusy(false);
      setHistory((h) => [...h, cmd]);
      setHistIndex(null);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      void run();
      return;
    }
    if (e.key === "ArrowUp") {
      if (history.length === 0) return;
      e.preventDefault();
      const next = histIndex === null ? history.length - 1 : Math.max(0, histIndex - 1);
      setHistIndex(next);
      setInput(history[next] ?? "");
      return;
    }
    if (e.key === "ArrowDown") {
      if (histIndex === null) return;
      e.preventDefault();
      const next = histIndex + 1;
      if (next >= history.length) {
        setHistIndex(null);
        setInput("");
      } else {
        setHistIndex(next);
        setInput(history[next] ?? "");
      }
    }
  }

  return (
    <div className="term">
      <div className="out" ref={outRef}>
        {blocks.length === 0 && (
          <div className="hint">
            Interactive shell into the runtime — cwd persists across commands. Try: ls / &nbsp;·&nbsp; cd /
            &nbsp;·&nbsp; echo hi &gt; /a.txt &nbsp;·&nbsp; cat /a.txt &nbsp;·&nbsp; python -c "print(6*7)"&nbsp;
            <span style={{ opacity: 0.7 }}>(first Python run downloads the runtime, ~10s)</span>
          </div>
        )}
        {blocks.map((b, i) => (
          <div className="blk" key={i}>
            <div className="prompt-line">
              <span className="ws">{workspace}</span> <span className="cwd">{b.cwd}</span>{" "}
              <span className="p">$</span> {b.cmd}
            </div>
            {b.stdout.length > 0 && <div className="res">{b.stdout.replace(/\n$/, "")}</div>}
            {b.stderr.length > 0 && <div className="res err">{b.stderr.replace(/\n$/, "")}</div>}
            {b.code !== 0 && <div className="code">exit {b.code}</div>}
          </div>
        ))}
      </div>
      <div className="inrow">
        <span className="ws">{workspace}</span> <span className="cwd">{shell.cwd}</span> <span className="p">$</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={busy ? "running…" : "type a command"}
          disabled={busy}
          autoFocus
        />
      </div>
    </div>
  );
}
