import { create } from "zustand";
import type { Edge, Node } from "@xyflow/react";
import {
  listBoards,
  createBoard,
  getBoard,
  patchBoard as apiPatchBoard,
  deleteBoard as apiDeleteBoard,
  createNode,
  patchNode,
  deleteNode,
  cancelNodeRequests,
  createEdge,
  deleteEdge,
  type Board,
  type NodeDTO,
  type NodeType,
} from "../api/client";
import { defaultAspectEnum, useSettingsStore } from "./settings";

export type { NodeType };

export type NodeStatus = "idle" | "queued" | "running" | "done" | "error";

// Storyboard grid options.
//   2x2 → 4 panels (square)
//   2x3 → 6 panels (rectangular: 2×3 on landscape, 3×2 on portrait)
//   2x4 → 8 panels (rectangular: 2×4 on landscape, 4×2 on portrait)
// The rows/cols mapping happens at prompt-build time based on the
// node's aspectRatio — see resolveStoryboardLayout in
// frontend/src/lib/storyboardPrompt.ts.
export type StoryboardGrid = "2x2" | "2x3" | "2x4";

export interface FlowboardNodeData extends Record<string, unknown> {
  type: NodeType;
  shortId: string;
  title: string;
  status?: NodeStatus;
  prompt?: string;
  thumbnailUrl?: string;
  mediaId?: string;
  // Per-variant media ids in dispatch order. `null` entries are
  // positional placeholders for variants that failed (e.g. Veo content
  // filter blocked one of the 4 i2v clips while the other 3 succeeded);
  // keeping the slot preserves alignment with the upstream image's
  // variants for poster/edge-pin lookups.
  mediaIds?: (string | null)[];
  // Per-slot error code, aligned to `mediaIds` indexing. `null` for
  // succeeded slots, an error string (e.g. "PUBLIC_ERROR_UNSAFE_GENERATION")
  // for blocked ones. ResultViewer reads this to render the exact
  // filter reason on the blocked tile instead of falling through to
  // the previous variant.
  slotErrors?: (string | null)[];
  variantCount?: number;
  // The aspect-ratio enum the asset was generated / uploaded at — used to
  // default-match downstream gen dialogs (e.g. a 9:16 visual_asset feeds
  // into a downstream image / video that defaults to 9:16). Values are
  // Flow's IMAGE_ASPECT_RATIO_* enum strings since that's what the upload
  // route + gen worker produce. Video targets map them onto the matching
  // VIDEO_ASPECT_RATIO_* enum at dialog-open time.
  aspectRatio?: string;
  // AI-generated factual description of mediaId (set by /api/vision/describe).
  // Spliced into auto-prompts on downstream nodes for richer context.
  aiBrief?: string;
  aiBriefStatus?: "pending" | "done" | "failed";
  // Transient status while the GenerationDialog runs `autoPrompt` /
  // `autoPromptBatch` against this node — set to "pending" while the
  // backend is composing the prompt, cleared on success/failure. Not
  // persisted to the DB; it's a few-second UX flag so the node can
  // render a visible "busy" treatment that blocks duplicate dispatches.
  autoPromptStatus?: "pending" | "done" | "failed";
  // ISO timestamp persisted when a generation completes successfully.
  // Powers the "5 phút trước" relative-time display in ResultViewer.
  // Uploads also stamp this so the timestamp reflects "when the asset
  // landed on the node" regardless of source.
  renderedAt?: string;
  // Model used to produce the rendered media. Populated on completion
  // of gen_image / edit_image (`imageModel`, e.g. "NANO_BANANA_PRO") or
  // gen_video (`videoQuality`, e.g. "fast" / "lite" / "quality"). Absent
  // on uploads (no model involved) and on nodes generated before this
  // feature shipped — ResultViewer falls back to current settings as
  // plain text in that case so the user knows it's an estimate.
  imageModel?: string;
  videoQuality?: string;
  mediaProvider?: string;
  // Character-builder selections — persisted on dispatch so the detail
  // panel can show "Country / Vibe / Gender" pills under METADATA. Keys
  // (`vn`, `clean`, `female`) match the constants in
  // `src/constants/character.ts`; viewer maps key → display label.
  charCountry?: string;
  charVibe?: string;
  charGender?: string;
  error?: string;
  // Storyboard layout. The Storyboard node is now a thin image-node
  // wrapper that generates a single composite using a locked prompt
  // template `Create visual storyboard for "<topic>" as SINGLE IMAGE
  // arranged in a NxN layout (N rows, N columns)`. Default `3x3` when
  // missing (true for fresh nodes + legacy pre-1.2.15 nodes whose
  // multi-shot data is now ignored).
  storyboardGrid?: StoryboardGrid;
  thumbnailMediaId?: string;
  isMasterNode?: boolean;
  firstLastMode?: boolean;
  seqId?: string;
}

