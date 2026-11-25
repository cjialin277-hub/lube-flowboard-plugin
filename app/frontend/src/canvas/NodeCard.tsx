import { useEffect, useRef, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useBoardStore, type FlowboardNodeData, type FlowNode } from "../store/board";
import { useGenerationStore } from "../store/generation";
import { aspectKindOf, defaultAspectEnum, useSettingsStore } from "../store/settings";
import { extractTailFrame, mediaUrl, patchEdge, patchNode, uploadImage, uploadImageFromUrl } from "../api/client";
import { requestAutoBrief } from "../api/autoBrief";
import { useReferencesStore } from "../store/references";
import {
  normaliseStoryboardGrid,
  resolveStoryboardLayout,
} from "../lib/storyboardPrompt";
import { displayNodeTitle, useLang } from "../i18n";
import { NodeTypeIcon } from "./NodeTypeIcon";

const STATUS_COLOR: Record<string, string> = {
  idle: "transparent",
  queued: "rgba(245, 179, 1, 0.6)",
  running: "var(--accent)",
  done: "rgba(110, 231, 183, 0.8)",
  error: "#ef4444",
};

function StatusStrip({ status }: { status?: string }) {
  const color = STATUS_COLOR[status ?? "idle"] ?? "transparent";
  const isRunning = status === "running";
  return (
    <div
      className={isRunning ? "status-strip status-strip--running" : "status-strip"}
      style={{ background: color }}
    />
  );
}

const ACCEPT_MIME = "image/png,image/jpeg,image/webp,image/gif";

function BriefHint({ data }: { data: FlowboardNodeData }) {
  const { t } = useLang();
  if (data.autoPromptStatus === "pending") {
    return <p className="brief-hint brief-hint--pending">{t("✨ 正在编写分镜提示词…", "✨ Composing prompt…")}</p>;
  }
  if (data.aiBriefStatus === "pending") {
    return <p className="brief-hint brief-hint--pending">{t("✨ 正在识别画面特征…", "✨ Analyzing…")}</p>;
  }
  if (data.aiBrief) {
    return <p className="brief-hint" title={data.aiBrief}>✨ {data.aiBrief}</p>;
  }
  return null;
}

/**
 * True while the LLM layer is doing work on this node — composing an
 * auto-prompt or describing media for an aiBrief. Used to add a busy
 * treatment + disable Generate so the user can't double-fire.
 */
function isLLMBusy(data: FlowboardNodeData): boolean {
  return (
    data.autoPromptStatus === "pending"
    || data.aiBriefStatus === "pending"
  );
}

function CharacterBody({ rfId, data }: { rfId: string; data: FlowboardNodeData }) {
  const { t } = useLang();
  const mediaId = data.mediaId;
  const isProcessing = data.status === "queued" || data.status === "running";
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function persistMedia(newMediaId: string, aspectRatio?: string) {
    useBoardStore.getState().updateNodeData(rfId, {
      mediaId: newMediaId,
      status: "done",
      aiBrief: undefined,
      aspectRatio,
    });
    const dbId = parseInt(rfId, 10);
    if (!isNaN(dbId)) {
      // Backend merges `data`, so we only need to send the deltas.
      // `null` is the explicit "clear this key" sentinel — undefined
      // gets dropped by JSON.stringify and would leave the stale brief
      // in place after the merge.
      patchNode(dbId, {
        status: "done",
        data: {
          mediaId: newMediaId,
          aiBrief: null,
          aspectRatio,
          renderedAt: new Date().toISOString(),
        },
      }).catch(() => {});
    }
    // Background vision call — fire-and-forget. Sets aiBrief on the node
    // when it returns; failure is silent.
    requestAutoBrief(rfId, newMediaId);
  }

  async function uploadOwn(file: File) {
    setError(null);
    setUploading(true);
    try {
      const projectId = await useGenerationStore.getState().ensureProjectId();
      if (!projectId) {
        setError("no project");
        return;
      }
      const dbId = parseInt(rfId, 10);
      const resp = await uploadImage(file, projectId, isNaN(dbId) ? undefined : dbId);
      persistMedia(resp.media_id, resp.aspect_ratio);
    } catch (err) {
      setError(err instanceof Error ? err.message : "upload failed");
    } finally {
      setUploading(false);
    }
  }

  function onPick() {
    fileInputRef.current?.click();
  }

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) uploadOwn(f);
    e.target.value = "";
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) uploadOwn(f);
  }

  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!dragOver) setDragOver(true);
  }

  function onDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }

  function openGenerate() {
    useGenerationStore.getState().openGenerationDialog(rfId, data.prompt ?? "");
  }

  // Filled state — show the avatar circle. Drag-drop on the avatar replaces it.
  if (mediaId) {
    return (
      <div
        className="node-body node-body--character"
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
      >
        <div
          className={`character-avatar${dragOver ? " character-avatar--over" : ""}${uploading ? " character-avatar--uploading" : ""}`}
          onClick={onPick}
          role="button"
          aria-label="Replace character image"
          tabIndex={0}
        >
          <img
            className="character-avatar__img"
            src={mediaUrl(mediaId)}
            alt={data.title}
          />
          {uploading && <span className="character-drop__overlay">…</span>}
        </div>
        <BriefHint data={data} />
        <button
          type="button"
          className="visual-asset__action"
          onClick={(e) => {
            e.stopPropagation();
            saveTileToLibrary({
              mediaId,
              nodeType: data.type,
              data,
            });
          }}
          title={t("将此角色存入右侧素材库", "Save this character to the library")}
          aria-label={t("存入素材库", "Save to library")}
        >
          {t("★ 收藏", "★ Save")}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_MIME}
          style={{ display: "none" }}
          onChange={onChange}
        />
        {error && <p className="character-drop__error" role="alert">{error}</p>}
      </div>
    );
  }

  // Empty state — compact action row (no oversized placeholder), but the
  // whole body still accepts drag-drop.
  return (
    <div
      className="node-body node-body--character"
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      <div
        className={`character-empty${dragOver ? " character-empty--over" : ""}${isProcessing ? " character-empty--processing" : ""}`}
      >
        {isProcessing ? (
          <div className="node-processing-inline">
            <span className="visual-asset__hint">{t("生成中…", "Generating…")}</span>
            <button
              type="button"
              className="node-cancel-pill"
              onClick={(e) => {
                e.stopPropagation();
                void useGenerationStore.getState().abortNodeGeneration(rfId);
              }}
              title={t("立即撤销生成（若已发往云端可能仍扣费）", "Cancel generation")}
            >
              ■ {t("撤销", "Stop")}
            </button>
          </div>
        ) : dragOver ? (
          <span className="visual-asset__hint">{t("松手导入图片", "Drop image")}</span>
        ) : (
          <>
            <button
              type="button"
              className="visual-asset__action"
              onClick={onPick}
              disabled={uploading}
            >
              {uploading ? t("上传中…", "Uploading…") : t("上传图片", "Upload")}
            </button>
            <button
              type="button"
              className="visual-asset__action"
              onClick={openGenerate}
              disabled={uploading}
            >
              {t("生成角色", "Generate")}
            </button>
          </>
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT_MIME}
        style={{ display: "none" }}
        onChange={onChange}
      />
      {error && <p className="character-drop__error" role="alert">{error}</p>}
    </div>
  );
}

