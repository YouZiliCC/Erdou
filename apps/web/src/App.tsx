import { useState, useEffect } from "react";
import type { ModelConfig } from "@erdou/model-gateway";
import { useStudio } from "./lib/use-studio.js";
import { loadModel, saveModel, loadApprovalMode, saveApprovalMode, type ApprovalMode } from "./lib/model-config.js";
import { loadLayout, saveLayout, clampSidebar, clampReview, type LayoutState } from "./lib/layout-state.js";
import { SettingsDialog } from "./components/SettingsDialog.js";
import { TitleBar } from "./components/TitleBar.js";
import { KernelToggle } from "./components/KernelToggle.js";
import { TaskSidebar } from "./components/TaskSidebar.js";
import { Conversation } from "./components/Conversation.js";
import { Composer, type ComposerPrefill } from "./components/Composer.js";
import { ReviewPane } from "./components/ReviewPane.js";
import { ResizableShell } from "./components/ResizableShell.js";
import { SecureContextBanner } from "./components/SecureContextBanner.js";

export function App() {
  const studio = useStudio();
  const [model, setModel] = useState<ModelConfig>(() => loadModel());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mode, setMode] = useState<ApprovalMode>(() => loadApprovalMode());
  const [layout, setLayout] = useState<LayoutState>(() => loadLayout());
  // Empty-state example chips seed the composer through this; the nonce makes
  // re-clicking the same chip take effect again (Composer keys its effect on it).
  const [prefill, setPrefill] = useState<ComposerPrefill>({ text: "", nonce: 0 });

  const configured = model.apiKey.trim().length > 0;

  // The three columns' geometry (widths + sidebar-collapsed) persists across
  // reloads. Clamp on every mutation so a bad value can never be stored, then
  // save. layout-state.ts owns all bounds; the drag handlers pre-clamp too.
  function updateLayout(patch: Partial<LayoutState>) {
    setLayout((prev) => {
      const next: LayoutState = {
        sidebarWidth: clampSidebar(patch.sidebarWidth ?? prev.sidebarWidth),
        reviewWidth: clampReview(patch.reviewWidth ?? prev.reviewWidth),
        sidebarCollapsed: patch.sidebarCollapsed ?? prev.sidebarCollapsed,
      };
      saveLayout(next);
      return next;
    });
  }

  // Re-clamp the layout whenever the window shrinks: a review width valid on a
  // wide screen would otherwise strand the center column (.review is flex:0 0
  // with min-width, so .center shrinks to 0). loadLayout() re-derives from the
  // PERSISTED (desired) width clamped to the new viewport without overwriting
  // it, so shrinking never hides the chat and re-widening restores the width.
  useEffect(() => {
    function onResize() {
      setLayout((prev) => {
        const next = loadLayout();
        return next.sidebarWidth === prev.sidebarWidth &&
          next.reviewWidth === prev.reviewWidth &&
          next.sidebarCollapsed === prev.sidebarCollapsed
          ? prev
          : next;
      });
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

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

  // The folder is the source of truth for config: when `mountFolder` hydrates
  // a DIFFERENT theme/approval-mode/model from a mounted folder's `.erdou/`,
  // Studio bumps `configVersion` (never on unrelated notifies). Re-sync from
  // localStorage so the agent (via `runTask` below) and the composer/settings
  // UI pick it up immediately — no reload required. Re-reading on the initial
  // render too is a harmless no-op (same values just loaded by useState above).
  useEffect(() => {
    setModel(loadModel());
    setMode(loadApprovalMode());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studio.configVersion]);

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
      <SecureContextBanner />
      <TitleBar
        workspace={workspace}
        model={configured ? model.model : "no model key"}
        running={studio.running}
        onSettings={() => setSettingsOpen(true)}
        onReset={() => void studio.resetProject()}
        onThemeChange={() => studio.saveConfigToFolder()}
      >
        <KernelToggle studio={studio} />
      </TitleBar>
      <ResizableShell
        sidebarWidth={layout.sidebarWidth}
        reviewWidth={layout.reviewWidth}
        collapsed={layout.sidebarCollapsed}
        onSidebarWidthChange={(w) => updateLayout({ sidebarWidth: w })}
        onReviewWidthChange={(w) => updateLayout({ reviewWidth: w })}
        onExpandSidebar={() => updateLayout({ sidebarCollapsed: false })}
        sidebar={
          <TaskSidebar
            studio={studio}
            onNew={() => studio.newDraft()}
            onOpenFolder={() => void openFolder()}
            onCollapse={() => updateLayout({ sidebarCollapsed: true })}
          />
        }
        center={
          <section className="center">
            <div className="thread-head">
              <span className="t">{studio.activeRun?.title ?? "New task"}</span>
              {studio.activeRun && <span className={"chip " + studio.activeRun.status}>{studio.activeRun.status}</span>}
            </div>
            <Conversation
              studio={studio}
              onExample={(task) => setPrefill((p) => ({ text: task, nonce: p.nonce + 1 }))}
            />
            <Composer
              running={studio.running || studio.activeRun?.status === "running" || !!studio.switchingKernel}
              canStop={studio.running}
              stopping={studio.stopping}
              replying={studio.activeRun !== undefined}
              mode={mode}
              prefill={prefill}
              onModeChange={changeMode}
              onRun={runTask}
              onStop={() => studio.stopRun()}
            />
          </section>
        }
        review={
          <section className="review">
            <ReviewPane studio={studio} />
          </section>
        }
      />

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
