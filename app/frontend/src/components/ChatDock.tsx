import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useBoardStore } from "../store/board";
import { useChatStore } from "../store/chat";
import { useGenerationStore } from "../store/generation";
import { useReferencesStore } from "../store/references";
import { defaultAspectEnum, useSettingsStore } from "../store/settings";
import {
  getActivityList,
  getLlmProviders,
  mediaUrl,
  polishPrompt,
  uploadChatAttachments,
  uploadImage,
  type ChatMessageDTO,
} from "../api/client";
import { useLang } from "../i18n";

// ── Limits (mirror backend caps in routes/chat.py) ────────────────────────────
const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_COMPOSER_REFS = 4;

// ── Dock sizing ──────────────────────────────────────────────────────────────
const DEFAULT_MUSE_HEIGHT = 320;
const MIN_MUSE_HEIGHT = 180;
const COLLAPSED_HEIGHT = 40;

type DockView = "composer" | "collapsed" | "muse";
type ComposerMode = "omni" | "first_last" | "veo" | "image";
type ComposerAspect = "portrait" | "landscape" | "square";
type ComposerDuration = 4 | 6 | 8 | 10;

interface ComposerRefItem {
  key: string;
  mediaId: string;
  label: string;
  sourceNodeId?: string;
  shortId?: string;
  aspectRatio?: string;
  aiBrief?: string;
}

const STEP_LABEL_ZH: Record<string, string> = {
  chat_agent: "导演智能体",
  gen_image: "生成图片",
  gen_video: "生成视频",
  edit_image: "修改图片",
  upload: "上传素材",
  planner: "规划分镜",
};
const STEP_LABEL_EN: Record<string, string> = {
  chat_agent: "Agent",
  gen_image: "Gen image",
  gen_video: "Gen video",
  edit_image: "Edit image",
  upload: "Upload",
  planner: "Planner",
};