export type FlowNode = Node<FlowboardNodeData>;

// Per-edge data we attach to ReactFlow's `Edge.data` so dispatch and
// edge-rendering paths can read it without a round-trip through the
// backend. `sourceVariantIdx` mirrors `EdgeDTO.source_variant_idx`.
export interface FlowboardEdgeData extends Record<string, unknown> {
  sourceVariantIdx?: number | null;
}

/** Map an EdgeDTO from the backend into ReactFlow's Edge shape, carrying
 * the variant pin through `data` so dispatch + edge UI can read it. */
function edgeFromDto(dto: {
  id: number;
  source_id: number;
  target_id: number;
  source_variant_idx?: number | null;
}): Edge<FlowboardEdgeData> {
  return {
    id: String(dto.id),
    source: String(dto.source_id),
    target: String(dto.target_id),
    data: { sourceVariantIdx: dto.source_variant_idx ?? null },
  };
}

function nodeFromDto(n: NodeDTO): FlowNode {
  return {
    id: String(n.id),
    type: n.type,
    position: { x: n.x, y: n.y },
    data: {
      type: n.type,
      shortId: n.short_id,
      title: (n.data["title"] as string | undefined) ?? TYPE_TITLE[n.type],
      status: n.status,
      prompt: n.data["prompt"] as string | undefined,
      thumbnailUrl: n.data["thumbnailUrl"] as string | undefined,
      thumbnailMediaId: n.data["thumbnailMediaId"] as string | undefined,
      isMasterNode: n.data["isMasterNode"] as boolean | undefined,
      firstLastMode: n.data["firstLastMode"] as boolean | undefined,
      seqId: n.data["seqId"] as string | undefined,
      mediaId: n.data["mediaId"] as string | undefined,
      mediaIds: n.data["mediaIds"] as (string | null)[] | undefined,
      slotErrors: n.data["slotErrors"] as (string | null)[] | undefined,
      variantCount: n.data["variantCount"] as number | undefined,
      aspectRatio: n.data["aspectRatio"] as string | undefined,
      aiBrief: n.data["aiBrief"] as string | undefined,
      imageModel: n.data["imageModel"] as string | undefined,
      videoQuality: n.data["videoQuality"] as string | undefined,
      mediaProvider: n.data["mediaProvider"] as string | undefined,
      renderedAt: n.data["renderedAt"] as string | undefined,
      charCountry: n.data["charCountry"] as string | undefined,
      charVibe: n.data["charVibe"] as string | undefined,
      charGender: n.data["charGender"] as string | undefined,
      storyboardGrid: n.data["storyboardGrid"] as StoryboardGrid | undefined,
      error: n.data["error"] as string | undefined,
    },
  };
}

// ── Reload resume ─────────────────────────────────────────────────────────
// A board's nodes now carry their real in-flight status from the DB (the
// worker writes it — see agent/flowboard/worker/processor.py), so a node
// that was generating when the tab reloaded comes back rendering as busy.
// Nothing re-attaches THIS page's poll loop to it though, so without the
// call below the card would sit on the processing UI until the generation's
// result was noticed by some later reload. Fire-and-forget: a board that
// can't resume is still fully usable.
//
// Dynamic import for the same reason deleteNodeByRfId uses one — the
// generation store imports this one, and a static import here would close
// the cycle at module init.
async function resumeActiveGenerations(boardId: number): Promise<void> {
  try {
    const { useGenerationStore } = await import("./generation");
    await useGenerationStore.getState().resumeActiveRequests(boardId);
  } catch {
    // Module not loaded (tree-shaken test path) or the fetch failed.
  }
}

// ── Tiny per-node debounce & delete guard (no external deps) ───────────────
const positionTimers = new Map<string, ReturnType<typeof setTimeout>>();
const deletingRfIds = new Set<string>();
const MAX_UNDO_STACK = 25;

