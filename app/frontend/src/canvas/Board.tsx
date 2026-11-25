import { useCallback, useEffect, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  useViewport,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type OnConnectStartParams,
  type OnNodeDrag,
} from "@xyflow/react";

import { useBoardStore, type FlowNode, type NodeType } from "../store/board";
import { applyDirectorTemplate, listDirectorTemplates } from "../api/client";
import { NodeCard } from "./NodeCard";
import { NodeTypeIcon } from "./NodeTypeIcon";
import { VariantEdge } from "./VariantEdge";
import { useGenerationStore } from "../store/generation";
import { WALLPAPER_PRESETS, useSettingsStore } from "../store/settings";
import { useLang } from "../i18n";
import gsap from "gsap";

const nodeTypes = {
  character: NodeCard,
  image: NodeCard,
  video: NodeCard,
  prompt: NodeCard,
  note: NodeCard,
  visual_asset: NodeCard,
  Storyboard: NodeCard,
};

// Single edge type used for everything — VariantEdge renders the
// default bezier line and additionally surfaces a `v{N}` chip when the
// edge has a variant pin in `data.sourceVariantIdx`.
const edgeTypes = {
  default: VariantEdge,
};

const defaultEdgeOptions = {
  // Bump the visible stroke + a wider transparent hit area so the edge is
  // easy to *select*. Selected edge is then deleted via Backspace/Delete.
  style: { stroke: "rgba(255, 255, 255, 0.20)", strokeWidth: 1.75, cursor: "pointer" },
  interactionWidth: 24,
};

type GridMode = "lines" | "dots" | "off";

function readInitialGridMode(): GridMode {
  try {
    const raw = window.localStorage.getItem("flowboard.gridMode");
    if (raw === "lines" || raw === "dots" || raw === "off") return raw;
  } catch {
    // Ignore storage errors in sandboxed/private contexts
  }
  return "lines";
}

// Quick-add popover that appears when the user drops a connection drag on
// empty canvas. Lives inside <ReactFlow> so it can use useReactFlow for
// screen↔flow coord conversion. Two buttons: Image, Video. Click → create
// node at the cursor + auto-connect from the source handle.
function DropAddPopover({
  popover,
  onPick,
  onClose,
}: {
  popover: { clientX: number; clientY: number; sourceId: string } | null;
  onPick: (type: NodeType, flowPos: { x: number; y: number }) => void;
  onClose: () => void;
}) {
  const { screenToFlowPosition } = useReactFlow();
  const { t } = useLang();

  // Auto-dismiss after 3s of no interaction so the popover doesn't linger
  // when the user actually meant to discard the drag.
  useEffect(() => {
    if (!popover) return;
    const t = window.setTimeout(onClose, 3000);
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onOutside = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && !t.closest(".drop-popover")) onClose();
    };
    document.addEventListener("keydown", onEsc);
    document.addEventListener("mousedown", onOutside);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("keydown", onEsc);
      document.removeEventListener("mousedown", onOutside);
    };
  }, [popover, onClose]);

  if (!popover) return null;

  const handle = (type: NodeType) => {
    const flowPos = screenToFlowPosition({ x: popover.clientX, y: popover.clientY });
    onPick(type, flowPos);
  };

  return (
    <div
      className="drop-popover"
      style={{ left: popover.clientX + 8, top: popover.clientY + 8 }}
      role="menu"
      aria-label={t("新建并连入节点", "Add connected node")}
    >
      <button type="button" className="drop-popover__btn" onClick={() => handle("image")}>
        <NodeTypeIcon type="image" size={13} className="drop-popover__icon" /> {t("分镜画面", "Image")}
      </button>
      <button type="button" className="drop-popover__btn" onClick={() => handle("video")}>
        <NodeTypeIcon type="video" size={13} className="drop-popover__icon" /> {t("动态视频", "Video")}
      </button>
    </div>
  );
}

