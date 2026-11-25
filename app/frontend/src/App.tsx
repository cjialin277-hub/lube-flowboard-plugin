import { useEffect, useRef } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { Board } from "./canvas/Board";
import { AddNodePalette } from "./canvas/AddNodePalette";
import { Toolbar } from "./components/Toolbar";
// import { ChatSidebar } from "./components/ChatSidebar";
import { ChatDock } from "./components/ChatDock";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { ReferencesPanel } from "./components/ReferencesPanel";
import { Toaster } from "./components/Toaster";
import { GenerationDialog } from "./components/GenerationDialog";
import { ResultViewer } from "./components/ResultViewer";
import { ForcedSetupGate } from "./components/ForcedSetupGate";
import { useBoardStore } from "./store/board";
import { useReferencesStore } from "./store/references";
import { useSettingsStore } from "./store/settings";
import { useLang } from "./i18n";

export function App() {
  const loadInitialBoard = useBoardStore((s) => s.loadInitialBoard);
  const loadReferences = useReferencesStore((s) => s.load);
  const loading = useBoardStore((s) => s.loading);
  const boardId = useBoardStore((s) => s.boardId);
  const themeMode = useSettingsStore((s) => s.themeMode);
  const wallpaperId = useSettingsStore((s) => s.wallpaperId);
  const { t } = useLang();
  const ran = useRef(false);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", themeMode);
    document.body.setAttribute("data-theme", themeMode);
  }, [themeMode]);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    loadInitialBoard();
    // Fire-and-forget: panel renders the loading state inline and the
    // app stays usable even if references fail to hydrate.
    void loadReferences();
  }, [loadInitialBoard, loadReferences]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void useBoardStore.getState().refreshBoardList();
      void useBoardStore.getState().syncLiveNodeMedia();
    }, 4000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div
      className={`app theme-${themeMode}${wallpaperId !== "none" ? " app--has-wallpaper" : ""}`}
      data-theme={themeMode}
    >
      <ProjectSidebar />
      <ReactFlowProvider>
        <div className="canvas-wrap">
          <Toolbar />
          {loading && boardId === null ? (
            <div className="canvas-loading">{t("正在加载画布…", "Loading board…")}</div>
          ) : (
            <>
              <Board />
              <AddNodePalette />
            </>
          )}
          <ReferencesPanel />
          <ChatDock />
        </div>
      </ReactFlowProvider>
      {/* <ChatSidebar /> */}
      <Toaster />
      <GenerationDialog />
      <ResultViewer />
      <ForcedSetupGate />
    </div>
  );
}