export type UndoEntry =
  | {
      kind: "delete_node";
      oldRfId: string;
      nodeSnapshot: {
        type: NodeType;
        position: { x: number; y: number };
        data: FlowboardNodeData;
        status: NodeStatus;
      };
      edgesSnapshot: Array<{
        source: string;
        target: string;
        sourceVariantIdx?: number | null;
      }>;
    }
  | {
      kind: "create_node";
      rfId: string;
      title: string;
    };

export interface UndoNotice {
  text: string;
  canUndo: boolean;
}

function debouncePosition(rfId: string, fn: () => void, delay = 150) {
  const existing = positionTimers.get(rfId);
  if (existing !== undefined) clearTimeout(existing);
  positionTimers.set(rfId, setTimeout(() => {
    positionTimers.delete(rfId);
    fn();
  }, delay));
}

// ── Type-to-title lookup ───────────────────────────────────────────────────
const TYPE_TITLE: Record<NodeType, string> = {
  character: "Character",
  image: "Image",
  video: "Video",
  prompt: "Prompt",
  note: "Note",
  visual_asset: "Visual asset",
  Storyboard: "Storyboard",
  merge: "Merge",
};

// ── Persisted active-board id ─────────────────────────────────────────────
// Survives page reloads so refreshing on project #4 doesn't kick the user
// back to project #1. localStorage is fine here — single-user, single-host.
const ACTIVE_BOARD_KEY = "flowboard.activeBoardId";

