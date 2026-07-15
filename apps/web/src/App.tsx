import { useState, useEffect } from "react";
import type { ModelConfig } from "@erdou/model-gateway";
import { useStudio } from "./lib/use-studio.js";
import { loadModel, saveModel } from "./lib/model-config.js";
import { SettingsDialog } from "./components/SettingsDialog.js";
import { TitleBar } from "./components/TitleBar.js";

export function App() {
  const studio = useStudio();
  const [model, setModel] = useState<ModelConfig>(() => loadModel());
  const [settingsOpen, setSettingsOpen] = useState(false);

  const configured = model.apiKey.trim().length > 0;

  useEffect(() => {
    if (!configured) setSettingsOpen(true);
    // Intentionally mount-only: prompt for a key on first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openFolder() {
    const picker = (window as unknown as { showDirectoryPicker?: (o?: unknown) => Promise<unknown> })
      .showDirectoryPicker;
    if (!picker) {
      window.alert("Folder mounting needs the File System Access API — use Chrome or Edge.");
      return;
    }
    try {
      const handle = await picker({ mode: "readwrite" });
      await studio.mountFolder(handle as never);
    } catch {
      /* user cancelled the picker */
    }
  }

  const workspace = studio.mountName ?? "workspace";

  return (
    <div className="app">
      <TitleBar
        workspace={workspace}
        model={configured ? model.model : "no model key"}
        running={studio.running}
        onSettings={() => setSettingsOpen(true)}
      />
      <div className="shell">
        <aside className="sidebar">
          <div className="stub">task sidebar — Task 7</div>
          <div className="sidebar-footer">
            {studio.mount ? (
              <span className="chip" title="Local folder mounted — changes sync to disk.">
                📁 {studio.mountName}
              </span>
            ) : studio.pendingMount ? (
              <button className="btn ghost" onClick={() => void studio.reconnectMount()}>
                Reconnect 📁 {studio.mountName}
              </button>
            ) : (
              <button className="btn ghost" onClick={() => void openFolder()}>
                Open folder
              </button>
            )}
          </div>
        </aside>
        <section className="center">
          <div className="stub">conversation — Task 8</div>
        </section>
        <section className="review">
          <div className="stub">review — Task 10</div>
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