// ── Reference-library save helpers ────────────────────────────────────────
//
// Maps a FlowboardNodeData.type → the `kind` enum stored on a Reference
// row. Storyboard nodes are containers — each saved tile is one *shot*
// of the board, so we use the "storyboard_shot" kind there to leave
// room for shot-specific UX in the library later (e.g. surfacing the
// shot index, or grouping by parent storyboard).
type ReferenceKind = "image" | "character" | "visual_asset" | "storyboard_shot";

function referenceKindFor(nodeType: string): ReferenceKind {
  if (nodeType === "Storyboard") return "storyboard_shot";
  if (nodeType === "character") return "character";
  if (nodeType === "visual_asset") return "visual_asset";
  return "image";
}

/** Fire-and-forget save of a tile's media into the reference library.
 * Errors surface via useReferencesStore.error; UI doesn't need to
 * await for the save to succeed before letting the user keep working. */
function saveTileToLibrary(opts: {
  mediaId: string;
  nodeType: string;
  data: FlowboardNodeData;
}) {
  const { mediaId, nodeType, data } = opts;
  const label =
    typeof data.aiBrief === "string" && data.aiBrief.trim().length > 0
      ? data.aiBrief.slice(0, 80)
      : `#${data.shortId}`;
  void useReferencesStore.getState().save({
    media_id: mediaId,
    kind: referenceKindFor(nodeType),
    ai_brief: typeof data.aiBrief === "string" ? data.aiBrief : null,
    aspect_ratio: typeof data.aspectRatio === "string" ? data.aspectRatio : null,
    label,
    source_board_id: useBoardStore.getState().boardId ?? null,
    source_node_short_id:
      typeof data.shortId === "string" ? data.shortId : null,
  });
}

const MAX_IMG_RETRIES = 5;

function tileCountFor(data: FlowboardNodeData): number {
  const fromVariants = data.variantCount;
  const fromMedia = data.mediaIds?.length;
  const n = fromVariants && fromVariants > 0 ? fromVariants : fromMedia ?? 1;
  return Math.max(1, Math.min(n, 4));
}

