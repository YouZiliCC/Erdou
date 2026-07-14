import { useState, useRef, useEffect } from "react";
import type { Studio } from "../lib/studio.js";

interface Block {
  cmd: string;
  stdout: string;
  stderr: string;
  code: number;
}

export function TerminalPanel({ studio }: { studio: Studio }) {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const outRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    outRef.current?.scrollTo({ top: outRef.current.scrollHeight });
  }, [blocks.length, busy]);

  async function run() {
    const cmd = input.trim();
    if (cmd.length === 0 || busy) return;
    setInput("");
    setBusy(true);
    try {
      const r = await studio.exec(cmd);
      setBlocks((b) => [...b, { cmd, stdout: r.stdout, stderr: r.stderr, code: r.code }]);
    } catch (err) {
      setBlocks((b) => [...b, { cmd, stdout: "", stderr: String(err), code: 1 }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="term">
      <div className="out" ref={outRef}>
        {blocks.length === 0 && (
          <div className="hint">
            Interactive shell into the runtime. Try: ls / &nbsp;·&nbsp; echo hi &gt; /a.txt &nbsp;·&nbsp; cat /a.txt
            &nbsp;·&nbsp; echo hi | grep h
          </div>
        )}
        {blocks.map((b, i) => (
          <div className="blk" key={i}>
            <div className="cmd">{b.cmd}</div>
            {b.stdout.length > 0 && <div className="res">{b.stdout.replace(/\n$/, "")}</div>}
            {b.stderr.length > 0 && <div className="res err">{b.stderr.replace(/\n$/, "")}</div>}
            <div className="code">exit {b.code}</div>
          </div>
        ))}
      </div>
      <div className="inrow">
        <span className="prompt">$</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void run();
          }}
          placeholder={busy ? "running…" : "type a command"}
          disabled={busy}
          autoFocus
        />
      </div>
    </div>
  );
}
