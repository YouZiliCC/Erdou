import { useState } from "react";
import { toggleTheme } from "../lib/theme.js";

export function TitleBar({
  workspace, model, running, onSettings,
}: { workspace: string; model: string; running: boolean; onSettings: () => void }) {
  const [, force] = useState(0);
  return (
    <header className="titlebar">
      <span className="wm">Er<b>dou</b></span>
      <span className="ws">— {workspace}</span>
      <span className="sp" />
      <span className="chip"><span className={"dot " + (running ? "busy" : "on")} /> runtime · js·py·wasi</span>
      <span className="chip">{model}</span>
      <button className="btn ghost" onClick={() => { toggleTheme(); force((n) => n + 1); }}>◐</button>
      <button className="btn ghost" onClick={onSettings}>Settings</button>
    </header>
  );
}
