import { useState, useEffect } from "react";
import type { ModelConfig } from "@erdou/model-gateway";
import { useStudio } from "./lib/use-studio.js";
import { loadModel, saveModel, loadApprovalMode, saveApprovalMode, type ApprovalMode } from "./lib/model-config.js";
import { SettingsDialog } from "./components/SettingsDialog.js";
import { TitleBar } from "./components/TitleBar.js";
import { TaskSidebar } from "./components/TaskSidebar.js";
import { Conversation } from "./components/Conversation.js";
import { Composer } from "./components/Composer.js";
import { ReviewPane } from "./components/ReviewPane.js";

export function App() {
  const studio = useStudio();
  const [model, setModel] = useState<ModelConfig>(() => loadModel());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mode, setMode] = useState<ApprovalMode>(() => loadApprovalMode());

  const configured = model.apiKey.trim().length > 0;

  // Composer selector and Settings share this one persisted value.
  function changeMode(next: ApprovalMode) {
    setMode(next);
    saveApprovalMode(next);
    studio.saveConfigToFolder();
  }

  useEffect(() => {
    if (!configured) setSettingsOpen(true);
    // Intentionally mount-only: prompt for a key on first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reply into the selected thread if one is active and idle; otherwise start
  // a fresh thread. "+ New task" clears the selection via newDraft(), so the
  // next send always falls into the startRun branch.
  function runTask(task: string) {
    if (!configured) {
      setSettingsOpen(true);
      return;
    }
    const active = studio.activeRun;
    if (active && !studio.running && active.status !== "running") {
      void studio.replyToRun(active.id, task, model, mode);
    } else {
      void studio.startRun(task, model, mode);
    }
  }

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
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return; // real user-cancel
      studio.logSystem("error", "Failed to mount folder", err instanceof Error ? err.message : String(err));
      throw err;
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
        onReset={() => void studio.resetProject()}
        onThemeChange={() => studio.saveConfigToFolder()}
      />
      <div className="shell">
        <TaskSidebar studio={studio} onNew={() => studio.newDraft()} onOpenFolder={() => void openFolder()} />
        <section className="center">
          <div className="thread-head">
            <span className="t">{studio.activeRun?.title ?? "New task"}</span>
            {studio.activeRun && <span className={"chip " + studio.activeRun.status}>{studio.activeRun.status}</span>}
          </div>
          <Conversation studio={studio} />
          <Composer
            running={studio.running || studio.activeRun?.status === "running"}
            replying={studio.activeRun !== undefined}
            mode={mode}
            onModeChange={changeMode}
            onRun={runTask}
          />
        </section>
        <section className="review">
          <ReviewPane studio={studio} />
        </section>
      </div>

      {settingsOpen && (
        <SettingsDialog
          initial={model}
          approvalMode={mode}
          onApprovalModeChange={changeMode}
          onSave={(cfg) => {
            saveModel(cfg);
            setModel(cfg);
            studio.saveConfigToFolder();
            setSettingsOpen(false);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
