import { useState, useEffect } from "react";
import type { ModelConfig } from "@erdou/model-gateway";
import { useStudio } from "./lib/use-studio.js";
import { loadModel, saveModel } from "./lib/model-config.js";
import { TraceTape } from "./components/TraceTape.js";
import { FilePanel } from "./components/FilePanel.js";
import { TerminalPanel } from "./components/TerminalPanel.js";
import { ProcessPanel } from "./components/ProcessPanel.js";
import { PreviewPanel } from "./components/PreviewPanel.js";
import { SettingsDialog } from "./components/SettingsDialog.js";

type Tab = "files" | "terminal" | "processes" | "preview";

export function App() {
  const studio = useStudio();
  const [model, setModel] = useState<ModelConfig>(() => loadModel());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [task, setTask] = useState("");
  const [tab, setTab] = useState<Tab>("files");

  const configured = model.apiKey.trim().length > 0;

  useEffect(() => {
    if (!configured) setSettingsOpen(true);
    // Intentionally mount-only: prompt for a key on first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function submit() {
    const t = task.trim();
    if (!t || studio.running) return;
    if (!configured) {
      setSettingsOpen(true);
      return;
    }
    setTask("");
    void studio.runTask(t, model);
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="mark">
            Er<b>dou</b>
          </span>
          <span className="tag">browser agent OS</span>
        </div>
        <div className="spacer" />
        <span className="status-chip">
          <span className="dot on" /> runtime live
        </span>
        <span className="status-chip" title="What the runtime can execute. Python loads on first use; wasi runs wasm32-wasi binaries.">
          js · python · wasi
        </span>
        <span className="status-chip">
          <span className={"dot " + (studio.running ? "busy" : configured ? "on" : "warn")} />
          {studio.running ? "working" : configured ? model.model : "no model key"}
        </span>
        <button className="btn ghost" onClick={() => setSettingsOpen(true)}>
          Model
        </button>
        <button className="btn ghost" onClick={() => void studio.resetProject()}>
          Reset
        </button>
      </header>

      <div className="main">
        <section className="workspace">
          <div className="composer">
            <div className="eyebrow">Describe a task — the agent operates the OS</div>
            <div className="row">
              <textarea
                value={task}
                onChange={(e) => setTask(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
                }}
                placeholder="e.g. Create a /site folder with an index.html that says Hello, then list it."
              />
              <button className="btn primary" disabled={studio.running || task.trim().length === 0} onClick={submit}>
                {studio.running ? "Working…" : "Run  ⌘⏎"}
              </button>
            </div>
          </div>
          <TraceTape trace={studio.trace} running={studio.running} />
        </section>

        <section className="inspector">
          <div className="tabs">
            <button className={"tab " + (tab === "files" ? "active" : "")} onClick={() => setTab("files")}>
              files
            </button>
            <button className={"tab " + (tab === "terminal" ? "active" : "")} onClick={() => setTab("terminal")}>
              terminal
            </button>
            <button className={"tab " + (tab === "processes" ? "active" : "")} onClick={() => setTab("processes")}>
              processes
            </button>
            <button className={"tab " + (tab === "preview" ? "active" : "")} onClick={() => setTab("preview")}>
              preview
            </button>
          </div>
          {tab === "files" && <FilePanel studio={studio} />}
          {tab === "terminal" && <TerminalPanel studio={studio} />}
          {tab === "processes" && <ProcessPanel studio={studio} />}
          {tab === "preview" && <PreviewPanel studio={studio} />}
        </section>
      </div>

      {settingsOpen && (
        <SettingsDialog
          initial={model}
          onSave={(cfg) => {
            saveModel(cfg);
            setModel(cfg);
            setSettingsOpen(false);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