function ImageTile({
  rfId,
  mediaId,
  isProcessing,
  alt,
  onClick,
  onUseAsRef,
  onSaveToLibrary,
}: {
  rfId: string;
  mediaId: string | undefined;
  isProcessing: boolean;
  alt: string;
  onClick?: () => void;
  /** When provided, render an overlay button on hover that pins this
   * variant to a downstream edge and triggers Generate on the target.
   * The parent only sets this when the node has multi-variant output
   * AND has a downstream image/video target — keeps the affordance
   * scoped to cases where it actually does something. */
  onUseAsRef?: () => void;
  /** When provided, render a "★" overlay (top-right corner, opposite
   * the "Use →" affordance) that snapshots this tile's media + aiBrief
   * into the cross-board reference library. Parents only pass this when
   * the tile has a real mediaId — saving a placeholder makes no sense. */
  onSaveToLibrary?: () => void;
}) {
  const { t } = useLang();
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLoaded(false);
    setAttempt(0);
    return () => {
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [mediaId, rfId]);

  if (!mediaId) {
    return (
      <div
        className={`thumbnail-tile${isProcessing ? " thumbnail-tile--processing" : ""}`}
        aria-hidden="true"
      >
        <span className="thumbnail-tile__icon">▣</span>
      </div>
    );
  }

  const givenUp = attempt >= MAX_IMG_RETRIES;
  const src = attempt > 0 ? `${mediaUrl(mediaId)}?retry=${attempt}` : mediaUrl(mediaId);
  const cls =
    `thumbnail-tile thumbnail-tile--filled` +
    (onClick ? " thumbnail-tile--clickable" : "");

  return (
    <div
      className={cls}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={onClick ? `Open variant ${alt}` : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (!onClick) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {!loaded && (
        <div className="thumbnail-tile__placeholder" aria-hidden="true" />
      )}
      {!givenUp && (
        <img
          key={attempt}
          className="thumbnail-tile__img"
          src={src}
          alt={alt}
          style={loaded ? undefined : { display: "none" }}
          onLoad={() => setLoaded(true)}
          onError={() => {
            retryTimerRef.current = setTimeout(() => {
              setAttempt((a) => a + 1);
            }, 2000);
          }}
        />
      )}
      {onUseAsRef && (
        // Overlay action — visible on hover via CSS. Stops propagation
        // so clicking the chip doesn't also trigger the tile's
        // openResultViewer. Title doubles as accessible label.
        <button
          type="button"
          className="thumbnail-tile__use-btn"
          onClick={(e) => {
            e.stopPropagation();
            onUseAsRef();
          }}
          title={t("选用此景别变体喂给下游节点并立即生成", "Use this variant as the reference for a downstream node")}
          aria-label={t("选用此变体", "Use this variant as reference")}
        >
          {t("选用 →", "Use →")}
        </button>
      )}
      {onSaveToLibrary && (
        // ★ overlay — top-right corner, opposite the "Use →" chip in
        // the bottom-right. Fire-and-forget save into the cross-board
        // reference library. Same stopPropagation pattern so clicking
        // the star doesn't also open the result viewer.
        <button
          type="button"
          className="thumbnail-tile__save-btn"
          onClick={(e) => {
            e.stopPropagation();
            onSaveToLibrary();
          }}
          title="Save this variant to the library"
          aria-label="Save to library"
        >
          ★
        </button>
      )}
    </div>
  );
}

// ── Variant-click → bind upstream variant to a downstream edge ───────────
//
// Workflow: user clicks "Use →" on a specific variant tile of an
// upstream multi-variant node. We find the downstream image/video
// targets connected to it, pin the chosen variant index on the right
// edge (PATCH /api/edges/{id}), refresh the local edge.data so the
// `v{N+1}` chip surfaces immediately, and then dispatch Generate on
// the target. One click → one pinned ref → one Flow API call.
//
// Multi-target case: when the upstream has 2+ outgoing edges to gen
// targets, we surface a small picker so the user disambiguates which
// downstream this variant should feed.

interface VariantTarget {
  edgeId: string;
  targetRfId: string;
  title: string;
  kind: "image" | "video";
  hasPrompt: boolean;
}

interface VariantPickerState {
  variantIdx: number;
  targets: VariantTarget[];
}

function collectGenTargets(srcRfId: string): VariantTarget[] {
  const { nodes, edges } = useBoardStore.getState();
  const out: VariantTarget[] = [];
  for (const e of edges) {
    if (e.source !== srcRfId) continue;
    const t = nodes.find((n) => n.id === e.target);
    if (!t) continue;
    if (t.data.type !== "image" && t.data.type !== "video") continue;
    out.push({
      edgeId: e.id,
      targetRfId: t.id,
      title: t.data.title || `#${t.data.shortId}`,
      kind: t.data.type as "image" | "video",
      hasPrompt: typeof t.data.prompt === "string" && t.data.prompt.trim().length > 0,
    });
  }
  return out;
}

async function applyVariantToTarget(variantIdx: number, target: VariantTarget) {
  const edgeDbId = parseInt(target.edgeId, 10);
  if (!isNaN(edgeDbId)) {
    try {
      const updated = await patchEdge(edgeDbId, {
        source_variant_idx: variantIdx,
      });
      useBoardStore.getState().updateEdgeData(target.edgeId, {
        sourceVariantIdx: updated.source_variant_idx,
      });
    } catch (err) {
      useGenerationStore.setState({
        error: `Couldn't pin variant: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
  }
  // If the target doesn't have a prompt yet, we open the GenerationDialog
  // instead of dispatching blind — the dialog gives the user the
  // auto-prompt path or a place to type. The pin we just persisted will
  // apply to whichever Generate is fired from the dialog.
  const targetNode = useBoardStore
    .getState()
    .nodes.find((n) => n.id === target.targetRfId);
  if (!targetNode) return;
  const prompt = (targetNode.data.prompt ?? "").trim();
  if (!prompt) {
    useGenerationStore.getState().openGenerationDialog(target.targetRfId, "");
    return;
  }
  await useGenerationStore.getState().dispatchGeneration(target.targetRfId, {
    prompt,
    kind: target.kind,
    aspectRatio: targetNode.data.aspectRatio,
    variantCount: targetNode.data.variantCount,
  });
}

function VariantPicker({
  state,
  onPick,
  onCancel,
}: {
  state: VariantPickerState;
  onPick(target: VariantTarget): void;
  onCancel(): void;
}) {
  return (
    <div className="variant-picker" role="dialog" aria-label="Pick downstream target">
      <div className="variant-picker__heading">
        Use variant v{state.variantIdx + 1} for:
      </div>
      <ul className="variant-picker__list">
        {state.targets.map((t) => (
          <li key={t.edgeId}>
            <button
              type="button"
              className="variant-picker__btn"
              onClick={() => onPick(t)}
            >
              {t.title}
              <span className="variant-picker__kind">
                {t.kind === "video" ? "video" : "image"}
                {!t.hasPrompt ? " · empty" : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="variant-picker__cancel"
        onClick={onCancel}
      >
        Cancel
      </button>
    </div>
  );
}

function ImageBody({ rfId, data }: { rfId: string; data: FlowboardNodeData }) {
  const { t } = useLang();
  const tileCount = tileCountFor(data);
  const ids = data.mediaIds ?? (data.mediaId ? [data.mediaId] : []);
  const hasMedia = ids.length > 0;
  const isProcessing = data.status === "queued" || data.status === "running";

  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // Variant-picker state for the multi-downstream "Use →" flow. MUST be
  // declared above the empty-state early-return below — Rules of Hooks
  // require the same call order on every render, and the empty/filled
  // branches change which JSX renders but not which hooks run.
  const [picker, setPicker] = useState<VariantPickerState | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function persistMedia(newMediaId: string, aspectRatio?: string) {
    useBoardStore.getState().updateNodeData(rfId, {
      mediaId: newMediaId,
      mediaIds: undefined,
      variantCount: 1,
      status: "done",
      aiBrief: undefined,
      aspectRatio,
    });
    const dbId = parseInt(rfId, 10);
    if (!isNaN(dbId)) {
      // Backend merges `data`. `null` is the explicit "delete this key"
      // sentinel — used here to drop stale variant arrays + cached brief
      // when the user replaces a generated set with a single uploaded image.
      patchNode(dbId, {
        status: "done",
        data: {
          mediaId: newMediaId,
          mediaIds: null,
          variantCount: 1,
          aiBrief: null,
          aspectRatio,
          renderedAt: new Date().toISOString(),
        },
      }).catch(() => {});
    }
    requestAutoBrief(rfId, newMediaId);
  }

  async function uploadOwn(file: File) {
    setError(null);
    setUploading(true);
    try {
      const projectId = await useGenerationStore.getState().ensureProjectId();
      if (!projectId) {
        setError("no project");
        return;
      }
      const dbId = parseInt(rfId, 10);
      const resp = await uploadImage(file, projectId, isNaN(dbId) ? undefined : dbId);
      persistMedia(resp.media_id, resp.aspect_ratio);
    } catch (err) {
      setError(err instanceof Error ? err.message : "upload failed");
    } finally {
      setUploading(false);
    }
  }

  function onPick() {
    fileInputRef.current?.click();
  }

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) uploadOwn(f);
    e.target.value = "";
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) uploadOwn(f);
  }

  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!dragOver) setDragOver(true);
  }

  function onDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }

  function openGenerate() {
    useGenerationStore.getState().openGenerationDialog(rfId, data.prompt ?? "");
  }

  const hiddenFileInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept={ACCEPT_MIME}
      style={{ display: "none" }}
      onChange={onChange}
    />
  );

  // Empty state — same action-bar UX as character/visual_asset so users
  // can drop a reference image directly onto an image node instead of
  // having to wire one up via a separate visual_asset node.
  if (!hasMedia && !isProcessing) {
    return (
      <div
        className="node-body node-body--image"
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
      >
        <div className={`character-empty${dragOver ? " character-empty--over" : ""}`}>
          {dragOver ? (
            <span className="visual-asset__hint">{t("松手导入图片", "Drop image")}</span>
          ) : (
            <>
              <button
                type="button"
                className="visual-asset__action"
                onClick={onPick}
                disabled={uploading}
              >
                {uploading ? t("上传中…", "Uploading…") : t("上传图片", "Upload")}
              </button>
              <button
                type="button"
                className="visual-asset__action"
                onClick={openGenerate}
                disabled={uploading}
              >
                {t("生成画面", "Generate")}
              </button>
            </>
          )}
        </div>
        <BriefHint data={data} />
        {hiddenFileInput}
        {error && <p className="character-drop__error" role="alert">{error}</p>}
      </div>
    );
  }

  // Variant-click flow: when this node is multi-variant AND has a
  // downstream image/video target, each tile gets a "Use →" overlay
  // button. Clicking it pins this variant on the appropriate edge and
  // dispatches Generate on the target. See `applyVariantToTarget` above.
  const isMultiVariant = ids.length >= 2;

  function onUseVariantClick(variantIdx: number) {
    const targets = collectGenTargets(rfId);
    if (targets.length === 0) {
      useGenerationStore.setState({
        error: "Connect this image to a downstream image/video target first.",
      });
      return;
    }
    if (targets.length === 1) {
      void applyVariantToTarget(variantIdx, targets[0]);
      return;
    }
    setPicker({ variantIdx, targets });
  }

  const tiles: JSX.Element[] = [];
  for (let i = 0; i < tileCount; i++) {
    const rawMid = ids[i];
    const mid = typeof rawMid === "string" && rawMid ? rawMid : undefined;
    // Click a tile → open viewer at that variant. The "Use →" overlay
    // (when present) is a separate action handled by onUseAsRef.
    const onClick = mid
      ? () => useGenerationStore.getState().openResultViewer(rfId, i)
      : undefined;
    tiles.push(
      <ImageTile
        key={i}
        rfId={rfId}
        mediaId={mid}
        isProcessing={isProcessing && !mid}
        alt={data.title}
        onClick={onClick}
        onUseAsRef={
          isMultiVariant && mid && !isProcessing
            ? () => onUseVariantClick(i)
            : undefined
        }
        onSaveToLibrary={
          mid
            ? () =>
                saveTileToLibrary({
                  mediaId: mid,
                  nodeType: data.type,
                  data,
                })
            : undefined
        }
      />
    );
  }

  return (
    <div
      className={`node-body node-body--image${dragOver ? " node-body--image--over" : ""}`}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      <div className={`thumbnail-grid thumbnail-grid--${tileCount}`}>
        {tiles}
      </div>
      {picker && (
        <VariantPicker
          state={picker}
          onPick={(target) => {
            void applyVariantToTarget(picker.variantIdx, target);
            setPicker(null);
          }}
          onCancel={() => setPicker(null)}
        />
      )}
      {isProcessing && (
        <div className="node-processing-bar">
          <span className="visual-asset__hint">{t("画面生成中…", "Generating image…")}</span>
          <button
            type="button"
            className="node-cancel-pill"
            onClick={(e) => {
              e.stopPropagation();
              void useGenerationStore.getState().abortNodeGeneration(rfId);
            }}
            title={t("立即停止并撤销本次生成（若已发往云端可能仍扣费）", "Stop and cancel generation")}
          >
            ■ {t("撤销生成", "Cancel")}
          </button>
        </div>
      )}
      <BriefHint data={data} />
      {hiddenFileInput}
      {error && <p className="character-drop__error" role="alert">{error}</p>}
    </div>
  );
}

const MAX_VIDEO_RETRIES = 5;

function VideoTile({
  mediaId,
  posterMediaId,
  isProcessing,
  isError,
  slotError,
  alt,
  onClick,
}: {
  mediaId: string | undefined;
  // Upstream image's mediaId — used as the static poster so the tile
  // shows the source-image framing (subject centered, just like the
  // image-tile preview) instead of the video's frame-0 which often
  // catches a setup beat (ceiling, empty room) before the subject is
  // composed in.
  posterMediaId?: string | undefined;
  isProcessing: boolean;
  isError: boolean;
  // Per-slot error code (e.g. "PUBLIC_ERROR_UNSAFE_GENERATION") when
  // this specific variant got blocked by Veo's safety classifier. Only
  // surfaced for the partial-batch case so the tile can render a
  // distinctive ⚠ + tooltip instead of the generic empty placeholder.
  slotError?: string | null;
  alt: string;
  onClick?: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLoaded(false);
    setAttempt(0);
    return () => {
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [mediaId]);

  const blockedTitle = slotError
    ? `Variant blocked: ${slotError} — click for details`
    : undefined;

  const placeholder = (
    <div
      className={`video-placeholder${isProcessing ? " video-placeholder--processing" : ""}${isError ? " video-placeholder--error" : ""}${slotError ? " video-placeholder--blocked" : ""}`}
      aria-hidden="true"
      title={blockedTitle}
    >
      {slotError ? (
        <>
          <span className="video-blocked-icon">⚠</span>
          <span className="video-blocked-label">Blocked</span>
        </>
      ) : (
        <>
          <span className="video-play">▶</span>
          <span className="video-duration">0:00</span>
        </>
      )}
    </div>
  );

  if (!mediaId) {
    // Pending / failed tile — just the placeholder. When `slotError` is
    // set the placeholder swaps to the warning treatment above. We
    // still attach onClick so the user can click through to the
    // detail viewer to read the full error.
    const cls = `video-tile${slotError ? " video-tile--blocked" : ""}${onClick ? " video-tile--clickable" : ""}`;
    return (
      <div
        className={cls}
        role={onClick ? "button" : undefined}
        tabIndex={onClick ? 0 : undefined}
        aria-label={blockedTitle ?? (onClick ? `Open variant ${alt}` : undefined)}
        title={blockedTitle}
        onClick={onClick}
        onKeyDown={(e) => {
          if (!onClick) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick();
          }
        }}
      >
        {placeholder}
      </div>
    );
  }

  const givenUp = attempt >= MAX_VIDEO_RETRIES;
  const src = attempt > 0 ? `${mediaUrl(mediaId)}?retry=${attempt}` : mediaUrl(mediaId);
  const cls =
    `video-tile video-tile--filled` +
    (onClick ? " video-tile--clickable" : "");

  return (
    <div
      className={cls}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={onClick ? `Open variant ${alt}` : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (!onClick) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {!loaded && placeholder}
      {!givenUp && posterMediaId ? (
        // Thumbnail = static poster image (the upstream i2v source).
        // Mounting a <video> here decodes frame 0 in Chrome and
        // overrides the poster attribute, which is what made every
        // tile display the video's setup beat (often empty ceiling)
        // instead of the subject-centered framing. The full video
        // with controls plays in the ResultViewer modal — clicking
        // a tile already routes there.
        <img
          key={`poster-${attempt}`}
          className="video-tile__poster"
          src={mediaUrl(posterMediaId)}
          alt={alt}
          onLoad={() => setLoaded(true)}
          onError={() => {
            retryTimerRef.current = setTimeout(() => {
              setAttempt((a) => a + 1);
            }, 2000);
          }}
        />
      ) : !givenUp ? (
        // Fallback: no static poster image available (orphan video node).
        // Seek to 0.5s with `preload="metadata"` so Chrome renders an actual frame.
        <video
          key={attempt}
          className="node-card__thumbnail"
          data-kind="video"
          src={`${src}#t=0.5`}
          preload="metadata"
          muted
          playsInline
          aria-label={alt}
          style={loaded ? undefined : { display: "none" }}
          onLoadedMetadata={() => setLoaded(true)}
          onLoadedData={() => setLoaded(true)}
          onError={() => {
            retryTimerRef.current = setTimeout(() => {
              setAttempt((a) => a + 1);
            }, 2000);
          }}
        />
      ) : null}
      {(posterMediaId || loaded) && (
        <span className="video-tile__play-badge" aria-hidden="true">▶</span>
      )}
    </div>
  );
}

const IMAGE_POSTER_TYPES = new Set(["image", "character", "visual_asset", "Storyboard"]);

function resolveVideoPosterIds(
  rfId: string,
  data: FlowboardNodeData,
  nodes: FlowNode[],
  edges: ReturnType<typeof useBoardStore.getState>["edges"],
): (string | null)[] {
  if (typeof data.thumbnailMediaId === "string" && data.thumbnailMediaId) {
    return [data.thumbnailMediaId];
  }
  const incoming = edges.filter((e) => e.target === rfId);
  const directImages = incoming
    .map((e) => nodes.find((n) => n.id === e.source))
    .filter((n): n is FlowNode => Boolean(n && IMAGE_POSTER_TYPES.has(n.data.type)));

  if (directImages.length > 0) {
    const primary = directImages[0];
    return (
      primary.data.mediaIds ??
      (primary.data.mediaId ? [primary.data.mediaId] : [])
    );
  }

  // Multi-video master summary node: walk 1 hop further upstream from attached video nodes
  const upstreamVideos = incoming
    .map((e) => nodes.find((n) => n.id === e.source))
    .filter((n): n is FlowNode => Boolean(n && n.data.type === "video"));

  if (upstreamVideos.length > 0) {
    const fallbackPosters: string[] = [];
    for (const uv of upstreamVideos) {
      if (typeof uv.data.thumbnailMediaId === "string" && uv.data.thumbnailMediaId) {
        fallbackPosters.push(uv.data.thumbnailMediaId);
        continue;
      }
      const grandEdge = edges.find((e) => e.target === uv.id);
      const grandSrc = grandEdge ? nodes.find((n) => n.id === grandEdge.source) : undefined;
      if (grandSrc && IMAGE_POSTER_TYPES.has(grandSrc.data.type)) {
        const gMid =
          grandSrc.data.mediaId ??
          (Array.isArray(grandSrc.data.mediaIds)
            ? grandSrc.data.mediaIds.find((m): m is string => typeof m === "string" && m.length > 0)
            : undefined);
        if (gMid) fallbackPosters.push(gMid);
      }
    }
    if (fallbackPosters.length > 0) {
      // Pick the climactic/latest keyframe so the master summary card looks iconic.
      return [fallbackPosters[fallbackPosters.length - 1]];
    }
  }
  return [];
}

function VideoBody({ rfId, data }: { rfId: string; data: FlowboardNodeData }) {
  const { t } = useLang();
  const tileCount = tileCountFor(data);
  const ids = data.mediaIds ?? (data.mediaId ? [data.mediaId] : []);
  const isProcessing = data.status === "queued" || data.status === "running";
  const isError = data.status === "error";
  // Partial-batch case: status="done" + an error string means some
  // variants succeeded and others got blocked (filter / timeout).
  // Slot-level signal: `mediaIds[i] === null` is a positional
  // placeholder for a blocked variant — render the tile as filtered
  // rather than empty/processing.
  const isPartial = data.status === "done" && Boolean(data.error);

  // Reactively subscribe to board nodes/edges so multi-video master nodes
  // resolve upstream keyframe posters reliably even after reload.
  const nodes = useBoardStore((s) => s.nodes);
  const edges = useBoardStore((s) => s.edges);
  const posterIds = resolveVideoPosterIds(rfId, data, nodes, edges);

  const tiles: JSX.Element[] = [];
  for (let i = 0; i < tileCount; i++) {
    const rawMid = ids[i];
    const mid = typeof rawMid === "string" && rawMid ? rawMid : undefined;
    const slotError = data.slotErrors?.[i] ?? null;
    const slotBlocked = isPartial && rawMid === null;
    // Even blocked tiles get a click handler so the user can open the
    // detail viewer and read the full filter reason — without it the
    // tile is dead and the user has no way to understand why it's
    // empty.
    const onClick =
      mid || slotBlocked
        ? () => useGenerationStore.getState().openResultViewer(rfId, i)
        : undefined;
    // Pick the i-th source variant if available; fall back to the
    // first non-null source for single-source i2v where every video
    // shares it.
    const rawPoster = posterIds[i] ?? posterIds.find((p) => Boolean(p)) ?? null;
    const poster = typeof rawPoster === "string" ? rawPoster : undefined;
    tiles.push(
      <VideoTile
        key={i}
        mediaId={mid}
        posterMediaId={poster}
        isProcessing={isProcessing && !mid}
        isError={(isError && !mid) || slotBlocked}
        slotError={slotError}
        alt={data.title}
        onClick={onClick}
      />,
    );
  }

  return (
    <div className="node-body node-body--video">
      <div className={`video-grid video-grid--${tileCount}`}>
        {tiles}
      </div>
      {isProcessing && (
        <div className="node-processing-bar">
          <span className="visual-asset__hint">{t("视频渲染中…", "Rendering video…")}</span>
          <button
            type="button"
            className="node-cancel-pill"
            onClick={(e) => {
              e.stopPropagation();
              void useGenerationStore.getState().abortNodeGeneration(rfId);
            }}
            title={t("立即停止并撤销本次视频任务（若已发往 Flow 云端可能仍扣费）", "Stop and cancel video generation")}
          >
            ■ {t("撤销生成", "Cancel")}
          </button>
        </div>
      )}
      {(isError || isPartial) && data.error && (
        <p
          className={`node-error${isPartial ? " node-error--partial" : ""}`}
          role={isError ? "alert" : "status"}
        >
          {data.error}
        </p>
      )}
    </div>
  );
}

function VisualAssetBody({ rfId, data }: { rfId: string; data: FlowboardNodeData }) {
  const { t } = useLang();
  const mediaId = data.mediaId;
  const isProcessing = data.status === "queued" || data.status === "running";
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refineOpen, setRefineOpen] = useState(false);
  const [refinePrompt, setRefinePrompt] = useState("");
  const [refRefreshKey, setRefRefreshKey] = useState(0);
  const [refMediaId, setRefMediaId] = useState<string | null>(null);
  const [linkMode, setLinkMode] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const refInputRef = useRef<HTMLInputElement>(null);

  function persistMedia(newMediaId: string, aspectRatio?: string) {
    useBoardStore.getState().updateNodeData(rfId, {
      mediaId: newMediaId,
      mediaIds: [newMediaId],
      variantCount: 1,
      status: "done",
      aiBrief: undefined,
      aspectRatio,
    });
    const dbId = parseInt(rfId, 10);
    if (!isNaN(dbId)) {
      // Backend merges `data`, so we only need to send the deltas.
      // `null` clears aiBrief explicitly (undefined would be dropped
      // by JSON.stringify and leave the stale brief in place).
      patchNode(dbId, {
        status: "done",
        data: {
          mediaId: newMediaId,
          mediaIds: [newMediaId],
          variantCount: 1,
          aiBrief: null,
          aspectRatio,
          renderedAt: new Date().toISOString(),
        },
      }).catch(() => {});
    }
    requestAutoBrief(rfId, newMediaId);
  }

  async function uploadOwn(file: File) {
    setError(null);
    setUploading(true);
    try {
      const projectId = await useGenerationStore.getState().ensureProjectId();
      if (!projectId) {
        setError("no project");
        return;
      }
      const dbId = parseInt(rfId, 10);
      const resp = await uploadImage(file, projectId, isNaN(dbId) ? undefined : dbId);
      persistMedia(resp.media_id, resp.aspect_ratio);
    } catch (err) {
      setError(err instanceof Error ? err.message : "upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function uploadFromLink(url: string) {
    const trimmed = url.trim();
    if (!trimmed) return;
    setError(null);
    setUploading(true);
    try {
      const projectId = await useGenerationStore.getState().ensureProjectId();
      if (!projectId) {
        setError("no project");
        return;
      }
      const dbId = parseInt(rfId, 10);
      const resp = await uploadImageFromUrl(
        trimmed,
        projectId,
        isNaN(dbId) ? undefined : dbId,
      );
      persistMedia(resp.media_id, resp.aspect_ratio);
      setLinkMode(false);
      setLinkValue("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "link upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function uploadRef(file: File) {
    setError(null);
    try {
      const projectId = await useGenerationStore.getState().ensureProjectId();
      if (!projectId) {
        setError("no project");
        return;
      }
      const resp = await uploadImage(file, projectId);
      setRefMediaId(resp.media_id);
      setRefRefreshKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "ref upload failed");
    }
  }

  async function submitRefine() {
    if (!mediaId) return;
    if (!refinePrompt.trim()) return;
    await useGenerationStore.getState().refineImage(rfId, {
      prompt: refinePrompt.trim(),
      refMediaIds: refMediaId ? [refMediaId] : [],
    });
    setRefineOpen(false);
    setRefinePrompt("");
    setRefMediaId(null);
  }

  function openGenerate() {
    useGenerationStore.getState().openGenerationDialog(rfId, data.prompt ?? "");
  }

  if (!mediaId) {
    return (
      <div className="node-body node-body--visual-asset">
        <div
          className={`visual-asset__empty${isProcessing ? " visual-asset__empty--processing" : ""}`}
        >
          {isProcessing ? (
            <div className="node-processing-inline">
              <span className="visual-asset__hint">{t("生成中…", "Generating…")}</span>
              <button
                type="button"
                className="node-cancel-pill"
                onClick={(e) => {
                  e.stopPropagation();
                  void useGenerationStore.getState().abortNodeGeneration(rfId);
                }}
              >
                ■ {t("撤销", "Stop")}
              </button>
            </div>
          ) : linkMode ? (
            <div className="visual-asset__link-row">
              <input
                type="url"
                className="visual-asset__link-input"
                placeholder="https://… (png/jpg/webp)"
                value={linkValue}
                onChange={(e) => setLinkValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") uploadFromLink(linkValue);
                  if (e.key === "Escape") {
                    setLinkMode(false);
                    setLinkValue("");
                    setError(null);
                  }
                }}
                disabled={uploading}
                autoFocus
              />
              <button
                type="button"
                className="visual-asset__action"
                onClick={() => uploadFromLink(linkValue)}
                disabled={uploading || !linkValue.trim()}
              >
                {uploading ? "Fetching…" : "Save"}
              </button>
              <button
                type="button"
                className="visual-asset__action"
                onClick={() => {
                  setLinkMode(false);
                  setLinkValue("");
                  setError(null);
                }}
                disabled={uploading}
              >
                ×
              </button>
            </div>
          ) : (
            <>
              <button
                type="button"
                className="visual-asset__action"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
              >
                {uploading ? t("上传中…", "Uploading…") : t("上传图片", "Upload")}
              </button>
              <button
                type="button"
                className="visual-asset__action"
                onClick={() => {
                  setError(null);
                  setLinkMode(true);
                }}
                disabled={uploading}
              >
                {t("粘贴链接", "Add link")}
              </button>
              <button
                type="button"
                className="visual-asset__action"
                onClick={openGenerate}
                disabled={uploading}
              >
                {t("AI 生成", "Generate")}
              </button>
            </>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) uploadOwn(f);
            e.target.value = "";
          }}
        />
        {error && <p className="visual-asset__error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="node-body node-body--visual-asset node-body--visual-asset-with-media">
      <div className="visual-asset__media">
        <img
          className="visual-asset__image"
          src={mediaUrl(mediaId)}
          alt={data.title}
        />
        {!isProcessing && (
          <button
            type="button"
            className="visual-asset__refine-btn"
            onClick={() => setRefineOpen((o) => !o)}
            aria-label="Refine image"
          >
            {t("局部精修", "Refine")}
          </button>
        )}
      </div>
      <BriefHint data={data} />
      {!isProcessing && (
        <button
          type="button"
          className="visual-asset__action"
          onClick={(e) => {
            e.stopPropagation();
            saveTileToLibrary({
              mediaId,
              nodeType: data.type,
              data,
            });
          }}
          title={t("存入右侧跨画布素材库", "Save this asset to the library")}
          aria-label={t("存入素材库", "Save to library")}
        >
          {t("★ 收藏", "★ Save")}
        </button>
      )}
      {refineOpen && (
        <div className="visual-asset__refine-panel" role="region" aria-label="Refine">
          <textarea
            className="visual-asset__refine-textarea"
            placeholder="Describe the change…"
            rows={2}
            value={refinePrompt}
            onChange={(e) => setRefinePrompt(e.target.value)}
          />
          <div className="visual-asset__refine-actions">
            <button
              type="button"
              className="visual-asset__refine-ref"
              onClick={() => refInputRef.current?.click()}
            >
              {refMediaId ? `Ref ✓ (${refRefreshKey})` : "Add ref"}
            </button>
            <button
              type="button"
              className="visual-asset__refine-submit"
              disabled={!refinePrompt.trim()}
              onClick={submitRefine}
            >
              Refine →
            </button>
          </div>
          <input
            ref={refInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadRef(f);
              e.target.value = "";
            }}
          />
        </div>
      )}
      {error && <p className="visual-asset__error">{error}</p>}
    </div>
  );
}

// Shared editable body for prompt + note nodes. Both store free-form text
// in `data.prompt`; only display markup differs. Double-click swaps to a
// textarea; blur or Cmd/Ctrl+Enter saves; Esc cancels.
function EditableTextBody({
  rfId,
  data,
  variant,
}: {
  rfId: string;
  data: FlowboardNodeData;
  variant: "prompt" | "note";
}) {
  const { t } = useLang();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.prompt ?? "");
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(data.prompt ?? "");
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
        }
      });
    }
  }, [editing]);

  function save() {
    const next = draft;
    if (next !== (data.prompt ?? "")) {
      useBoardStore.getState().updateNodeData(rfId, { prompt: next });
      const dbId = parseInt(rfId, 10);
      if (!isNaN(dbId)) {
        // Backend merges `data`, so only the prompt delta needs shipping.
        patchNode(dbId, { data: { prompt: next } }).catch(() => {});
      }
    }
    setEditing(false);
  }

  if (editing) {
    return (
      <div className={`node-body node-body--${variant} node-body--${variant}-edit`}>
        <textarea
          ref={taRef}
          className={`${variant}-editor`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              save();
            }
          }}
          placeholder={
            variant === "prompt"
              ? t("输入光影/色调/导演风格指令（如：冷调雨夜悬疑感、35mm胶片颗粒），连线至下游图片或视频节点自动生效。", "Style direction (e.g. cinematic warm tone, rain-soaked noir mood). Connect into image/video.")
              : t("输入场记备注、待办或分镜标签…", "Note, TODO, label…")
          }
        />
      </div>
    );
  }

  const text = data.prompt ?? "";
  const placeholder =
    variant === "prompt"
      ? t("双击输入导演风格指令…", "Double-click to add direction…")
      : t("双击输入场记备注…", "Double-click to add note…");

  return (
    <div
      className={`node-body node-body--${variant}`}
      onDoubleClick={() => setEditing(true)}
      title="Double-click to edit"
    >
      {variant === "prompt" ? (
        <pre className="prompt-text">{text || placeholder}</pre>
      ) : (
        <p className="note-text">{text || placeholder}</p>
      )}
    </div>
  );
}

