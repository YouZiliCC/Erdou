import { useState } from "react";
import type { ReactNode } from "react";
import { toggleTheme } from "../lib/theme.js";

export function TitleBar({
  workspace, model, running, onSettings, onReset, onThemeChange, children,
}: {
  workspace: string;
  model: string;
  running: boolean;
  onSettings: () => void;
  onReset: () => void;
  onThemeChange?: () => void;
  children?: ReactNode;
}) {
  const [, force] = useState(0);
  return (
    <header className="titlebar">
      <img className="wm-logo" src="/erdou-logo-128.png" alt="" width="20" height="20" />
      <span className="wm">Er<b>dou</b></span>
      <span className="ws">— {workspace}</span>
      <span className="sp" />
      <span className="chip"><span className={"dot " + (running ? "busy" : "on")} /> runtime · js·py·wasi</span>
      {children}
      <span className="chip">{model}</span>
      <button
        className="btn ghost"
        onClick={() => {
          toggleTheme();
          force((n) => n + 1);
          onThemeChange?.();
        }}
      >
        ◐
      </button>
      <button
        className="btn ghost"
        onClick={() => {
          if (window.confirm("Reset the project? This deletes the workspace and run history from this browser.")) {
            onReset();
          }
        }}
      >
        Reset
      </button>
      {/* /help.html is rendered from docs/help.md at predev/prebuild (render-help.mjs). */}
      <button className="btn ghost" onClick={() => window.open("/help.html")}>Help</button>
      <button className="btn ghost" onClick={onSettings}>Settings</button>
    </header>
  );
}
