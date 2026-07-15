import { useEffect, useState } from "react";
import type { ProcessInfo } from "@erdou/runtime-contract";
import type { Studio } from "../lib/studio.js";

export function ProcessPanel({ studio }: { studio: Studio }) {
  const [procs, setProcs] = useState<ProcessInfo[]>([]);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      void studio.listProcesses().then((p) => {
        if (alive) setProcs(p);
      });
    tick();
    const id = setInterval(tick, 800);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [studio]);

  if (procs.length === 0) {
    return (
      <div className="panel">
        <div className="hint">No processes yet. Commands the agent or terminal runs appear here with their state and exit code.</div>
      </div>
    );
  }

  return (
    <div className="panel">
      <table className="proc">
        <thead>
          <tr>
            <th>pid</th>
            <th>ppid</th>
            <th>cmd</th>
            <th>state</th>
            <th>exit</th>
          </tr>
        </thead>
        <tbody>
          {procs.map((p) => (
            <tr key={p.pid}>
              <td>{p.pid}</td>
              <td>{p.ppid}</td>
              <td>{p.cmd}</td>
              <td>
                <span className={"chip " + p.state}>{p.state}</span>
              </td>
              <td>{p.exitCode ?? "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