// ── Storyboard ────────────────────────────────────────────────────────────
// Storyboard is a thin image-node wrapper. It dispatches via the standard
// `gen_image` handler with a locked prompt template that asks Flow to render
// the user's topic as a single composite NxN grid (see
// frontend/src/lib/storyboardPrompt.ts). Rendering reuses `ImageBody` — up
// to 4 composite variants in the tile grid — with a small `2×2`/`2×3`/`2×4`
// corner badge (flipped for portrait composites) reminding the user of
// the active layout.

function StoryboardBody({ rfId, data }: { rfId: string; data: FlowboardNodeData }) {
  // Show the concrete rows × cols (post-orientation flip), not the
  // user-picker key. So a node with grid="2x3" on a portrait composite
  // shows "3×2" — matches what Flow actually rendered.
  const g = normaliseStoryboardGrid(data.storyboardGrid);
  const { rows, cols } = resolveStoryboardLayout(g, data.aspectRatio);
  const label = `${rows}×${cols}`;
  return (
    <div className="storyboard-wrap">
      <span
        className="storyboard-grid-badge"
        title={`Composite layout: ${label} (${rows * cols} panels)`}
      >
        {label}
      </span>
      <ImageBody rfId={rfId} data={data} />
    </div>
  );
}

function NodeBody({ rfId, data }: { rfId: string; data: FlowboardNodeData }) {
  switch (data.type) {
    case "character":
      return <CharacterBody rfId={rfId} data={data} />;
    case "image":
      return <ImageBody rfId={rfId} data={data} />;
    case "video":
      return <VideoBody rfId={rfId} data={data} />;
    case "prompt":
      return <EditableTextBody rfId={rfId} data={data} variant="prompt" />;
    case "note":
      return <EditableTextBody rfId={rfId} data={data} variant="note" />;
    case "visual_asset":
      return <VisualAssetBody rfId={rfId} data={data} />;
    case "Storyboard":
      return <StoryboardBody rfId={rfId} data={data} />;
  }
}