function loadPersistedBoardId(): number | null {
  try {
    const raw = localStorage.getItem(ACTIVE_BOARD_KEY);
    if (raw === null) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function persistBoardId(id: number | null): void {
  try {
    if (id === null) localStorage.removeItem(ACTIVE_BOARD_KEY);
    else localStorage.setItem(ACTIVE_BOARD_KEY, String(id));
  } catch {
    // Storage disabled / quota exceeded — non-fatal, just lose persistence.
  }
}

// ── Store ──────────────────────────────────────────────────────────────────
interface BoardState {
  boardId: number | null;
  boardName: string;
  // Lightweight summary list rendered by the ProjectSidebar — full node /
  // edge content lives only on the active board to keep memory bounded.
  boards: Board[];
  nodes: FlowNode[];
  edges: Edge[];
  loading: boolean;
  error: string | null;
  undoStack: UndoEntry[];
  undoNotice: UndoNotice | null;

  loadInitialBoard(): Promise<void>;
  refreshBoardState(): Promise<void>;
  refreshBoardList(): Promise<void>;
  syncLiveNodeMedia(): Promise<void>;
  renameBoard(name: string): Promise<void>;
  // Switch the active board: load detail, replace nodes/edges, reset
  // poll-state on the generation store.
  switchBoard(id: number): Promise<void>;
  // Create a new board, switch to it, return id.
  createNewBoard(name: string): Promise<number | null>;
  // Delete a board. If it's the active one, switch to first remaining
  // board (or create a fresh "Untitled" if list ends up empty).
  deleteBoardById(id: number): Promise<void>;

  // Returns the new node's rfId on success, or null if creation failed.
  // Callers that need to wire up an edge immediately (e.g. drop-popover
  // shortcut) need the id back synchronously.
  addNodeOfType(type: NodeType, position: { x: number; y: number }): Promise<string | null>;
  addNodeWithData(
    type: NodeType,
    position: { x: number; y: number },
    data: Record<string, unknown>,
    opts?: { skipHistory?: boolean; status?: NodeStatus },
  ): Promise<string | null>;
  // Spawn a brand-new visual_asset node from a saved Reference. Used by
  // both the panel click-to-spawn path and the canvas drop-to-spawn path.
  // The new node lands with status="done" + mediaId + aiBrief already
  // populated so its thumbnail loads immediately and it can be used as a
  // downstream ref without any extra round-trip.
  addReferenceNode(
    ref: {
      mediaId: string;
      aiBrief?: string | null;
      aspectRatio?: string | null;
      kind: string;
      label: string;
    },
    position: { x: number; y: number },
  ): Promise<string | null>;
  persistNodePosition(rfId: string, position: { x: number; y: number }): Promise<void>;
  deleteNodeByRfId(rfId: string, opts?: { skipHistory?: boolean }): Promise<void>;
  undoLastAction(): Promise<void>;
  setUndoNotice(notice: UndoNotice | null): void;
  addEdgeFromConnection(source: string, target: string): Promise<void>;
  deleteEdgeByRfId(rfId: string): Promise<void>;
  // Spawn an empty sibling node next to `rfId` with the same type and the
  // same upstream edges. Returns the new node's rfId so callers can focus
  // / open the generation dialog on it. Used by ResultViewer's
  // "New variant +" — gives the user a fresh canvas to gen another shot
  // sharing the original's source refs.
  cloneNodeWithUpstream(rfId: string): Promise<string | null>;

  updateNodeData(rfId: string, partial: Partial<FlowboardNodeData>): void;
  /** Merge `partial` into edge.data — used to refresh the local cache
   * after a PATCH /api/edges/{id} so the badge updates without waiting
   * for a full board refresh. */
  updateEdgeData(edgeId: string, partial: Partial<FlowboardEdgeData>): void;
  setNodes(nodes: FlowNode[]): void;
  setEdges(edges: Edge[]): void;
  clearError(): void;
}

export const useBoardStore = create<BoardState>((set, get) => ({
  boardId: null,
  boardName: "",
  boards: [],
  nodes: [],
  edges: [],
  loading: false,
  error: null,
  undoStack: [],
  undoNotice: null,

  setUndoNotice(notice) {
    set({ undoNotice: notice });
  },

  async loadInitialBoard() {
    set({ loading: true, error: null });
    try {
      let boards = await listBoards();
      // Prefer the user's last-active board if it still exists; fall back
      // to the first board in the list. Without this, refresh always
      // snapped back to boards[0] regardless of what was selected before.
      const persistedId = loadPersistedBoardId();
      let board =
        (persistedId !== null && boards.find((b) => b.id === persistedId)) ||
        boards[0];
      if (!board) {
        board = await createBoard("Untitled");
        boards = [board];
      }
      const detail = await getBoard(board.id);

      const nodes: FlowNode[] = detail.nodes.map(nodeFromDto);

      const edges: Edge[] = detail.edges.map(edgeFromDto);

      set({
        boardId: detail.board.id,
        boardName: detail.board.name,
        boards,
        nodes,
        edges,
        loading: false,
        undoStack: [],
        undoNotice: null,
      });
      persistBoardId(detail.board.id);
      // `ensureProjectId` resolves per board but caches globally, so without
      // this a board change would dispatch under the previous board's project.
      // Harmless while every board shares one Flow project, which is all Flow
      // still allows — but it is the same stale-binding bug, and a latent one
      // is still one.
      void import("./generation").then(({ useGenerationStore }) => {
        useGenerationStore.setState({ projectId: null });
      });
      void resumeActiveGenerations(detail.board.id);
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  async refreshBoardList() {
    try {
      const boards = await listBoards();
      set({ boards });
    } catch {
      // non-fatal
    }
  },

  async switchBoard(id) {
    if (id === get().boardId) return;
    set({ loading: true, error: null });
    try {
      const detail = await getBoard(id);
      const nodes: FlowNode[] = detail.nodes.map(nodeFromDto);
      const edges: Edge[] = detail.edges.map(edgeFromDto);
      set({
        boardId: detail.board.id,
        boardName: detail.board.name,
        nodes,
        edges,
        loading: false,
        undoStack: [],
        undoNotice: null,
      });
      persistBoardId(detail.board.id);
      // `ensureProjectId` resolves per board but caches globally, so without
      // this a board change would dispatch under the previous board's project.
      // Harmless while every board shares one Flow project, which is all Flow
      // still allows — but it is the same stale-binding bug, and a latent one
      // is still one.
      void import("./generation").then(({ useGenerationStore }) => {
        useGenerationStore.setState({ projectId: null });
      });
      void resumeActiveGenerations(detail.board.id);
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  async createNewBoard(name) {
    try {
      const board = await createBoard(name || "Untitled");
      // Add to list (front of list so the newly-created project shows up
      // at the top of the sidebar) and switch to it.
      set((s) => ({ boards: [board, ...s.boards] }));
      await get().switchBoard(board.id);
      return board.id;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  async deleteBoardById(id) {
    try {
      await apiDeleteBoard(id);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const remaining = get().boards.filter((b) => b.id !== id);
    set({ boards: remaining });
    // If we just deleted the active board, switch to the first remaining
    // board — or create a fresh "Untitled" if none left.
    if (get().boardId === id) {
      if (remaining.length > 0) {
        await get().switchBoard(remaining[0].id);
      } else {
        try {
          const board = await createBoard("Untitled");
          set({ boards: [board] });
          await get().switchBoard(board.id);
        } catch (err) {
          set({ error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  },

  async refreshBoardState() {
    const { boardId } = get();
    if (boardId === null) return;
    try {
      const detail = await getBoard(boardId);
      const prevById = new Map(get().nodes.map((n) => [n.id, n]));
      const nodes: FlowNode[] = detail.nodes.map((dto) => {
        const next = nodeFromDto(dto);
        const prev = prevById.get(next.id);
        return prev
          ? { ...next, selected: prev.selected, ...(prev.measured ? { measured: prev.measured } : {}) }
          : next;
      });
      const edges: Edge[] = detail.edges.map(edgeFromDto);
      set({ nodes, edges });
      // Same reason as loadInitialBoard / switchBoard: this path replaces the
      // node list wholesale from the DB, so anything in flight comes back
      // rendering as busy with no poll attached. `resumeActiveRequests`
      // skips nodes a live poll already owns, so calling it on every refresh
      // re-attaches only what actually lost its watcher.
      void resumeActiveGenerations(boardId);
    } catch {
      // ignore — leave state alone, next poll will retry
    }
  },

  async syncLiveNodeMedia() {
    const { boardId, nodes: curNodes, edges: curEdges } = get();
    if (boardId === null) return;
    try {
      const detail = await getBoard(boardId);
      if (get().boardId !== boardId) return;
      if (detail.nodes.length !== curNodes.length || detail.edges.length !== curEdges.length) {
        await get().refreshBoardState();
        return;
      }
      const byId = new Map(detail.nodes.map((n) => [String(n.id), n]));
      let dirty = false;
      const nextNodes = curNodes.map((cn) => {
        const dto = byId.get(cn.id);
        if (!dto) return cn;
        const dtoMediaId = dto.data["mediaId"] as string | undefined;
        const dtoMediaIds = dto.data["mediaIds"] as (string | null)[] | undefined;
        const dtoThumbId = dto.data["thumbnailMediaId"] as string | undefined;
        const dtoError = dto.data["error"] as string | undefined;
        if (
          cn.data.status === dto.status &&
          cn.data.mediaId === dtoMediaId &&
          cn.data.thumbnailMediaId === dtoThumbId &&
          JSON.stringify(cn.data.mediaIds ?? null) === JSON.stringify(dtoMediaIds ?? null) &&
          cn.data.error === dtoError
        ) {
          return cn;
        }
        dirty = true;
        return {
          ...cn,
          data: {
            ...cn.data,
            status: dto.status,
            title: (dto.data["title"] as string | undefined) ?? cn.data.title,
            mediaId: dtoMediaId,
            mediaIds: dtoMediaIds,
            thumbnailMediaId: dtoThumbId,
            isMasterNode: (dto.data["isMasterNode"] as boolean | undefined) ?? cn.data.isMasterNode,
            firstLastMode: (dto.data["firstLastMode"] as boolean | undefined) ?? cn.data.firstLastMode,
            renderedAt: (dto.data["renderedAt"] as string | undefined) ?? cn.data.renderedAt,
            mediaProvider: (dto.data["mediaProvider"] as string | undefined) ?? cn.data.mediaProvider,
            error: dtoError,
          },
        };
      });
      if (dirty) {
        set({ nodes: nextNodes });
      }
    } catch {
      // non-fatal
    }
  },

  async renameBoard(name: string) {
    const { boardId } = get();
    if (boardId === null) return;
    try {
      const updated = await apiPatchBoard(boardId, name);
      set((s) => ({
        boardName: updated.name,
        boards: s.boards.map((b) =>
          b.id === boardId ? { ...b, name: updated.name } : b,
        ),
      }));
    } catch {
      // non-fatal; keep local name
    }
  },

  async addNodeOfType(type, position) {
    const defaultAspect = useSettingsStore.getState().defaultAspect;
    const initData: Record<string, unknown> = { title: TYPE_TITLE[type] };
    if (type === "image" || type === "Storyboard" || type === "visual_asset") {
      initData.aspectRatio = defaultAspectEnum("image", defaultAspect);
    } else if (type === "video") {
      initData.aspectRatio = defaultAspectEnum("video", defaultAspect);
    }
    return get().addNodeWithData(type, position, initData);
  },

  async addNodeWithData(type, position, data, opts) {
    const { boardId } = get();
    if (boardId === null) return null;
    const title =
      typeof data.title === "string" && data.title.trim()
        ? data.title.trim()
        : TYPE_TITLE[type];
    const cleanData: Record<string, unknown> = { ...data, title };
    delete cleanData.type;
    delete cleanData.shortId;
    delete cleanData.status;
    try {
      const dto = await createNode({
        board_id: boardId,
        type,
        x: Math.round(position.x),
        y: Math.round(position.y),
        data: cleanData,
      });
      if (opts?.status && opts.status !== dto.status) {
        try {
          await patchNode(dto.id, { status: opts.status });
          dto.status = opts.status;
        } catch {
          // Non-fatal
        }
      }
      const node = nodeFromDto(dto);
      set((s) => ({
        nodes: [...s.nodes, node],
        undoStack: opts?.skipHistory
          ? s.undoStack
          : [...s.undoStack.slice(-(MAX_UNDO_STACK - 1)), { kind: "create_node", rfId: node.id, title }],
      }));
      return node.id;
    } catch (err) {
      console.error("addNodeWithData failed", { type, err });
    }
    return null;
  },

  async addReferenceNode(ref, position) {
    const { boardId } = get();
    if (boardId === null) return null;
    const title = ref.label || "Reference";
    try {
      const dto = await createNode({
        board_id: boardId,
        type: "visual_asset",
        x: Math.round(position.x),
        y: Math.round(position.y),
        data: {
          title,
          mediaId: ref.mediaId,
          aiBrief: ref.aiBrief ?? undefined,
          aspectRatio: ref.aspectRatio ?? undefined,
          status: "done",
          renderedAt: new Date().toISOString(),
        },
      });
      // Mirror addNodeOfType's local-state insertion, but propagate the
      // rich data fields so the visual_asset body renders the thumbnail
      // straight away (instead of falling into the empty-state CTA).
      const node: FlowNode = {
        id: String(dto.id),
        type: dto.type,
        position: { x: dto.x, y: dto.y },
        data: {
          type: dto.type,
          shortId: dto.short_id,
          title: (dto.data["title"] as string | undefined) ?? title,
          status: "done",
          mediaId: ref.mediaId,
          aiBrief: ref.aiBrief ?? undefined,
          aspectRatio: ref.aspectRatio ?? undefined,
          renderedAt: new Date().toISOString(),
        },
      };
      set((s) => ({ nodes: [...s.nodes, node] }));
      return node.id;
    } catch {
      // surface silently for now
    }
    return null;
  },

  async persistNodePosition(rfId, position) {
    debouncePosition(rfId, async () => {
      const dbId = parseInt(rfId, 10);
      if (isNaN(dbId)) return;
      try {
        await patchNode(dbId, { x: Math.round(position.x), y: Math.round(position.y) });
      } catch {
        // ignore persist failures
      }
    });
  },

  async deleteNodeByRfId(rfId, opts) {
    const dbId = parseInt(rfId, 10);
    if (isNaN(dbId) || deletingRfIds.has(rfId)) return;
    deletingRfIds.add(rfId);
    try {
      const state = get();
      const target = state.nodes.find((n) => n.id === rfId);
      const connectedEdges = target
        ? state.edges
            .filter((e) => e.source === rfId || e.target === rfId)
            .map((e) => ({
              source: e.source,
              target: e.target,
              sourceVariantIdx: (e.data?.sourceVariantIdx ?? null) as number | null,
            }))
        : [];
      const wasActive =
        target?.data.status === "queued" || target?.data.status === "running";

      // Cancel any pending debounced patch for this node (it would 404 after delete).
      const pending = positionTimers.get(rfId);
      if (pending !== undefined) {
        clearTimeout(pending);
        positionTimers.delete(rfId);
      }
      // Also cancel any in-flight generation / sidecar poll before deletion.
      try {
        const { useGenerationStore } = await import("./generation");
        useGenerationStore.getState().cancelGeneration(rfId);
        useGenerationStore.getState().cancelSidecarPoll(rfId);
      } catch {
        // Non-fatal
      }
      if (wasActive) {
        try {
          await cancelNodeRequests(dbId);
        } catch {
          // Non-fatal — DELETE also cancels server-side requests
        }
      }

      await deleteNode(dbId);
      set((s) => {
        const nextStack =
          !opts?.skipHistory && target
            ? [
                ...s.undoStack.slice(-(MAX_UNDO_STACK - 1)),
                {
                  kind: "delete_node" as const,
                  oldRfId: rfId,
                  nodeSnapshot: {
                    type: target.data.type,
                    position: { ...target.position },
                    data: { ...target.data },
                    status: (target.data.status ?? "idle") as NodeStatus,
                  },
                  edgesSnapshot: connectedEdges,
                },
              ]
            : s.undoStack;
        return {
          nodes: s.nodes.filter((n) => n.id !== rfId),
          edges: s.edges.filter((e) => e.source !== rfId && e.target !== rfId),
          undoStack: nextStack,
          undoNotice:
            !opts?.skipHistory && target
              ? {
                  text: `已删除「${target.data.title || target.data.type}」${wasActive ? "并终止任务" : ""}`,
                  canUndo: true,
                }
              : s.undoNotice,
        };
      });
    } catch {
      // ignore
    } finally {
      deletingRfIds.delete(rfId);
    }
  },

  async undoLastAction() {
    const stack = get().undoStack;
    if (stack.length === 0) return;
    const entry = stack[stack.length - 1];
    set((s) => ({ undoStack: s.undoStack.slice(0, -1), undoNotice: null }));

    if (entry.kind === "create_node") {
      const existing = get().nodes.find((n) => n.id === entry.rfId);
      if (existing) {
        if (existing.data.status === "queued" || existing.data.status === "running") {
          try {
            const { useGenerationStore } = await import("./generation");
            await useGenerationStore.getState().abortNodeGeneration(entry.rfId);
          } catch {
            // Non-fatal
          }
        }
        await get().deleteNodeByRfId(entry.rfId, { skipHistory: true });
      }
      set({
        undoNotice: { text: `已撤销创建「${entry.title}」`, canUndo: false },
      });
      return;
    }

    if (entry.kind === "delete_node") {
      const { nodeSnapshot, edgesSnapshot, oldRfId } = entry;
      const restoredStatus: NodeStatus =
        nodeSnapshot.data.mediaId ||
        (Array.isArray(nodeSnapshot.data.mediaIds) && nodeSnapshot.data.mediaIds.some(Boolean))
          ? "done"
          : nodeSnapshot.status === "queued" || nodeSnapshot.status === "running"
          ? "idle"
          : nodeSnapshot.status;
      const newRfId = await get().addNodeWithData(
        nodeSnapshot.type,
        nodeSnapshot.position,
        nodeSnapshot.data,
        { skipHistory: true, status: restoredStatus },
      );
      if (!newRfId) return;

      // Remap oldRfId -> newRfId in older undo entries so chained undos stay connected.
      set((s) => ({
        undoStack: s.undoStack.map((u) => {
          if (u.kind === "create_node" && u.rfId === oldRfId) {
            return { ...u, rfId: newRfId };
          }
          if (u.kind === "delete_node") {
            return {
              ...u,
              edgesSnapshot: u.edgesSnapshot.map((ed) => ({
                ...ed,
                source: ed.source === oldRfId ? newRfId : ed.source,
                target: ed.target === oldRfId ? newRfId : ed.target,
              })),
            };
          }
          return u;
        }),
      }));

      const { boardId, nodes: liveNodes } = get();
      if (boardId !== null) {
        const liveIds = new Set(liveNodes.map((n) => n.id));
        const newDbId = parseInt(newRfId, 10);
        for (const ed of edgesSnapshot) {
          const srcIdStr = ed.source === oldRfId ? newRfId : ed.source;
          const tgtIdStr = ed.target === oldRfId ? newRfId : ed.target;
          if (!liveIds.has(srcIdStr) || !liveIds.has(tgtIdStr)) continue;
          const srcNum = ed.source === oldRfId ? newDbId : parseInt(srcIdStr, 10);
          const tgtNum = ed.target === oldRfId ? newDbId : parseInt(tgtIdStr, 10);
          if (isNaN(srcNum) || isNaN(tgtNum)) continue;
          try {
            const eDto = await createEdge({
              board_id: boardId,
              source_id: srcNum,
              target_id: tgtNum,
              source_variant_idx: ed.sourceVariantIdx ?? null,
            });
            set((s) => ({ edges: [...s.edges, edgeFromDto(eDto)] }));
          } catch {
            // Non-fatal
          }
        }
      }
      set({
        undoNotice: {
          text: `已恢复「${nodeSnapshot.data.title || nodeSnapshot.type}」`,
          canUndo: false,
        },
      });
    }
  },

  async addEdgeFromConnection(source, target) {
    const { boardId } = get();
    if (boardId === null) return;
    const sourceId = parseInt(source, 10);
    const targetId = parseInt(target, 10);
    if (isNaN(sourceId) || isNaN(targetId)) return;
    try {
      const dto = await createEdge({ board_id: boardId, source_id: sourceId, target_id: targetId });
      set((s) => ({ edges: [...s.edges, edgeFromDto(dto)] }));
    } catch {
      // ignore
    }
  },

  async cloneNodeWithUpstream(rfId) {
    const { boardId, nodes, edges } = get();
    if (boardId === null) return null;
    const src = nodes.find((n) => n.id === rfId);
    if (!src) return null;

    // Position the clone to the lower-right of the source so it doesn't
    // overlap. Title gets a " (variant)" suffix if not already present so
    // it's easy to tell apart at a glance.
    const offset = { x: 60, y: 60 };
    const newPos = {
      x: Math.round(src.position.x + offset.x),
      y: Math.round(src.position.y + offset.y),
    };
    const baseTitle = src.data.title ?? TYPE_TITLE[src.data.type];
    const newTitle = baseTitle.endsWith("(variant)")
      ? baseTitle
      : `${baseTitle} (variant)`;

    let nodeDto;
    try {
      nodeDto = await createNode({
        board_id: boardId,
        type: src.data.type,
        x: newPos.x,
        y: newPos.y,
        data: { title: newTitle },
      });
    } catch {
      return null;
    }

    const newNode: FlowNode = {
      id: String(nodeDto.id),
      type: nodeDto.type,
      position: { x: nodeDto.x, y: nodeDto.y },
      data: {
        type: nodeDto.type,
        shortId: nodeDto.short_id,
        title: (nodeDto.data["title"] as string | undefined) ?? newTitle,
        status: nodeDto.status,
      },
    };
    set((s) => ({ nodes: [...s.nodes, newNode] }));

    // Replicate upstream edges: every (upstream → src) becomes (upstream → clone).
    const upstreamSourceRfIds = edges
      .filter((e) => e.target === rfId)
      .map((e) => e.source);
    for (const usrc of upstreamSourceRfIds) {
      const sourceId = parseInt(usrc, 10);
      if (isNaN(sourceId)) continue;
      try {
        const eDto = await createEdge({
          board_id: boardId,
          source_id: sourceId,
          target_id: nodeDto.id,
        });
        const newEdge: Edge = {
          id: String(eDto.id),
          source: String(eDto.source_id),
          target: String(eDto.target_id),
        };
        set((s) => ({ edges: [...s.edges, newEdge] }));
      } catch {
        // best-effort — partial edge replication still useful
      }
    }
    return newNode.id;
  },

  async deleteEdgeByRfId(rfId) {
    const dbId = parseInt(rfId, 10);
    if (isNaN(dbId)) return;
    try {
      await deleteEdge(dbId);
      set((s) => ({ edges: s.edges.filter((e) => e.id !== rfId) }));
    } catch {
      // ignore
    }
  },

  updateNodeData: (rfId, partial) =>
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === rfId ? { ...n, data: { ...n.data, ...partial } } : n,
      ),
    })),
  updateEdgeData: (edgeId, partial) =>
    set((s) => ({
      edges: s.edges.map((e) =>
        e.id === edgeId
          ? { ...e, data: { ...(e.data ?? {}), ...partial } }
          : e,
      ),
    })),
  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),
  clearError: () => set({ error: null }),
}));