function extractMentions(text: string): string[] {
  const matches = text.matchAll(/#(\w+)/g);
  return [...matches].map((m) => m[1]);
}

interface PickedFile {
  file: File;
  preview: string;
}

function MessageRow({ msg }: { msg: ChatMessageDTO }) {
  if (msg.role === "system") {
    return (
      <div className="chat-system-divider">
        <span>{msg.content}</span>
      </div>
    );
  }
  return (
    <div
      className={`chat-bubble ${
        msg.role === "user" ? "chat-bubble--user" : "chat-bubble--assistant"
      }`}
    >
      {msg.role === "assistant" && (
        <div className="chat-agent-label">agent</div>
      )}
      {msg.attachments.length > 0 && (
        <div className="chat-dock__msg-attachments">
          {msg.attachments.map((a) => (
            <img
              key={a.id}
              className="chat-dock__msg-thumb"
              src={a.url}
              alt="attachment"
              loading="lazy"
            />
          ))}
        </div>
      )}
      <div className="chat-bubble__text">{msg.content}</div>
    </div>
  );
}

const MEDIA_NODE_TYPES = new Set([
  "character",
  "image",
  "visual_asset",
  "Storyboard",
]);

function pickNonOverlappingSpot(
  preferredX: number,
  preferredY: number,
  existing: Array<{ position: { x: number; y: number } }>,
): { x: number; y: number } {
  let x = Math.round(preferredX);
  let y = Math.round(preferredY);
  for (let i = 0; i < 10; i++) {
    const collides = existing.some(
      (n) => Math.abs(n.position.x - x) < 160 && Math.abs(n.position.y - y) < 160,
    );
    if (!collides) break;
    y += 260;
  }
  return { x, y };
}

export function ChatDock() {
  const boardId = useBoardStore((s) => s.boardId);
  const nodes = useBoardStore((s) => s.nodes);
  const addNodeWithData = useBoardStore((s) => s.addNodeWithData);
  const addEdgeFromConnection = useBoardStore((s) => s.addEdgeFromConnection);
  const setUndoNotice = useBoardStore((s) => s.setUndoNotice);

  const savedReferences = useReferencesStore((s) => s.items);
  const defaultAspect = useSettingsStore((s) => s.defaultAspect);
  const mediaProvider = useSettingsStore((s) => s.mediaProvider);
  const setMediaProvider = useSettingsStore((s) => s.setMediaProvider);
  const imageModel = useSettingsStore((s) => s.imageModel);
  const setImageModel = useSettingsStore((s) => s.setImageModel);

  const messages = useChatStore((s) => s.messages);
  const pending = useChatStore((s) => s.pending);
  const activeRun = useChatStore((s) => s.activeRun);
  const runError = useChatStore((s) => s.runError);
  const loadChat = useChatStore((s) => s.loadChat);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const notifyError = useChatStore((s) => s.notifyError);
  const { isZh, t } = useLang();

  // View state — defaults to direct multimodal canvas composer
  const [viewMode, setViewMode] = useState<DockView>("composer");
  const [museHeight, setMuseHeight] = useState(DEFAULT_MUSE_HEIGHT);

  // Direct canvas composer state
  const [composerMode, setComposerMode] = useState<ComposerMode>("omni");
  const [composerAspect, setComposerAspect] = useState<ComposerAspect>(defaultAspect);
  const [durationS, setDurationS] = useState<ComposerDuration>(8);
  const [promptText, setPromptText] = useState("");
  const [selectedRefs, setSelectedRefs] = useState<ComposerRefItem[]>([]);
  const [startSlot, setStartSlot] = useState<ComposerRefItem | null>(null);
  const [endSlot, setEndSlot] = useState<ComposerRefItem | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<"refs" | "start" | "end">("refs");
  const [pickerSearch, setPickerSearch] = useState("");
  const [composerBusy, setComposerBusy] = useState(false);
  const [polishing, setPolishing] = useState(false);
  const [uploadingLocal, setUploadingLocal] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);

  // Legacy Muse chat state (only when switched to Muse tab)
  const [museText, setMuseText] = useState("");
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [uploadingMuse, setUploadingMuse] = useState(false);
  const [museAvailable, setMuseAvailable] = useState<boolean | null>(null);
  const [stepText, setStepText] = useState<string | null>(null);

  const localUploadInputRef = useRef<HTMLInputElement>(null);
  const museFileInputRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const dockRootRef = useRef<HTMLDivElement>(null);
  const resizingRef = useRef(false);

  // Follow top toolbar defaultAspect toggle cleanly
  useEffect(() => {
    setComposerAspect((cur) => (cur === "square" && composerMode === "image" ? cur : defaultAspect));
  }, [defaultAspect, composerMode]);

  // Video modes do not support 1:1 square
  useEffect(() => {
    if (composerMode !== "image" && composerAspect === "square") {
      setComposerAspect(defaultAspect);
    }
  }, [composerMode, composerAspect, defaultAspect]);

  // Clear board-scoped selections when switching boards
  useEffect(() => {
    setSelectedRefs([]);
    setStartSlot(null);
    setEndSlot(null);
    setPickerOpen(false);
    setComposerError(null);
    if (boardId !== null) void loadChat(boardId);
  }, [boardId, loadChat]);

  // Close ref popover on outside click / Escape
  useEffect(() => {
    if (!pickerOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (dockRootRef.current && target && !dockRootRef.current.contains(target)) {
        setPickerOpen(false);
      }
    };
    const onEsc = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setPickerOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onEsc);
    };
  }, [pickerOpen]);

  // Check Muse worker presence only passively when dock is open in Muse tab
  useEffect(() => {
    if (viewMode !== "muse") return;
    let alive = true;
    const refresh = async () => {
      try {
        const providers = await getLlmProviders();
        if (!alive) return;
        const muse = providers.find((p) => p.name === "muse");
        setMuseAvailable(muse ? muse.available : false);
      } catch {
        // Non-fatal
      }
    };
    void refresh();
    return () => {
      alive = false;
    };
  }, [viewMode]);

  useEffect(() => {
    if (!activeRun || viewMode !== "muse") {
      setStepText(null);
      return;
    }
    let alive = true;
    const refresh = async () => {
      try {
        const { items } = await getActivityList({ limit: 5 });
        if (!alive || items.length === 0) return;
        const latest = items[0];
        const label =
          (isZh ? STEP_LABEL_ZH[latest.type] : STEP_LABEL_EN[latest.type]) ??
          latest.type;
        const node = latest.node_short_id ? ` · #${latest.node_short_id}` : "";
        setStepText(`${label}${node} — ${latest.status}`);
      } catch {
        // Keep previous
      }
    };
    void refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [activeRun, isZh, viewMode]);

  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, stepText, runError]);

  useEffect(() => {
    const current = files;
    return () => {
      for (const f of current) URL.revokeObjectURL(f.preview);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Build pickable reference catalog from live canvas nodes + saved references library
  const canvasRefCandidates = useMemo<ComposerRefItem[]>(() => {
    const items: ComposerRefItem[] = [];
    for (const n of nodes) {
      if (!MEDIA_NODE_TYPES.has(n.data.type)) continue;
      const variants = (Array.isArray(n.data.mediaIds) ? n.data.mediaIds : []).filter(
        (m): m is string => typeof m === "string" && m.length > 0,
      );
      const primary =
        typeof n.data.mediaId === "string" && n.data.mediaId ? n.data.mediaId : variants[0];
      if (!primary) continue;
      const list = variants.length > 1 ? variants : [primary];
      list.forEach((mid, idx) => {
        const suffix = list.length > 1 ? ` v${idx + 1}` : "";
        items.push({
          key: `node:${n.id}:${idx}`,
          mediaId: mid,
          label: `${n.data.title || n.data.type}${suffix}`,
          sourceNodeId: n.id,
          shortId: n.data.shortId,
          aspectRatio: n.data.aspectRatio,
          aiBrief: n.data.aiBrief ?? n.data.prompt,
        });
      });
    }
    return items;
  }, [nodes]);

  const libraryRefCandidates = useMemo<ComposerRefItem[]>(() => {
    const seenMedia = new Set(canvasRefCandidates.map((c) => c.mediaId));
    return savedReferences
      .filter((r) => !seenMedia.has(r.mediaId))
      .map((r) => ({
        key: `lib:${r.id}`,
        mediaId: r.mediaId,
        label: r.label,
        aspectRatio: r.aspectRatio ?? undefined,
        aiBrief: r.aiBrief ?? undefined,
      }));
  }, [savedReferences, canvasRefCandidates]);

  const qLower = pickerSearch.trim().toLowerCase();
  const filteredCanvasCandidates = useMemo(() => {
    if (!qLower) return canvasRefCandidates;
    return canvasRefCandidates.filter(
      (c) =>
        c.label.toLowerCase().includes(qLower) ||
        (c.shortId ?? "").toLowerCase().includes(qLower) ||
        (c.aiBrief ?? "").toLowerCase().includes(qLower),
    );
  }, [canvasRefCandidates, qLower]);

  const filteredLibraryCandidates = useMemo(() => {
    if (!qLower) return libraryRefCandidates;
    return libraryRefCandidates.filter(
      (c) =>
        c.label.toLowerCase().includes(qLower) ||
        (c.aiBrief ?? "").toLowerCase().includes(qLower),
    );
  }, [libraryRefCandidates, qLower]);

  const assignPickedItem = useCallback(
    (item: ComposerRefItem) => {
      setComposerError(null);
      if (pickerTarget === "start") {
        setStartSlot(item);
        setPickerOpen(false);
        return;
      }
      if (pickerTarget === "end") {
        setEndSlot(item);
        setPickerOpen(false);
        return;
      }
      // Standard refs / single veo frame
      if (composerMode === "veo") {
        setSelectedRefs([item]);
        setPickerOpen(false);
        return;
      }
      setSelectedRefs((prev) => {
        if (prev.some((p) => p.mediaId === item.mediaId)) return prev;
        if (prev.length >= MAX_COMPOSER_REFS) {
          setComposerError(
            t(`最多同时引用 ${MAX_COMPOSER_REFS} 张参考图。`, `Max ${MAX_COMPOSER_REFS} references.`),
          );
          return prev;
        }
        return [...prev, item];
      });
    },
    [composerMode, pickerTarget, t],
  );

  const handleLocalUploadFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0 || boardId === null) return;
      setUploadingLocal(true);
      setComposerError(null);
      try {
        const isDry = mediaProvider === "dry_run";
        const projectId = isDry
          ? ""
          : (await useGenerationStore.getState().ensureProjectId()) ?? "";
        if (!isDry && !projectId) {
          throw new Error(
            t("请先在设置中绑定 Flow 项目，或切换为「干跑 0积分」本地上传。", "Bind a Flow project first or switch to Dry Run."),
          );
        }
        for (const file of Array.from(fileList).slice(0, MAX_COMPOSER_REFS)) {
          if (!file.type.startsWith("image/")) continue;
          if (file.size > MAX_FILE_BYTES) {
            setComposerError(t(`「${file.name}」超过 10 MB 限制`, `"${file.name}" > 10 MB`));
            continue;
          }
          const resp = await uploadImage(file, projectId, undefined, { localOnly: isDry });
          // Spawn an immediate visual_asset node on the left side of the canvas so the link is visual & persistent
          const spawnPos = pickNonOverlappingSpot(120, 140 + nodes.length * 40, nodes);
          const assetTitle = file.name.replace(/\.[^.]+$/, "").slice(0, 28) || t("本地参考图", "Uploaded ref");
          const createdId = await addNodeWithData(
            "visual_asset",
            spawnPos,
            {
              title: assetTitle,
              mediaId: resp.media_id,
              mediaIds: [resp.media_id],
              variantCount: 1,
              aspectRatio: resp.aspect_ratio,
              renderedAt: new Date().toISOString(),
            },
            { status: "done" },
          );
          const newItem: ComposerRefItem = {
            key: `up:${resp.media_id}`,
            mediaId: resp.media_id,
            label: assetTitle,
            sourceNodeId: createdId ?? undefined,
            aspectRatio: resp.aspect_ratio,
          };
          assignPickedItem(newItem);
        }
      } catch (err) {
        setComposerError(err instanceof Error ? err.message : String(err));
      } finally {
        setUploadingLocal(false);
      }
    },
    [addNodeWithData, assignPickedItem, boardId, mediaProvider, nodes, t],
  );

  const handlePolish = useCallback(async () => {
    if (polishing) return;
    const refs =
      composerMode === "first_last"
        ? [startSlot, endSlot].filter((x): x is ComposerRefItem => Boolean(x))
        : selectedRefs;
    const raw = promptText.trim();
    if (!raw && refs.length === 0) return;
    setPolishing(true);
    setComposerError(null);
    try {
      const apiMode =
        composerMode === "image"
          ? "image"
          : composerMode === "first_last"
          ? "first_last"
          : composerMode === "omni"
          ? "omni"
          : "video";
      const res = await polishPrompt({
        raw_text: raw,
        mode: apiMode,
        ref_briefs: refs.map((r) => r.aiBrief || r.label),
        duration_s: durationS,
      });
      setPromptText(res.prompt);
      composerInputRef.current?.focus();
    } catch (err) {
      setComposerError(err instanceof Error ? err.message : String(err));
    } finally {
      setPolishing(false);
    }
  }, [composerMode, durationS, endSlot, polishing, promptText, selectedRefs, startSlot]);

  const handleComposerSubmit = useCallback(async () => {
    if (boardId === null || composerBusy || uploadingLocal) return;
    setComposerError(null);

    if (composerMode === "first_last") {
      if (!startSlot || !endSlot) {
        setComposerError(t("首尾帧模式需要同时选择「起幅首帧」与「落幅尾帧」。", "Pick both Start and End frames."));
        return;
      }
      if (startSlot.mediaId === endSlot.mediaId) {
        setComposerError(t("起幅首帧与落幅尾帧不能是同一张图。", "Start and End frames must differ."));
        return;
      }
    } else if (composerMode === "omni" || composerMode === "veo") {
      if (selectedRefs.length === 0) {
        setComposerError(
          composerMode === "omni"
            ? t("全能参考模式请先点击「+ 引用图片」选择至少 1 张参考图。", "Select at least 1 reference image for Omni mode.")
            : t("首帧图生模式请先点击「+ 引用图片」选择 1 张首帧图。", "Select a start frame image for Veo i2v."),
        );
        return;
      }
    } else if (!promptText.trim()) {
      setComposerError(t("请输入画面描述后再生成分镜图。", "Enter a prompt before generating an image."));
      return;
    }

    const activeRefs =
      composerMode === "first_last"
        ? [startSlot!, endSlot!]
        : selectedRefs;

    const finalPrompt =
      promptText.trim() ||
      (composerMode === "first_last"
        ? "Smooth same-camera transition from frame 0 to the end frame, natural motion and atmosphere, NO SUBTITLES."
        : "Subtle natural breathing, authentic eye focus shift and gentle cinematic dolly-in, NO SUBTITLES.");

    setComposerBusy(true);
    try {
      // Materialize any library-only references into canvas visual_asset nodes so edges remain traceable
      const wiredSourceIds: string[] = [];
      let libIdx = 0;
      for (const ref of activeRefs) {
        if (ref.sourceNodeId && nodes.some((n) => n.id === ref.sourceNodeId)) {
          wiredSourceIds.push(ref.sourceNodeId);
        } else {
          const libSpot = pickNonOverlappingSpot(160, 140 + libIdx * 240, nodes);
          libIdx += 1;
          const createdSrcId = await addNodeWithData(
            "visual_asset",
            libSpot,
            {
              title: ref.label || t("参考图", "Reference"),
              mediaId: ref.mediaId,
              mediaIds: [ref.mediaId],
              variantCount: 1,
              aspectRatio: ref.aspectRatio,
              aiBrief: ref.aiBrief,
              renderedAt: new Date().toISOString(),
            },
            { skipHistory: true, status: "done" },
          );
          if (createdSrcId) wiredSourceIds.push(createdSrcId);
        }
      }

      const currentNodes = useBoardStore.getState().nodes;
      const sourceObjs = wiredSourceIds
        .map((id) => currentNodes.find((n) => n.id === id))
        .filter((n): n is NonNullable<typeof n> => Boolean(n));

      const preferredX =
        sourceObjs.length > 0
          ? Math.max(...sourceObjs.map((n) => n.position.x)) + 340
          : currentNodes.length > 0
          ? Math.max(...currentNodes.map((n) => n.position.x)) + 320
          : 480;
      const preferredY =
        sourceObjs.length > 0
          ? sourceObjs.reduce((acc, n) => acc + n.position.y, 0) / sourceObjs.length
          : 180;
      const spawnPos = pickNonOverlappingSpot(preferredX, preferredY, currentNodes);

      const targetKind: "image" | "video" = composerMode === "image" ? "image" : "video";
      const targetAspectEnum =
        composerAspect === "square"
          ? "IMAGE_ASPECT_RATIO_SQUARE"
          : defaultAspectEnum(targetKind, composerAspect);

      const nodeTitle =
        composerMode === "first_last"
          ? t("⇄ 首尾帧过渡", "⇄ Start → End")
          : composerMode === "omni"
          ? t("✦ 全能参考视频", "✦ Omni video")
          : composerMode === "veo"
          ? t("▶ 首帧视频", "▶ Veo clip")
          : t("▣ 直出分镜图", "▣ Generated shot");

      const newRfId = await addNodeWithData(
        targetKind,
        spawnPos,
        {
          title: nodeTitle,
          prompt: finalPrompt,
          aspectRatio: targetAspectEnum,
          variantCount: 1,
          ...(composerMode === "first_last" ? { firstLastMode: true } : {}),
        },
        { status: "queued" },
      );

      if (!newRfId) {
        throw new Error(t("创建画布节点失败", "Failed to create target node"));
      }

      for (const srcId of wiredSourceIds) {
        await addEdgeFromConnection(srcId, newRfId);
      }

      const genStore = useGenerationStore.getState();
      if (composerMode === "first_last" && startSlot && endSlot) {
        await genStore.dispatchGeneration(newRfId, {
          prompt: finalPrompt,
          kind: "video",
          aspectRatio: targetAspectEnum,
          firstLastMode: true,
          startMediaId: startSlot.mediaId,
          endMediaId: endSlot.mediaId,
          durationS,
          variantCount: 1,
        });
      } else if (composerMode === "omni") {
        await genStore.dispatchGeneration(newRfId, {
          prompt: finalPrompt,
          kind: "video",
          videoMode: "omni",
          refMediaIds: activeRefs.map((r) => r.mediaId),
          durationS,
          aspectRatio: targetAspectEnum,
          variantCount: 1,
        });
      } else if (composerMode === "veo") {
        await genStore.dispatchGeneration(newRfId, {
          prompt: finalPrompt,
          kind: "video",
          videoMode: "veo",
          sourceMediaId: activeRefs[0].mediaId,
          aspectRatio: targetAspectEnum,
          variantCount: 1,
        });
      } else {
        await genStore.dispatchGeneration(newRfId, {
          prompt: finalPrompt,
          kind: "image",
          refMediaIds: activeRefs.map((r) => r.mediaId),
          aspectRatio: targetAspectEnum,
          variantCount: 1,
        });
      }

      setPromptText("");
      setPickerOpen(false);
      setUndoNotice({
        text: t(
          `已在画布创建「${nodeTitle}」并提交生成 · 误触可直接点卡片 ■ 撤销或按 ⌘Z`,
          `Created "${nodeTitle}" · click ■ on card or press ⌘Z to undo`,
        ),
        canUndo: true,
      });
    } catch (err) {
      setComposerError(err instanceof Error ? err.message : String(err));
    } finally {
      setComposerBusy(false);
    }
  }, [
    addEdgeFromConnection,
    addNodeWithData,
    boardId,
    composerAspect,
    composerBusy,
    composerMode,
    durationS,
    endSlot,
    nodes,
    promptText,
    selectedRefs,
    setUndoNotice,
    startSlot,
    t,
    uploadingLocal,
  ]);

  const onComposerKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "@" && !e.nativeEvent.isComposing) {
        setPickerTarget(
          composerMode === "first_last"
            ? !startSlot
              ? "start"
              : "end"
            : "refs",
        );
        setPickerOpen(true);
      }
      if (
        e.key === "Enter" &&
        !e.shiftKey &&
        !e.nativeEvent.isComposing &&
        e.keyCode !== 229
      ) {
        e.preventDefault();
        void handleComposerSubmit();
      }
    },
    [composerMode, handleComposerSubmit, startSlot],
  );

  // Legacy Muse helpers
  const addMuseFiles = useCallback(
    (list: FileList | null) => {
      if (!list || list.length === 0) return;
      const accepted: PickedFile[] = [];
      for (const f of Array.from(list)) {
        if (files.length + accepted.length >= MAX_FILES) {
          notifyError(t(`单条消息最多附加 ${MAX_FILES} 张图片。`, `Max ${MAX_FILES} images.`));
          break;
        }
        if (!f.type.startsWith("image/")) continue;
        if (f.size > MAX_FILE_BYTES) continue;
        accepted.push({ file: f, preview: URL.createObjectURL(f) });
      }
      if (accepted.length > 0) setFiles((prev) => [...prev, ...accepted]);
    },
    [files.length, notifyError, t],
  );

  const removeMuseFile = useCallback((preview: string) => {
    setFiles((prev) => {
      const removed = prev.find((f) => f.preview === preview);
      if (removed) URL.revokeObjectURL(removed.preview);
      return prev.filter((f) => f.preview !== preview);
    });
  }, []);

  const canSendMuse =
    !pending &&
    !uploadingMuse &&
    activeRun === null &&
    museAvailable === true &&
    (museText.trim().length > 0 || files.length > 0);

  const handleMuseSend = useCallback(async () => {
    if (!canSendMuse || boardId === null) return;
    const known = new Set(nodes.map((n) => n.data.shortId));
    const mentions = extractMentions(museText).filter((m) => known.has(m));
    let attachmentIds: number[] = [];
    let previews: Array<{ mime: string; url: string }> = [];
    if (files.length > 0) {
      setUploadingMuse(true);
      try {
        const result = await uploadChatAttachments(boardId, files.map((f) => f.file));
        attachmentIds = result.assets.map((a) => a.id);
        previews = result.assets.map((a) => ({ mime: a.mime, url: a.url }));
      } catch (err) {
        notifyError(err instanceof Error ? err.message : String(err));
        setUploadingMuse(false);
        return;
      }
      setUploadingMuse(false);
      for (const f of files) URL.revokeObjectURL(f.preview);
      setFiles([]);
    }
    const content = museText.trim() || t("请基于参考图继续。", "Proceed with attached images.");
    setMuseText("");
    await sendMessage(content, mentions, attachmentIds, previews);
  }, [boardId, canSendMuse, files, museText, nodes, notifyError, sendMessage, t]);

  const onResizeStart = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      resizingRef.current = true;
      const startY = e.clientY;
      const startH = museHeight;
      const maxH = Math.floor(window.innerHeight * 0.7);
      const onMove = (ev: MouseEvent) => {
        if (!resizingRef.current) return;
        setMuseHeight(Math.min(Math.max(startH + (startY - ev.clientY), MIN_MUSE_HEIGHT), maxH));
      };
      const onUp = () => {
        resizingRef.current = false;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [museHeight],
  );

  if (boardId === null) return null;

  if (viewMode === "collapsed") {
    return (
      <div
        className="chat-dock chat-dock--collapsed"
        style={{ height: COLLAPSED_HEIGHT }}
      >
        <button
          type="button"
          className="chat-dock__bar"
          onClick={() => setViewMode("composer")}
        >
          <svg className="chat-dock__bar-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M8 2l1.2 3.2L12.5 6.4 9.2 7.6 8 11 6.8 7.6 3.5 6.4 6.8 5.2 8 2z" />
          </svg>
          <span className="chat-dock__bar-label">
            {t("画布直出工作台 · 全能参考 / 首尾帧 / 生图", "Canvas Composer · Omni / Start→End / Image")}
          </span>
          <svg className="chat-dock__bar-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 10l4-4 4 4" />
          </svg>
        </button>
      </div>
    );
  }

  if (viewMode === "muse") {
    return (
      <div className="chat-dock" style={{ height: museHeight }}>
        <div
          className="chat-dock__resize-handle"
          onMouseDown={onResizeStart}
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("拖动调整高度", "Drag to resize")}
        />
        <div className="chat-dock__header">
          <div className="composer-dock__tabs">
            <button
              type="button"
              className="composer-dock__tab"
              onClick={() => setViewMode("composer")}
            >
              {t("直出工作台", "Composer")}
            </button>
            <button
              type="button"
              className="composer-dock__tab composer-dock__tab--active"
              onClick={() => setViewMode("muse")}
            >
              Muse
            </button>
          </div>
          <span
            className={`chat-dock__presence chat-dock__presence--${
              museAvailable === null ? "loading" : museAvailable ? "ok" : "bad"
            }`}
          >
            {museAvailable === null ? "○" : museAvailable ? "●" : "○"} {museAvailable ? t("已就绪", "Ready") : t("未开启", "Offline")}
          </span>
          <button
            type="button"
            className="chat-dock__collapse-btn"
            onClick={() => setViewMode("collapsed")}
            aria-label={t("收起", "Collapse")}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 6l4 4 4-4" />
            </svg>
          </button>
        </div>

        <div className="chat-dock__messages" ref={messagesRef}>
          {messages.map((msg) => (
            <MessageRow key={msg.id} msg={msg} />
          ))}
          {activeRun && (
            <div className="chat-dock__step">
              <span className="chat-dock__step-dots" aria-hidden="true">●●●</span>
              <span>{stepText ?? t("智能体执行中…", "Agent working…")}</span>
            </div>
          )}
          {runError && (
            <div className="chat-dock__error">{t("错误：", "Error: ")}{runError}</div>
          )}
        </div>

        <div className="chat-dock__composer">
          {files.length > 0 && (
            <div className="chat-dock__attach-strip">
              {files.map((f) => (
                <div key={f.preview} className="chat-dock__thumb">
                  <img src={f.preview} alt={f.file.name} />
                  <button
                    type="button"
                    className="chat-dock__thumb-remove"
                    onClick={() => removeMuseFile(f.preview)}
                    aria-label={t(`移除 ${f.file.name}`, `Remove ${f.file.name}`)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="chat-dock__input-row">
            <input
              ref={museFileInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                addMuseFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              className="chat-dock__attach-btn"
              onClick={() => museFileInputRef.current?.click()}
              disabled={pending || uploadingMuse || activeRun !== null}
              aria-label={t("附加图片", "Attach image")}
            >
              +
            </button>
            <textarea
              className="chat-dock__textarea"
              value={museText}
              onChange={(e) => setMuseText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void handleMuseSend();
                }
              }}
              placeholder={t("向 Muse 对话助手发送指令…", "Message Muse assistant…")}
              disabled={pending || uploadingMuse || activeRun !== null}
              rows={2}
            />
            <button
              type="button"
              className="chat-dock__send"
              onClick={() => void handleMuseSend()}
              disabled={!canSendMuse}
              aria-label={t("发送", "Send")}
            >
              →
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Default View: Direct Multimodal Canvas Prompt Composer
  const composerCanSubmit =
    !composerBusy &&
    !uploadingLocal &&
    (composerMode === "first_last"
      ? Boolean(startSlot && endSlot && startSlot.mediaId !== endSlot.mediaId)
      : composerMode === "omni" || composerMode === "veo"
      ? selectedRefs.length > 0
      : promptText.trim().length > 0);

  return (
    <div className="chat-dock chat-dock--composer-bar" ref={dockRootRef}>
      <input
        ref={localUploadInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple={pickerTarget === "refs" && composerMode !== "veo"}
        hidden
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          void handleLocalUploadFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {/* Popover: Canvas Image Picker + Library + Local Upload */}
      {pickerOpen && (
        <div
          className="composer-ref-popover"
          role="dialog"
          aria-label={t("选择画布或本地参考图片", "Pick canvas or local image reference")}
        >
          <div className="composer-ref-popover__head">
            <span className="composer-ref-popover__title">
              {pickerTarget === "start"
                ? t("选择【起幅首帧 Start】", "Pick Start frame")
                : pickerTarget === "end"
                ? t("选择【落幅尾帧 End】", "Pick End frame")
                : t("引用画布图片或上传本地图", "Reference canvas or local image")}
            </span>
            <input
              type="search"
              className="composer-ref-popover__search"
              placeholder={t("按名称 / #编号筛选…", "Filter by name / #id…")}
              value={pickerSearch}
              onChange={(e) => setPickerSearch(e.target.value)}
            />
            <button
              type="button"
              className="composer-ref-popover__upload-btn"
              onClick={() => localUploadInputRef.current?.click()}
              disabled={uploadingLocal}
            >
              {uploadingLocal ? t("上传中…", "Uploading…") : t("+ 上传本地图", "+ Upload local")}
            </button>
          </div>

          <div className="composer-ref-popover__body">
            {filteredCanvasCandidates.length === 0 && filteredLibraryCandidates.length === 0 ? (
              <div className="composer-ref-popover__empty">
                {t("当前画布暂无已渲染图片，可直接点击右上角「+ 上传本地图」加入参考。", "No rendered images on this board yet. Click + Upload local above.")}
              </div>
            ) : (
              <>
                {filteredCanvasCandidates.length > 0 && (
                  <div className="composer-ref-popover__section">
                    <div className="composer-ref-popover__sec-label">
                      {t("当前画布节点", "Canvas nodes")}
                    </div>
                    <div className="composer-ref-popover__grid">
                      {filteredCanvasCandidates.map((item) => {
                        const isPicked =
                          pickerTarget === "start"
                            ? startSlot?.mediaId === item.mediaId
                            : pickerTarget === "end"
                            ? endSlot?.mediaId === item.mediaId
                            : selectedRefs.some((r) => r.mediaId === item.mediaId);
                        return (
                          <button
                            key={item.key}
                            type="button"
                            className={`composer-ref-item${isPicked ? " composer-ref-item--picked" : ""}`}
                            onClick={() => assignPickedItem(item)}
                            title={item.aiBrief || item.label}
                          >
                            <img src={mediaUrl(item.mediaId)} alt={item.label} />
                            <span className="composer-ref-item__name">{item.label}</span>
                            {item.shortId && (
                              <span className="composer-ref-item__id">#{item.shortId}</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {filteredLibraryCandidates.length > 0 && (
                  <div className="composer-ref-popover__section">
                    <div className="composer-ref-popover__sec-label">
                      {t("跨画布素材库", "Saved library")}
                    </div>
                    <div className="composer-ref-popover__grid">
                      {filteredLibraryCandidates.map((item) => {
                        const isPicked = selectedRefs.some((r) => r.mediaId === item.mediaId);
                        return (
                          <button
                            key={item.key}
                            type="button"
                            className={`composer-ref-item${isPicked ? " composer-ref-item--picked" : ""}`}
                            onClick={() => assignPickedItem(item)}
                            title={item.aiBrief || item.label}
                          >
                            <img src={mediaUrl(item.mediaId)} alt={item.label} />
                            <span className="composer-ref-item__name">{item.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Row 1: Generation Modes + Aspect + Duration + Dock Switcher */}
      <div className="composer-bar__top">
        <div className="composer-mode-group" role="tablist" aria-label={t("生成模式", "Generation mode")}>
          <button
            type="button"
            role="tab"
            aria-selected={composerMode === "omni"}
            className={`composer-pill${composerMode === "omni" ? " composer-pill--active" : ""}`}
            onClick={() => {
              setComposerMode("omni");
              setComposerError(null);
            }}
            title={t("全能参考 (Omni Flash)：引用多张角色/场景图直接生成连续视频", "Omni Flash multi-reference video")}
          >
            {t("全能参考", "Omni")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={composerMode === "first_last"}
            className={`composer-pill${composerMode === "first_last" ? " composer-pill--active" : ""}`}
            onClick={() => {
              setComposerMode("first_last");
              setComposerError(null);
            }}
            title={t("首尾帧模式 (Start → End)：选定首帧和尾帧精准过渡", "First + Last frame transition")}
          >
            {t("首尾帧", "Start→End")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={composerMode === "veo"}
            className={`composer-pill${composerMode === "veo" ? " composer-pill--active" : ""}`}
            onClick={() => {
              setComposerMode("veo");
              setComposerError(null);
            }}
            title={t("Veo 首帧图生视频", "Veo image-to-video")}
          >
            {t("首帧视频", "Veo")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={composerMode === "image"}
            className={`composer-pill${composerMode === "image" ? " composer-pill--active" : ""}`}
            onClick={() => {
              setComposerMode("image");
              setComposerError(null);
            }}
            title={t("Nano Banana 生图 / 融图", "Generate cinema frame")}
          >
            {t("生图", "Image")}
          </button>
        </div>

        <div className="composer-bar__params">
          <div className="composer-seg" role="group" aria-label={t("画幅", "Aspect")}>
            <button
              type="button"
              className={`composer-seg__btn${composerAspect === "portrait" ? " composer-seg__btn--active" : ""}`}
              onClick={() => setComposerAspect("portrait")}
            >
              9:16
            </button>
            <button
              type="button"
              className={`composer-seg__btn${composerAspect === "landscape" ? " composer-seg__btn--active" : ""}`}
              onClick={() => setComposerAspect("landscape")}
            >
              16:9
            </button>
            {composerMode === "image" && (
              <button
                type="button"
                className={`composer-seg__btn${composerAspect === "square" ? " composer-seg__btn--active" : ""}`}
                onClick={() => setComposerAspect("square")}
              >
                1:1
              </button>
            )}
          </div>

          {(composerMode === "omni" || composerMode === "first_last") && (
            <div className="composer-seg" role="group" aria-label={t("时长", "Duration")}>
              {([4, 6, 8, 10] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`composer-seg__btn${durationS === d ? " composer-seg__btn--active" : ""}`}
                  onClick={() => setDurationS(d)}
                >
                  {d}s
                </button>
              ))}
            </div>
          )}

          <button
            type="button"
            className={`composer-provider-tag${imageModel === "MIDJOURNEY_V7" ? " composer-provider-tag--mj" : ""}`}
            style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
            onClick={() => {
              const nextMj = imageModel !== "MIDJOURNEY_V7";
              setImageModel(nextMj ? "MIDJOURNEY_V7" : "NANO_BANANA_PRO");
              if (nextMj && composerMode !== "image") {
                setComposerMode("image");
              }
            }}
            title={t(
              "点击切换生图引擎：Midjourney V7 (--v 7 --oref 电影审美) ↔ Nano Banana Pro (Flow 0积分)",
              "Toggle Image Engine: Midjourney V7 ↔ Nano Banana Pro",
            )}
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M8.5 2C10.5 4.6 11.8 7.4 12 11H4C4.7 8.1 6.1 5 8.5 2Z"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
              <path d="M2.5 13.2H13.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            <span>{imageModel === "MIDJOURNEY_V7" ? "MJ V7" : "Banana"}</span>
          </button>

          <button
            type="button"
            className={`composer-provider-tag${mediaProvider === "dry_run" ? " composer-provider-tag--dry" : ""}`}
            onClick={() => setMediaProvider(mediaProvider === "dry_run" ? "flow" : "dry_run")}
            title={t("点击切换 Flow 实拍 / 干跑 0积分", "Toggle Live Flow / Dry Run 0c")}
          >
            {mediaProvider === "dry_run" ? t("干跑0c", "Dry") : "Flow"}
          </button>

          <button
            type="button"
            className="composer-dock-mini-btn composer-dock-mini-btn--multimodal"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
            onClick={() => window.dispatchEvent(new CustomEvent("flowboard:open-multimodal-hub"))}
            title={t("打开多模态协同台：从当前 Midjourney 网页一键无损导图或启动 MJ+Flow/Muse 接力", "Open Multi-Modal Hub (MJ Browser Import & Muse Co-Pilot)")}
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M8 1.5L14 5V11L8 14.5L2 11V5L8 1.5Z"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
            </svg>
            <span>{t("MJ/Muse", "MJ/Muse")}</span>
          </button>

          <button
            type="button"
            className="composer-dock-mini-btn"
            onClick={() => setViewMode("muse")}
            title={t("切换到 Muse 对话模式", "Switch to Muse Chat")}
          >
            Muse
          </button>
          <button
            type="button"
            className="composer-dock-mini-btn"
            onClick={() => {
              setPickerOpen(false);
              setViewMode("collapsed");
            }}
            aria-label={t("收起底部工作台", "Collapse bar")}
            title={t("收起", "Collapse")}
          >
            ⌄
          </button>
        </div>
      </div>

      {/* Row 2: First+Last Dual Slots OR Reference Thumbnail Strip */}
      {composerMode === "first_last" ? (
        <div className="composer-fl-slots">
          <button
            type="button"
            className={`composer-fl-slot${startSlot ? " composer-fl-slot--filled" : ""}`}
            onClick={() => {
              setPickerTarget("start");
              setPickerOpen(true);
            }}
          >
            {startSlot ? (
              <>
                <img src={mediaUrl(startSlot.mediaId)} alt={startSlot.label} />
                <span className="composer-fl-slot__tag">{t("首帧", "Start")}</span>
                <span className="composer-fl-slot__label">{startSlot.label}</span>
              </>
            ) : (
              <span className="composer-fl-slot__empty">+ {t("选首帧 Start", "Start frame")}</span>
            )}
          </button>
          <button
            type="button"
            className="composer-fl-swap"
            onClick={() => {
              const prevStart = startSlot;
              setStartSlot(endSlot);
              setEndSlot(prevStart);
            }}
            disabled={!startSlot && !endSlot}
            title={t("互换首尾帧", "Swap Start & End")}
            aria-label={t("互换首尾帧", "Swap Start & End")}
          >
            ⇄
          </button>
          <button
            type="button"
            className={`composer-fl-slot${endSlot ? " composer-fl-slot--filled" : ""}`}
            onClick={() => {
              setPickerTarget("end");
              setPickerOpen(true);
            }}
          >
            {endSlot ? (
              <>
                <img src={mediaUrl(endSlot.mediaId)} alt={endSlot.label} />
                <span className="composer-fl-slot__tag composer-fl-slot__tag--end">{t("尾帧", "End")}</span>
                <span className="composer-fl-slot__label">{endSlot.label}</span>
              </>
            ) : (
              <span className="composer-fl-slot__empty">+ {t("选尾帧 End", "End frame")}</span>
            )}
          </button>
        </div>
      ) : (
        selectedRefs.length > 0 && (
          <div className="composer-ref-strip">
            {selectedRefs.map((ref, idx) => (
              <div key={`${ref.key}-${idx}`} className="composer-ref-chip">
                <img src={mediaUrl(ref.mediaId)} alt={ref.label} />
                <span className="composer-ref-chip__text">
                  @{idx + 1} {ref.label}
                </span>
                <button
                  type="button"
                  className="composer-ref-chip__rm"
                  onClick={() =>
                    setSelectedRefs((prev) => prev.filter((_, i) => i !== idx))
                  }
                  aria-label={t(`移出 ${ref.label}`, `Remove ${ref.label}`)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )
      )}

      {/* Row 3: Prompt Input + Reference Button + Polish Button + Send CTA */}
      <div className="composer-input-row">
        <button
          type="button"
          className={`composer-ref-trigger${pickerOpen ? " composer-ref-trigger--open" : ""}`}
          onClick={() => {
            setPickerTarget(
              composerMode === "first_last"
                ? !startSlot
                  ? "start"
                  : "end"
                : "refs",
            );
            setPickerOpen((o) => !o);
          }}
          title={t("引用画布图片或上传本地图（也可在框内键入 @ 呼出）", "Attach canvas or local image (or type @)")}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="2" y="2.5" width="12" height="11" rx="2" />
            <circle cx="5.8" cy="6.2" r="1.1" />
            <path d="M14 10.5l-3.2-3.2-6.3 6.2" />
          </svg>
          <span>{t("引用", "Ref")}</span>
        </button>

        <textarea
          ref={composerInputRef}
          className="composer-textarea"
          value={promptText}
          onChange={(e) => setPromptText(e.target.value)}
          onKeyDown={onComposerKeyDown}
          placeholder={
            composerMode === "first_last"
              ? t("描述首尾帧中间的过渡动作与运镜（输入 @ 可选图，Enter 直出生成）…", "Describe transition motion between Start & End… (Enter to generate)")
              : composerMode === "omni"
              ? t("输入中文或英文分镜指令，键入 @ 引用画布角色/场景图（Enter 直出视频）…", "Describe scene using @ referenced images… (Enter to generate)")
              : composerMode === "veo"
              ? t("描述该首帧图接下来 8 秒内的动作、台词与单主运镜（Enter 生成）…", "Describe next 8s motion & camera from start frame…")
              : t("描述你想直出的分镜画面（可先引用角色白底图，Enter 生成剧照）…", "Describe shot frame to generate on canvas…")
          }
          rows={2}
          disabled={composerBusy}
        />

        <button
          type="button"
          className="composer-polish-btn"
          onClick={() => void handlePolish()}
          disabled={polishing || (!promptText.trim() && selectedRefs.length === 0 && !startSlot)}
          title={t("按 Flow 2026 + Realman 规范一键润色/净化提示词", "Polish & sanitize prompt into Flow 2026 standard")}
          aria-label={t("润色提示词", "Polish prompt")}
        >
          {polishing ? "…" : "✨"}
        </button>

        <button
          type="button"
          className="composer-submit-btn"
          onClick={() => void handleComposerSubmit()}
          disabled={!composerCanSubmit}
        >
          {composerBusy ? t("提交中…", "Sending…") : t("生成", "Generate")}
        </button>
      </div>

      {composerError && (
        <div className="composer-error" role="alert">
          {composerError}
        </div>
      )}
    </div>
  );
}