function downloadExt(type: string): string {
  if (type === "video") return "mp4";
  return "png";
}

export function NodeCard(props: NodeProps<FlowNode>) {
  const { lang, t } = useLang();
  const data = props.data;
  const defaultAspect = useSettingsStore((s) => s.defaultAspect);
  const aspectKind = aspectKindOf(data.aspectRatio, defaultAspect);
  const isNote = data.type === "note";
  const isGenerable = ["image", "prompt", "video", "visual_asset", "character", "Storyboard"].includes(data.type);
  const isRunning = data.status === "running";
  const llmBusy = isLLMBusy(data);
  const isProcessing = data.status === "queued" || data.status === "running" || llmBusy;
  const supportsAspectToggle = ["image", "video", "Storyboard", "visual_asset"].includes(data.type);
  const aspectLabel = aspectKind === "portrait" ? "9:16" : aspectKind === "square" ? "1:1" : "16:9";
  const downloadable = !!data.mediaId && data.type !== "prompt" && data.type !== "note";
  const canExtractTail = data.type === "video" && !!data.mediaId;
  const [extractingTail, setExtractingTail] = useState(false);

  function handleGenerate(e: React.MouseEvent) {
    e.stopPropagation();
    if (llmBusy) return; // guard: backend still composing for this node
    useGenerationStore.getState().openGenerationDialog(props.id, data.prompt ?? "");
  }

  function handleAbort(e: React.MouseEvent) {
    e.stopPropagation();
    void useGenerationStore.getState().abortNodeGeneration(props.id);
  }

  function handleDeleteNode(e: React.MouseEvent) {
    e.stopPropagation();
    void useBoardStore.getState().deleteNodeByRfId(props.id);
  }

  function handleToggleAspect(e: React.MouseEvent) {
    e.stopPropagation();
    const nextSide = aspectKind === "portrait" ? "landscape" : "portrait";
    const nextEnum = defaultAspectEnum(
      data.type === "video" ? "video" : "image",
      nextSide,
    );
    useBoardStore.getState().updateNodeData(props.id, { aspectRatio: nextEnum });
    const dbId = parseInt(props.id, 10);
    if (!isNaN(dbId)) {
      patchNode(dbId, { data: { aspectRatio: nextEnum } }).catch(() => {});
    }
  }

  async function handleExtractTail(e: React.MouseEvent) {
    e.stopPropagation();
    if (extractingTail) return;
    const dbId = parseInt(props.id, 10);
    if (isNaN(dbId)) return;
    setExtractingTail(true);
    try {
      await extractTailFrame(dbId);
      await useBoardStore.getState().refreshBoardState();
    } catch (err) {
      useGenerationStore.setState({
        error: err instanceof Error ? err.message : t("抠取尾帧失败", "Tail frame extraction failed"),
      });
    } finally {
      setExtractingTail(false);
    }
  }

  function handleDownload(e: React.MouseEvent) {
    e.stopPropagation();
    // Download every variant, not just the first. `mediaIds` is the full
    // list — `mediaId` is just the active variant — so a 4-variant image
    // node was previously losing 3 of its 4 outputs. Filter out null
    // placeholders that the partial-batch path may leave in `mediaIds`.
    const rawIds =
      data.mediaIds && data.mediaIds.length > 0
        ? data.mediaIds
        : data.mediaId
          ? [data.mediaId]
          : [];
    const ids = rawIds.filter((m): m is string => typeof m === "string" && m.length > 0);
    if (ids.length === 0) return;
    const safeTitle = (data.title || data.type).replace(/[^A-Za-z0-9_-]+/g, "_");
    const ext = downloadExt(data.type);
    // `<a download>` only honours the suggested filename when the resource
    // is same-origin — `/media/<id>` *is* same-origin (proxied by FastAPI),
    // so the title-based filename sticks.
    ids.forEach((mid, i) => {
      const a = document.createElement("a");
      a.href = mediaUrl(mid);
      const suffix = ids.length > 1 ? `-${i + 1}` : "";
      a.download = `${safeTitle}-${data.shortId}${suffix}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
  }

  return (
    <div
      className={`node-card${isNote ? " node-card--note" : ""}${
        props.selected ? " node-card--selected" : ""
      }${llmBusy ? " node-card--llm-busy" : ""}`}
      data-node-type={data.type}
      data-aspect={aspectKind}
    >
      <StatusStrip status={data.status} />
      <Handle type="target" position={Position.Left} className="node-handle" />

      <div className="node-header">
        <span className="node-icon" aria-hidden="true">
          <NodeTypeIcon type={data.type} size={13} />
        </span>
        <span className="node-title">{displayNodeTitle(data.title, data.type, lang)}</span>
        {llmBusy && (
          <span className="node-header__llm-pill" aria-live="polite">
            <span className="node-header__llm-spinner" aria-hidden="true" />
            {data.autoPromptStatus === "pending" ? t("写词中…", "Composing…") : t("识图中…", "Analyzing…")}
          </span>
        )}
        <div className="node-header__actions">
          {supportsAspectToggle && (
            <button
              type="button"
              className="node-aspect-pill"
              onClick={handleToggleAspect}
              title={t("点击切换该卡片显示比例 (9:16 竖屏 ↔ 16:9 横屏)", "Toggle card ratio (9:16 ↔ 16:9)")}
              aria-label={t(`当前比例 ${aspectLabel}，点击切换`, `Aspect ${aspectLabel}, click to toggle`)}
            >
              {aspectLabel}
            </button>
          )}
          {canExtractTail && (
            <button
              type="button"
              className={`node-header__btn${extractingTail ? " node-header__btn--running" : ""}`}
              onClick={(e) => void handleExtractTail(e)}
              aria-label={t("抠取尾帧接力下一镜", "Extract tail frame")}
              title={t("抠取真实尾帧，在右侧生成接力首帧节点", "Extract tail frame to spawn next-shot anchor")}
              tabIndex={0}
              disabled={extractingTail}
            >
              {extractingTail ? "…" : "↳"}
            </button>
          )}
          {downloadable && (
            <button
              type="button"
              className="node-header__btn"
              onClick={handleDownload}
              aria-label={t("下载全部变体", "Download media")}
              title={t("下载原片到本地", "Download")}
              tabIndex={0}
            >
              ⬇
            </button>
          )}
          {isProcessing ? (
            <button
              type="button"
              className="node-header__btn node-header__btn--cancel"
              onClick={handleAbort}
              aria-label={t("撤销生成", "Cancel generation")}
              title={t("立即停止并撤销本次生成（若已发往云端仍可能扣费）", "Stop and cancel generation")}
              tabIndex={0}
            >
              ■
            </button>
          ) : (
            isGenerable && (
              <button
                type="button"
                className={`node-header__btn${isRunning ? " node-header__btn--running" : ""}`}
                onClick={handleGenerate}
                aria-label={t("打开生成配置", "Generate from this node")}
                title={t("打开生成面板", "Generate")}
                tabIndex={0}
              >
                ▶
              </button>
            )
          )}
          <button
            type="button"
            className="node-header__btn node-header__btn--delete"
            onClick={handleDeleteNode}
            aria-label={t("删除节点", "Delete node")}
            title={t("删除节点（误删可按 ⌘Z 撤销恢复）", "Delete node (⌘Z to undo)")}
            tabIndex={0}
          >
            ×
          </button>
        </div>
        <span className="node-short-id">#{data.shortId}</span>
      </div>

      <NodeBody rfId={props.id} data={data} />

      <Handle type="source" position={Position.Right} className="node-handle" />
    </div>
  );
}