export function Board() {
  const boardId = useBoardStore((s) => s.boardId);
  const nodes = useBoardStore((s) => s.nodes);
  const edges = useBoardStore((s) => s.edges);
  const setNodes = useBoardStore((s) => s.setNodes);
  const setEdges = useBoardStore((s) => s.setEdges);
  const persistNodePosition = useBoardStore((s) => s.persistNodePosition);
  const addEdgeFromConnection = useBoardStore((s) => s.addEdgeFromConnection);
  const addNodeOfType = useBoardStore((s) => s.addNodeOfType);
  const refreshBoardState = useBoardStore((s) => s.refreshBoardState);
  const createNewBoard = useBoardStore((s) => s.createNewBoard);
  const deleteNodeByRfId = useBoardStore((s) => s.deleteNodeByRfId);
  const deleteEdgeByRfId = useBoardStore((s) => s.deleteEdgeByRfId);
  const undoStack = useBoardStore((s) => s.undoStack);
  const undoNotice = useBoardStore((s) => s.undoNotice);
  const setUndoNotice = useBoardStore((s) => s.setUndoNotice);
  const undoLastAction = useBoardStore((s) => s.undoLastAction);
  const { screenToFlowPosition } = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [applyingStarter, setApplyingStarter] = useState(false);
  const [gridMode, setGridMode] = useState<GridMode>(readInitialGridMode);
  const themeMode = useSettingsStore((s) => s.themeMode);
  const wallpaperId = useSettingsStore((s) => s.wallpaperId);
  const activeWallpaper = WALLPAPER_PRESETS.find((w) => w.id === wallpaperId) ?? null;
  const wallpaperStageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!wallpaperStageRef.current || !activeWallpaper) return;
    gsap.fromTo(
      wallpaperStageRef.current,
      { opacity: 0.15, scale: 1.03 },
      { opacity: 1, scale: 1, duration: 0.52, ease: "power2.out", overwrite: "auto" },
    );
  }, [activeWallpaper]);

  const cycleGridMode = useCallback(() => {
    setGridMode((cur) => {
      const next: GridMode = cur === "lines" ? "dots" : cur === "dots" ? "off" : "lines";
      try {
        window.localStorage.setItem("flowboard.gridMode", next);
      } catch {
        // Non-fatal
      }
      return next;
    });
  }, []);

  const [dropPopover, setDropPopover] = useState<
    { clientX: number; clientY: number; sourceId: string } | null
  >(null);
  // Drag-state: whether a connection was successfully made. onConnect fires
  // before onConnectEnd, so we use this to decide whether the drop landed
  // on empty canvas (→ show popover) or on a real handle (→ already wired).
  const connectStateRef = useRef<{ sourceId: string | null; didConnect: boolean }>({
    sourceId: null,
    didConnect: false,
  });

  // Reference-panel drop handler — fires when the user drags a saved
  // reference card from the right-side library onto the canvas. We
  // detect the custom MIME we set in ReferencesPanel and spawn a new
  // visual_asset node at the cursor's flow-space position. The browser
  // requires onDragOver to call preventDefault() or the onDrop never
  // fires on this element.
  const onCanvasDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("application/x-flowboard-reference")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const onCanvasDrop = useCallback(
    (e: React.DragEvent) => {
      const raw = e.dataTransfer.getData("application/x-flowboard-reference");
      if (!raw) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        const ref = JSON.parse(raw) as {
          mediaId: string;
          aiBrief?: string | null;
          aspectRatio?: string | null;
          kind: string;
          label: string;
        };
        const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        void useBoardStore.getState().addReferenceNode(ref, flowPos);
      } catch (err) {
        console.warn("Failed to parse reference drop payload", err);
      }
    },
    [screenToFlowPosition],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // Persist node deletes immediately. ReactFlow ALSO fires
      // `onNodesDelete` for the same event, but we don't trust it as the
      // sole hook because in some keyboard-focus configurations only the
      // `onNodesChange` event with type:"remove" fires (the local state
      // updates via applyNodeChanges but onNodesDelete never gets called
      // → node visually disappears but reappears on reload because the
      // backend never heard about it). Calling deleteNodeByRfId here
      // covers both cases; the action is idempotent server-side (404 on
      // the second call is silently swallowed).
      for (const c of changes) {
        if (c.type === "remove") {
          void deleteNodeByRfId(c.id);
        }
      }
      setNodes(applyNodeChanges(changes, useBoardStore.getState().nodes) as FlowNode[]);
    },
    [setNodes, deleteNodeByRfId],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      // Same fix as onNodesChange — backend deletion is driven by the
      // change event, not by ReactFlow's separate onEdgesDelete callback.
      for (const c of changes) {
        if (c.type === "remove") {
          void deleteEdgeByRfId(c.id);
        }
      }
      setEdges(applyEdgeChanges(changes, useBoardStore.getState().edges));
    },
    [setEdges, deleteEdgeByRfId],
  );

  const onNodeDragStop: OnNodeDrag<FlowNode> = useCallback(
    (_event, node) => {
      persistNodePosition(node.id, node.position);
    },
    [persistNodePosition],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (connection.source && connection.target) {
        addEdgeFromConnection(connection.source, connection.target);
        connectStateRef.current.didConnect = true;
      }
    },
    [addEdgeFromConnection],
  );

  const onConnectStart = useCallback(
    (_event: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
      // Only track drags that started from a source handle (the right side
      // of a node). Target-side drags are unusual and the current edges
      // are directional source→target, so we don't open the popover for
      // those.
      if (params.handleType !== "source" || !params.nodeId) {
        connectStateRef.current = { sourceId: null, didConnect: false };
        return;
      }
      connectStateRef.current = { sourceId: params.nodeId, didConnect: false };
    },
    [],
  );

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent) => {
      const { sourceId, didConnect } = connectStateRef.current;
      connectStateRef.current = { sourceId: null, didConnect: false };
      if (!sourceId || didConnect) return;
      // Drop on empty canvas — pop up a quick-add menu at the release
      // point. Coords are in client (screen) space; the popover will
      // convert to flow space for the new node's position.
      const e = event as MouseEvent;
      const cx = typeof e.clientX === "number" ? e.clientX : 0;
      const cy = typeof e.clientY === "number" ? e.clientY : 0;
      setDropPopover({ clientX: cx, clientY: cy, sourceId });
    },
    [],
  );

  const handlePickAdd = useCallback(
    async (type: NodeType, flowPos: { x: number; y: number }) => {
      const sourceId = dropPopover?.sourceId;
      setDropPopover(null);
      if (!sourceId) return;
      const newId = await addNodeOfType(type, flowPos);
      if (newId) {
        await addEdgeFromConnection(sourceId, newId);
      }
    },
    [dropPopover, addNodeOfType, addEdgeFromConnection],
  );

  const onNodesDelete = useCallback(
    (deletedNodes: FlowNode[]) => {
      deletedNodes.forEach((n) => deleteNodeByRfId(n.id));
    },
    [deleteNodeByRfId],
  );

  const onEdgesDelete = useCallback(
    (deletedEdges: { id: string }[]) => {
      deletedEdges.forEach((e) => deleteEdgeByRfId(e.id));
    },
    [deleteEdgeByRfId],
  );

  const onNodeDoubleClick = useCallback(
    (_event: React.MouseEvent, node: FlowNode) => {
      const isGenerable = [
        "image",
        "prompt",
        "video",
        "visual_asset",
        "character",
        "Storyboard",
      ].includes(node.data.type);
      if (!isGenerable) return;
      const s = useGenerationStore.getState();
      if (node.data.mediaId) {
        s.openResultViewer(node.id);
      } else {
        s.openGenerationDialog(node.id, node.data.prompt ?? "");
      }
    },
    [],
  );

  // Global canvas shortcuts:
  //   - `g` opens generation dialog / result viewer for selected node
  //   - `⌘/Ctrl + =/+` (or bare `=`/`+`) zooms in
  //   - `⌘/Ctrl + -` (or bare `-`) zooms out
  //   - `⌘/Ctrl + 0` fits all nodes in view
  //   - `⌘/Ctrl + 1` resets zoom to 100%
  const { zoomIn, zoomOut, zoomTo, fitView } = useReactFlow();
  const { zoom } = useViewport();
  const { t } = useLang();
  const zoomPct = Math.round((zoom || 1) * 100);

  useEffect(() => {
    if (!undoNotice) return;
    const timer = window.setTimeout(() => setUndoNotice(null), 4800);
    return () => window.clearTimeout(timer);
  }, [undoNotice, setUndoNotice]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const genState = useGenerationStore.getState();
      if (genState.openDialog.rfId !== null || genState.openViewer.rfId !== null) {
        return;
      }
      const active = document.activeElement;
      const tag = (active?.tagName ?? "").toLowerCase();
      if (
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        (active instanceof HTMLElement && active.isContentEditable)
      ) {
        return;
      }

      if (e.metaKey || e.ctrlKey) {
        if (e.key.toLowerCase() === "z" && !e.shiftKey) {
          e.preventDefault();
          void useBoardStore.getState().undoLastAction();
          return;
        }
        if (e.key === "=" || e.key === "+") {
          e.preventDefault();
          void zoomIn({ duration: 180 });
          return;
        }
        if (e.key === "-" || e.key === "_") {
          e.preventDefault();
          void zoomOut({ duration: 180 });
          return;
        }
        if (e.key === "0") {
          e.preventDefault();
          void fitView({ padding: 0.22, duration: 240 });
          return;
        }
        if (e.key === "1") {
          e.preventDefault();
          void zoomTo(1, { duration: 180 });
          return;
        }
        return;
      }

      if (e.altKey) return;

      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        void zoomIn({ duration: 180 });
        return;
      }
      if (e.key === "-") {
        e.preventDefault();
        void zoomOut({ duration: 180 });
        return;
      }

      if (e.key.toLowerCase() !== "g") return;

      const selectedNodes = useBoardStore
        .getState()
        .nodes.filter(
          (n) =>
            n.selected &&
            ["image", "prompt", "video", "character", "Storyboard"].includes(
              n.data.type,
            ),
        );
      if (selectedNodes.length === 0) return;
      e.preventDefault();
      const target = selectedNodes[0];
      if (target.data.mediaId) {
        genState.openResultViewer(target.id);
      } else {
        genState.openGenerationDialog(target.id, target.data.prompt ?? "");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [zoomIn, zoomOut, zoomTo, fitView]);

  const handleSpawnStarterNode = useCallback(
    (type: NodeType) => {
      const rect = wrapperRef.current?.getBoundingClientRect();
      const cx = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
      const cy = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
      void addNodeOfType(type, screenToFlowPosition({ x: cx, y: cy }));
    },
    [addNodeOfType, screenToFlowPosition],
  );

  const handleApplyDefaultTemplate = useCallback(async () => {
    if (applyingStarter) return;
    setApplyingStarter(true);
    try {
      const res = await listDirectorTemplates();
      const items = res.items ?? [];
      if (items.length === 0) return;
      const preferred = items.find((tpl) => tpl.seq_id === "SEQ-0020") ?? items[0];
      let targetBoardId = boardId;
      if (targetBoardId === null) {
        const shortName = preferred.name.split("（")[0].slice(0, 24);
        targetBoardId = await createNewBoard(`${preferred.seq_id} · ${shortName}`);
        if (targetBoardId === null) return;
      }
      await applyDirectorTemplate(targetBoardId, {
        seq_id: preferred.seq_id,
        clear_existing: false,
      });
      await refreshBoardState();
      setTimeout(() => {
        void fitView({ padding: 0.2, duration: 260 });
      }, 120);
    } finally {
      setApplyingStarter(false);
    }
  }, [applyingStarter, boardId, createNewBoard, refreshBoardState, fitView]);

  const isLight = themeMode === "light";
  const minorGridColor = isLight
    ? "rgba(15, 23, 42, 0.068)"
    : "rgba(255, 255, 255, 0.048)";
  const majorGridColor = isLight
    ? "rgba(15, 23, 42, 0.135)"
    : "rgba(255, 255, 255, 0.105)";
  const dotsGridColor = isLight
    ? "rgba(15, 23, 42, 0.22)"
    : "rgba(255, 255, 255, 0.18)";

  return (
    <div
      ref={wrapperRef}
      className={`board-stage-wrap${activeWallpaper ? " board-stage-wrap--wallpaper" : ""}`}
      style={{ flex: 1, minHeight: 0, width: "100%", height: "100%", position: "relative" }}
      onDragOver={onCanvasDragOver}
      onDrop={onCanvasDrop}
    >
      {activeWallpaper && (
        <div
          ref={wallpaperStageRef}
          className={`canvas-wallpaper-stage canvas-wallpaper-stage--${themeMode}`}
          aria-hidden="true"
        >
          <div
            className="canvas-wallpaper-stage__ambient"
            style={{ backgroundImage: `url(${activeWallpaper.url})` }}
          />
          <div
            className="canvas-wallpaper-stage__hero"
            style={{ backgroundImage: `url(${activeWallpaper.url})` }}
          />
          <div className="canvas-wallpaper-stage__scrim" />
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        onNodesDelete={onNodesDelete}
        onEdgesDelete={onEdgesDelete}
        onNodeDoubleClick={onNodeDoubleClick}
        deleteKeyCode={["Backspace", "Delete"]}
        defaultEdgeOptions={defaultEdgeOptions}
        connectionRadius={32}
        minZoom={0.15}
        maxZoom={3}
        zoomOnScroll
        zoomOnPinch
        fitView
        proOptions={{ hideAttribution: true }}
      >
        {gridMode === "lines" && (
          <>
            <Background
              id="grid-minor"
              variant={BackgroundVariant.Lines}
              gap={24}
              lineWidth={1}
              color={minorGridColor}
            />
            <Background
              id="grid-major"
              variant={BackgroundVariant.Lines}
              gap={120}
              lineWidth={1}
              color={majorGridColor}
            />
          </>
        )}
        {gridMode === "dots" && (
          <Background
            id="grid-dots"
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1.25}
            color={dotsGridColor}
          />
        )}
        {nodes.length > 0 && (
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) => {
              if (n.type === "character") return isLight ? "#6366f1" : "#a1a1aa";
              if (n.type === "video") return isLight ? "#0ea5e9" : "#d4d4d8";
              if (n.type === "image") return isLight ? "#8b5cf6" : "#71717a";
              return isLight ? "#64748b" : "#52525b";
            }}
            maskColor={isLight ? "rgba(241, 245, 249, 0.76)" : "rgba(12, 12, 13, 0.78)"}
          />
        )}
        <div
          className="canvas-zoom-dock"
          role="group"
          aria-label={t("画布浮动缩放栏", "Floating canvas zoom bar")}
        >
          <button
            type="button"
            className="canvas-zoom-dock__btn"
            onClick={() => void zoomOut({ duration: 180 })}
            title={t("缩小画布 (− / ⌘−)", "Zoom out (− / ⌘−)")}
            aria-label={t("缩小画布", "Zoom out")}
          >
            −
          </button>
          <button
            type="button"
            className="canvas-zoom-dock__pct"
            onClick={() => void zoomTo(1, { duration: 180 })}
            title={t("点击还原 100% 比例 (⌘1)", "Reset to 100% (⌘1)")}
          >
            {zoomPct}%
          </button>
          <button
            type="button"
            className="canvas-zoom-dock__btn"
            onClick={() => void zoomIn({ duration: 180 })}
            title={t("放大画布 (+ / ⌘+)", "Zoom in (+ / ⌘+)")}
            aria-label={t("放大画布", "Zoom in")}
          >
            +
          </button>
          <span className="canvas-zoom-dock__sep" aria-hidden="true" />
          <button
            type="button"
            className="canvas-zoom-dock__fit"
            onClick={() => void fitView({ padding: 0.22, duration: 240 })}
            title={t("适应画布全屏显示所有节点 (⌘0)", "Fit all nodes on screen (⌘0)")}
            aria-label={t("适应画布", "Fit all")}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />
            </svg>
          </button>
          <button
            type="button"
            className="canvas-zoom-dock__undo"
            disabled={undoStack.length === 0}
            onClick={() => void undoLastAction()}
            title={
              undoStack.length > 0
                ? t(`撤销上一步 (${undoStack.length} · ⌘Z)`, `Undo last action (${undoStack.length} · ⌘Z)`)
                : t("暂无可撤销操作 (⌘Z)", "Nothing to undo (⌘Z)")
            }
            aria-label={t("撤销上一步", "Undo last action")}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3.5 6.5H10a3.5 3.5 0 110 7H7" />
              <path d="M6 4L3.2 6.5 6 9" />
            </svg>
          </button>
          <span className="canvas-zoom-dock__sep" aria-hidden="true" />
          <button
            type="button"
            className={`canvas-zoom-dock__grid${gridMode !== "off" ? " canvas-zoom-dock__grid--active" : ""}`}
            onClick={cycleGridMode}
            data-grid-mode={gridMode}
            title={
              gridMode === "lines"
                ? t("背景网格：方格线（点击切换为点阵）", "Canvas grid: Lines (click for Dots)")
                : gridMode === "dots"
                ? t("背景网格：点阵（点击隐藏网格）", "Canvas grid: Dots (click to Hide)")
                : t("背景网格：已隐藏（点击开启方格线）", "Canvas grid: Off (click for Lines)")
            }
            aria-label={t("切换背景网格显示方式", "Toggle canvas background grid")}
          >
            {gridMode === "dots" ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <circle cx="4" cy="4" r="1.2" />
                <circle cx="8" cy="4" r="1.2" />
                <circle cx="12" cy="4" r="1.2" />
                <circle cx="4" cy="8" r="1.2" />
                <circle cx="8" cy="8" r="1.2" />
                <circle cx="12" cy="8" r="1.2" />
                <circle cx="4" cy="12" r="1.2" />
                <circle cx="8" cy="12" r="1.2" />
                <circle cx="12" cy="12" r="1.2" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
                <path d="M5.5 2v12M10.5 2v12M2 5.5h12M2 10.5h12" />
                {gridMode === "off" && <path d="M2.5 2.5l11 11" />}
              </svg>
            )}
          </button>
        </div>
        <DropAddPopover
          popover={dropPopover}
          onPick={handlePickAdd}
          onClose={() => setDropPopover(null)}
        />
      </ReactFlow>
      {undoNotice && (
        <div className="canvas-undo-toast" role="status">
          <span>{undoNotice.text}</span>
          {undoNotice.canUndo && undoStack.length > 0 && (
            <button
              type="button"
              className="canvas-undo-toast__btn"
              onClick={() => void undoLastAction()}
            >
              {t("撤销 ⌘Z", "Undo ⌘Z")}
            </button>
          )}
          <button
            type="button"
            className="canvas-undo-toast__close"
            onClick={() => setUndoNotice(null)}
            aria-label={t("关闭", "Dismiss")}
          >
            ×
          </button>
        </div>
      )}
      {nodes.length === 0 && (
        <div className="canvas-empty-state" aria-label={t("画布快速起步引导", "Canvas quick start")}>
          <div className="canvas-empty-state__card">
            <h2 className="canvas-empty-state__title">
              {t("开始编排你的下一场戏", "Compose your next scene")}
            </h2>
            <p className="canvas-empty-state__desc">
              {t(
                "一键套用沙漏四列导演模板，或直接创建首个角色与分镜节点。",
                "Start with an Hourglass 4-column director template, or drop your first character and shot node.",
              )}
            </p>
            <div className="canvas-empty-state__actions">
              <button
                type="button"
                className="canvas-empty-state__btn canvas-empty-state__btn--primary"
                onClick={() => void handleApplyDefaultTemplate()}
                disabled={applyingStarter}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="2" y="2.5" width="5" height="5" rx="1" />
                  <rect x="9" y="2.5" width="5" height="5" rx="1" />
                  <rect x="2" y="9" width="5" height="4.5" rx="1" />
                  <rect x="9" y="9" width="5" height="4.5" rx="1" />
                </svg>
                <span>
                  {applyingStarter
                    ? t("正在铺板…", "Applying template…")
                    : t("一键铺设 4 列导演骨架", "Apply 4-col director template")}
                </span>
              </button>
              <button
                type="button"
                className="canvas-empty-state__btn"
                onClick={() => handleSpawnStarterNode("character")}
              >
                <span>+ {t("角色锚点", "Character")}</span>
              </button>
              <button
                type="button"
                className="canvas-empty-state__btn"
                onClick={() => handleSpawnStarterNode("image")}
              >
                <span>+ {t("分镜画面", "Shot image")}</span>
              </button>
            </div>
            <div className="canvas-empty-state__hints">
              <span>{t("滚轮缩放 · 拖动画布", "Scroll to zoom · Drag canvas")}</span>
              <span aria-hidden="true">·</span>
              <span>
                <kbd className="canvas-kbd">⌘0</kbd> {t("适应全屏", "Fit")}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                <kbd className="canvas-kbd">G</kbd> {t("生成选中", "Generate")}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
