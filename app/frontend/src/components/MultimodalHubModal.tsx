import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import gsap from "gsap";
import {
  getMidjourneyBrowserAssets,
  getMultimodalStatus,
  importMidjourneyBrowserAsset,
  openMultimodalTab,
  type MjBrowserAssetItem,
  type MultimodalStatusResponse,
} from "../api/client";
import { useLang } from "../i18n";
import {
  attachGsapCardTilt,
  resetGsapCardTilt,
  runAssetGridStagger,
  runModalEntranceChoreography,
  useGsapMagnetic,
  useGsapSpotlight,
} from "../lib/gsapEffects";
import { useBoardStore } from "../store/board";
import { useGenerationStore } from "../store/generation";
import { defaultAspectEnum, useSettingsStore } from "../store/settings";

interface MultimodalHubModalProps {
  open: boolean;
  onClose: () => void;
}

/* ── Precision Geometric SVG Icons (UI/UX Pro Max: Zero Emojis) ── */

function SvgHubPrismIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M10 2L17.5 6.3V13.7L10 18L2.5 13.7V6.3L10 2Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M10 2V10M10 10L17.5 6.3M10 10L2.5 6.3M10 10V18"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeOpacity="0.65"
      />
    </svg>
  );
}

function SvgFlowFilmIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="14" height="12" rx="2.5" stroke="#4ade80" strokeWidth="1.5" />
      <path d="M7.5 6.5L12 9L7.5 11.5V6.5Z" fill="#4ade80" />
    </svg>
  );
}

function SvgMjSailIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path
        d="M9.5 2.5C11.8 5.4 13.2 8.5 13.5 12.5H4.5C5.2 9.3 6.8 5.9 9.5 2.5Z"
        stroke="#c084fc"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M3 14.8H15" stroke="#c084fc" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function SvgMuseWaveIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path
        d="M2.5 9C4.2 5.2 6.3 5.2 8 9C9.7 12.8 11.8 12.8 13.5 9C14.3 7.1 15 6.5 15.8 7"
        stroke="#38bdf8"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="14.5" cy="4.5" r="1.3" fill="#38bdf8" />
    </svg>
  );
}

function SvgImportIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 2.5V10.5M8 10.5L5 7.5M8 10.5L11 7.5M3 13.2H13"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SvgGlobeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.8" stroke="currentColor" strokeWidth="1.35" />
      <path
        d="M2.5 8H13.5M8 2.3C9.6 4 9.6 12 8 13.7C6.4 12 6.4 4 8 2.3Z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

export function MultimodalHubModal({ open, onClose }: MultimodalHubModalProps) {
  const { t } = useLang();
  const boardId = useBoardStore((s) => s.boardId);
  const addNodeWithData = useBoardStore((s) => s.addNodeWithData);
  const addEdgeFromConnection = useBoardStore((s) => s.addEdgeFromConnection);
  const setUndoNotice = useBoardStore((s) => s.setUndoNotice);

  const imageModel = useSettingsStore((s) => s.imageModel);
  const setImageModel = useSettingsStore((s) => s.setImageModel);
  const mediaProvider = useSettingsStore((s) => s.mediaProvider);
  const setMediaProvider = useSettingsStore((s) => s.setMediaProvider);
  const defaultAspect = useSettingsStore((s) => s.defaultAspect);

  const [status, setStatus] = useState<MultimodalStatusResponse | null>(null);
  const [mjAssets, setMjAssets] = useState<MjBrowserAssetItem[]>([]);
  const [mjFolder, setMjFolder] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [importingKey, setImportingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Quick Multi-Modal Combo Pipeline builder state
  const [comboImagePrompt, setComboImagePrompt] = useState("");
  const [comboVideoPrompt, setComboVideoPrompt] = useState("");
  const [comboImageEngine, setComboImageEngine] = useState<"mj" | "banana">("mj");
  const [comboVideoEngine, setComboVideoEngine] = useState<"flow_omni" | "muse">("flow_omni");
  const [comboBusy, setComboBusy] = useState(false);

  const shellSpotRef = useGsapSpotlight<HTMLDivElement>();
  const launchBtnRef = useGsapMagnetic<HTMLButtonElement>(0.22);
  const gridRef = useRef<HTMLDivElement>(null);
  const svgBannerRef = useRef<HTMLDivElement>(null);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [st, assetsRes] = await Promise.all([
        getMultimodalStatus(),
        getMidjourneyBrowserAssets(24).catch(() => ({
          connected: false,
          items: [],
          folder: "",
        })),
      ]);
      setStatus(st);
      setMjAssets(assetsRes.items || []);
      setMjFolder(assetsRes.folder || st.midjourney.folder || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refreshAll();
  }, [open, refreshAll]);

  // GSAP Entrance Choreography (Split-word 3D headline + Bento stagger + SVG continuous signal flow)
  useEffect(() => {
    if (!open || !shellSpotRef.current) return;
    return runModalEntranceChoreography(shellSpotRef.current);
  }, [open, shellSpotRef]);

  // GSAP Wave Stagger when Midjourney thumbnails load
  useEffect(() => {
    if (!open || mjAssets.length === 0) return;
    runAssetGridStagger(gridRef.current);
  }, [open, mjAssets.length]);

  if (!open) return null;

  // GSAP Scroll-Linked Parallax on the SVG banner when scrolling the modal body or asset grid
  const handleScrollParallax = (e: React.UIEvent<HTMLElement>) => {
    if (!svgBannerRef.current) return;
    const st = e.currentTarget.scrollTop;
    gsap.to(svgBannerRef.current, {
      y: Math.min(18, st * 0.12),
      duration: 0.25,
      ease: "power2.out",
      overwrite: "auto",
    });
  };

  const pickSpawnSpot = (colX: number, baseY = 140) => {
    const cur = useBoardStore.getState().nodes;
    let y = baseY;
    for (let i = 0; i < 20; i++) {
      const hit = cur.some(
        (n) => Math.abs(n.position.x - colX) < 180 && Math.abs(n.position.y - y) < 170,
      );
      if (!hit) break;
      y += 240;
    }
    return { x: colX, y };
  };

  const handleImportMjAsset = async (
    item: MjBrowserAssetItem,
    mode: "anchor" | "shot_with_video",
    videoTarget: "flow_omni" | "muse" = "flow_omni",
  ) => {
    if (boardId === null || importingKey) return;
    setImportingKey(`${item.key}_${mode}_${videoTarget}`);
    setError(null);
    try {
      const isPortrait = item.height > item.width;
      const aspectEnum = isPortrait
        ? "IMAGE_ASPECT_RATIO_PORTRAIT"
        : "IMAGE_ASPECT_RATIO_LANDSCAPE";
      const imported = await importMidjourneyBrowserAsset({
        full_url: item.fullUrl,
        thumb_url: item.thumbUrl,
        job_id: item.jobId,
        variant_idx: item.variantIdx,
        aspect_ratio: aspectEnum,
      });

      const imgPos = pickSpawnSpot(mode === "anchor" ? 80 : 480, 120);
      const nodeTitle =
        mode === "anchor"
          ? `MJ 锚点 #${item.jobId.slice(0, 6)} v${item.variantIdx + 1}`
          : `MJ 首帧 #${item.jobId.slice(0, 6)} v${item.variantIdx + 1}`;
      const imgRfId = await addNodeWithData(
        mode === "anchor" ? "visual_asset" : "image",
        imgPos,
        {
          title: nodeTitle,
          prompt: item.alt || `Imported from Midjourney (${mjFolder || "Web"})`,
          mediaId: imported.media_id,
          mediaIds: [imported.media_id],
          variantCount: 1,
          aspectRatio: aspectEnum,
          renderedAt: new Date().toISOString(),
        },
        { status: "done" },
      );

      if (mode === "shot_with_video" && imgRfId) {
        const vidPos = pickSpawnSpot(imgPos.x + 380, imgPos.y);
        const vidAspect = isPortrait
          ? "VIDEO_ASPECT_RATIO_PORTRAIT"
          : "VIDEO_ASPECT_RATIO_LANDSCAPE";
        const vidTitle =
          videoTarget === "muse"
            ? `Muse 动态视频 (接 MJ #${item.jobId.slice(0, 6)})`
            : `Flow Omni 视频 (接 MJ #${item.jobId.slice(0, 6)})`;
        const defaultMotionPrompt =
          "Real-time 1.0x normal human speed, NOT slow motion, raw 24fps handheld live-action motion matching the reference frame, natural breathing and eye movement, NO SUBTITLES.";
        const vidRfId = await addNodeWithData(
          "video",
          vidPos,
          {
            title: vidTitle,
            prompt: defaultMotionPrompt,
            aspectRatio: vidAspect,
            variantCount: 1,
            durationS: 6,
          },
          { status: "idle" },
        );
        if (vidRfId) {
          await addEdgeFromConnection(imgRfId, vidRfId);
          setMediaProvider(videoTarget === "muse" ? "muse" : "flow");
          useGenerationStore.getState().openGenerationDialog(vidRfId, defaultMotionPrompt);
          onClose();
        }
      }

      setUndoNotice({
        text:
          mode === "anchor"
            ? `已从 Midjourney 无损导入高清原图「${nodeTitle}」(${Math.round(imported.size / 1024)}KB) 到画布`
            : `已从 Midjourney 导入首帧并自动连线创建「${videoTarget === "muse" ? "Muse" : "Flow Omni"}」视频节点`,
        canUndo: true,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImportingKey(null);
    }
  };

  const handleLaunchComboPipeline = async () => {
    if (boardId === null || comboBusy) return;
    if (!comboImagePrompt.trim()) {
      setError(t("请先输入首帧画面描述。", "Please enter a keyframe image prompt."));
      return;
    }
    setComboBusy(true);
    setError(null);
    try {
      const imgAspect = defaultAspectEnum("image", defaultAspect);
      const vidAspect = defaultAspectEnum("video", defaultAspect);
      const imgPos = pickSpawnSpot(460, 160);
      const vidPos = pickSpawnSpot(860, imgPos.y);

      const useMj = comboImageEngine === "mj";
      setImageModel(useMj ? "MIDJOURNEY_V7" : "NANO_BANANA_PRO");

      const imgTitle = useMj
        ? t("MJ V7 分镜首帧", "MJ V7 Keyframe")
        : t("Banana 0c 分镜首帧", "Banana Keyframe");
      const imgRfId = await addNodeWithData(
        "image",
        imgPos,
        {
          title: imgTitle,
          prompt: comboImagePrompt.trim(),
          aspectRatio: imgAspect,
          variantCount: 1,
        },
        { status: "queued" },
      );
      if (!imgRfId) throw new Error("Failed to create image node");

      const vidTitle =
        comboVideoEngine === "muse"
          ? t("Muse 10s 多模态视频", "Muse 10s Video")
          : t("Flow Omni 1.0x 视频", "Flow Omni Video");
      const finalVidPrompt =
        comboVideoPrompt.trim() ||
        "Real-time 1.0x normal human speed, NOT slow motion, raw 24fps handheld documentary motion continuing from the keyframe, natural breathing and subtle camera push-in, NO SUBTITLES.";
      const vidRfId = await addNodeWithData(
        "video",
        vidPos,
        {
          title: vidTitle,
          prompt: finalVidPrompt,
          aspectRatio: vidAspect,
          variantCount: 1,
          durationS: 6,
        },
        { status: "idle" },
      );
      if (vidRfId) {
        await addEdgeFromConnection(imgRfId, vidRfId);
      }

      await useGenerationStore.getState().dispatchGeneration(imgRfId, {
        prompt: comboImagePrompt.trim(),
        kind: "image",
        aspectRatio: imgAspect,
        mediaProvider: useMj ? "midjourney" : "flow",
        variantCount: 1,
      });

      setUndoNotice({
        text: `已创建「${imgTitle} ➔ ${vidTitle}」多模态双节点流水线并启动首帧生图`,
        canUndo: true,
      });
      setComboImagePrompt("");
      setComboVideoPrompt("");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setComboBusy(false);
    }
  };

  const headlineTokens = [
    t("多模态三引擎制片协同台", "Multi-Modal Tri-Engine Studio"),
    "·",
    "Google Flow",
    "×",
    "Midjourney V7",
    "×",
    "Meta Muse",
  ];

  return createPortal(
    <div
      className="mm-studio-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={shellSpotRef}
        className="mm-studio-shell gsap-spotlight-surface"
        role="dialog"
        aria-modal="true"
        aria-label="Multi-Modal Tri-Engine Co-Pilot"
      >
        {/* Header with GSAP 3D Split-Word Reveal */}
        <div className="mm-studio-header">
          <div className="mm-studio-title-group">
            <span className="mm-studio-emblem">
              <SvgHubPrismIcon />
            </span>
            <div>
              <div className="mm-studio-headline">
                {headlineTokens.map((tok, idx) => (
                  <span key={idx} className="gsap-split-word">
                    {tok}
                  </span>
                ))}
              </div>
              <div className="mm-studio-subhead">
                {t(
                  "跨 Chrome 窗口实时桥接 · Midjourney 467KB+ 原始高清导图 · Omni 1.2 / Muse 10s 有声视频无缝接力",
                  "Cross-Profile Chrome Bridge · Lossless MJ JPEG Import · Flow Omni 1.2 & Meta Muse Relay",
                )}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              className="mm-btn"
              onClick={() => void refreshAll()}
              disabled={loading}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M13.5 8A5.5 5.5 0 1 1 11.8 4M13.5 2.5V5.5H10.5"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span>{loading ? t("同步中…", "Syncing…") : t("刷新桥接状态", "Refresh")}</span>
            </button>
            <button
              type="button"
              className="settings-panel__close"
              onClick={onClose}
              aria-label={t("关闭", "Close")}
            >
              ×
            </button>
          </div>
        </div>

        <div className="mm-studio-body" onScroll={handleScrollParallax}>
          {error && (
            <div className="settings-panel__project-error" style={{ margin: 0 }}>
              {error}
            </div>
          )}

          {/* GSAP Animated SVG Signal Architecture Banner (Scroll-Parallax Linked) */}
          <div ref={svgBannerRef} className="mm-svg-flow-banner">
            <svg
              className="mm-svg-flow-diagram"
              viewBox="0 0 880 54"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-label="Tri-Engine Signal Architecture"
            >
              <defs>
                <linearGradient id="mmGradLeft" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#c084fc" />
                  <stop offset="100%" stopColor="#38bdf8" />
                </linearGradient>
                <linearGradient id="mmGradRight" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#38bdf8" />
                  <stop offset="100%" stopColor="#4ade80" />
                </linearGradient>
              </defs>

              {/* Base subtle paths */}
              <path
                d="M165 15 C 245 15, 265 27, 345 27"
                stroke="rgba(192, 132, 252, 0.2)"
                strokeWidth="1.5"
              />
              <path
                d="M165 39 C 245 39, 265 27, 345 27"
                stroke="rgba(74, 222, 128, 0.2)"
                strokeWidth="1.5"
              />
              <path
                d="M525 27 C 595 27, 615 15, 695 15"
                stroke="rgba(74, 222, 128, 0.22)"
                strokeWidth="1.5"
              />
              <path
                d="M525 27 C 595 27, 615 39, 695 39"
                stroke="rgba(56, 189, 248, 0.22)"
                strokeWidth="1.5"
              />

              {/* GSAP Animated Signal Flow overlays */}
              <path
                className="gsap-svg-flow-line"
                d="M165 15 C 245 15, 265 27, 345 27"
                stroke="url(#mmGradLeft)"
                strokeWidth="2"
                strokeDasharray="8 16"
                strokeLinecap="round"
              />
              <path
                className="gsap-svg-flow-line"
                d="M165 39 C 245 39, 265 27, 345 27"
                stroke="#4ade80"
                strokeWidth="1.8"
                strokeDasharray="6 18"
                strokeLinecap="round"
              />
              <path
                className="gsap-svg-flow-line"
                d="M525 27 C 595 27, 615 15, 695 15"
                stroke="url(#mmGradRight)"
                strokeWidth="2"
                strokeDasharray="8 16"
                strokeLinecap="round"
              />
              <path
                className="gsap-svg-flow-line"
                d="M525 27 C 595 27, 615 39, 695 39"
                stroke="#38bdf8"
                strokeWidth="2"
                strokeDasharray="8 16"
                strokeLinecap="round"
              />

              {/* Left Source Nodes */}
              <rect
                x="8"
                y="4"
                width="156"
                height="21"
                rx="6"
                fill="rgba(168, 85, 247, 0.14)"
                stroke="rgba(192, 132, 252, 0.45)"
              />
              <circle className="gsap-svg-node-pulse" cx="20" cy="14.5" r="3.5" fill="#c084fc" />
              <text x="30" y="18" fill="#e9d5ff" fontSize="10.5" fontWeight="600">
                Midjourney V7 · 定妆首帧
              </text>

              <rect
                x="8"
                y="29"
                width="156"
                height="21"
                rx="6"
                fill="rgba(34, 197, 94, 0.11)"
                stroke="rgba(74, 222, 128, 0.38)"
              />
              <circle className="gsap-svg-node-pulse" cx="20" cy="39.5" r="3.5" fill="#4ade80" />
              <text x="30" y="43" fill="#bbf7d0" fontSize="10.5" fontWeight="600">
                Nano Banana Pro · 0c融图
              </text>

              {/* Center Fusion Hub */}
              <rect
                x="345"
                y="9"
                width="180"
                height="36"
                rx="9"
                fill="rgba(30, 41, 59, 0.85)"
                stroke="rgba(148, 163, 184, 0.42)"
              />
              <circle className="gsap-svg-node-pulse" cx="364" cy="27" r="4.5" fill="#a78bfa" />
              <text x="376" y="24" fill="#f8fafc" fontSize="11" fontWeight="600">
                Lube 画布统一资产总线
              </text>
              <text x="376" y="37" fill="#94a3b8" fontSize="9.5">
                自动跨项目 maseQ 同步 + 尾帧接力
              </text>

              {/* Right Video Target Nodes */}
              <rect
                x="696"
                y="4"
                width="176"
                height="21"
                rx="6"
                fill="rgba(34, 197, 94, 0.12)"
                stroke="rgba(74, 222, 128, 0.42)"
              />
              <circle className="gsap-svg-node-pulse" cx="708" cy="14.5" r="3.5" fill="#4ade80" />
              <text x="718" y="18" fill="#dcfce7" fontSize="10.5" fontWeight="600">
                Flow Omni 1.2 · 1.0x原速
              </text>

              <rect
                x="696"
                y="29"
                width="176"
                height="21"
                rx="6"
                fill="rgba(56, 189, 248, 0.13)"
                stroke="rgba(56, 189, 248, 0.42)"
              />
              <circle className="gsap-svg-node-pulse" cx="708" cy="39.5" r="3.5" fill="#38bdf8" />
              <text x="718" y="43" fill="#e0f2fe" fontSize="10.5" fontWeight="600">
                Meta Muse · 10s有声视频
              </text>
            </svg>
          </div>

          {/* Section 1: 3-Engine Bento Grid */}
          <div className="mm-bento-grid">
            {/* Card 1: Google Flow */}
            <div className="mm-engine-card mm-engine-card--flow gsap-bento-card">
              <div>
                <div className="mm-engine-card__head">
                  <span className="mm-engine-card__title">
                    <SvgFlowFilmIcon />
                    <span>Google Flow (AI Ultra)</span>
                  </span>
                  <span className="mm-status-badge mm-status-badge--live">
                    <span className="mm-status-dot" />
                    <span>{status?.flow.tab_connected ? "网页已连" : "待连接"}</span>
                  </span>
                </div>
                <div style={{ fontSize: 11.5, color: "#94a3b8", lineHeight: 1.5, marginTop: 8 }}>
                  负责 <strong style={{ color: "#e2e8f0" }}>Nano Banana Pro 0积分融图</strong> 与{" "}
                  <strong style={{ color: "#e2e8f0" }}>Omni 1.2 Flash / Veo 3.1</strong> 1.0x 原速连续视频接力。
                  <div
                    style={{
                      marginTop: 5,
                      color: "#64748b",
                      fontFamily: "ui-monospace, monospace",
                      fontSize: 10.5,
                    }}
                  >
                    UUID: {(status?.flow.pinned_project_id || "未绑定").slice(0, 22)}…
                  </div>
                </div>
              </div>
              <button
                type="button"
                className={`mm-btn${mediaProvider === "flow" && imageModel !== "MIDJOURNEY_V7" ? " mm-btn--flow" : ""}`}
                style={{ width: "100%" }}
                onClick={() => {
                  setMediaProvider("flow");
                  setImageModel("NANO_BANANA_PRO");
                }}
              >
                {mediaProvider === "flow" && imageModel !== "MIDJOURNEY_V7"
                  ? "当前默认：Flow 实拍 + Banana 0c"
                  : "设为默认生图/生视频通道"}
              </button>
            </div>

            {/* Card 2: Midjourney */}
            <div className="mm-engine-card mm-engine-card--mj gsap-bento-card">
              <div>
                <div className="mm-engine-card__head">
                  <span className="mm-engine-card__title">
                    <SvgMjSailIcon />
                    <span>Midjourney V7 · 网页桥接</span>
                  </span>
                  <span className="mm-status-badge mm-status-badge--mj">
                    <span className="mm-status-dot" />
                    <span>
                      {status?.midjourney.tab_connected
                        ? `已连 (${status.midjourney.visible_image_count}张)`
                        : "V7 引擎就绪"}
                    </span>
                  </span>
                </div>
                <div style={{ fontSize: 11.5, color: "#94a3b8", lineHeight: 1.5, marginTop: 8 }}>
                  负责 <strong style={{ color: "#e2e8f0" }}>电影级人物定妆、场景母版与高质感首帧</strong>
                  ，支持从已打开的 Midjourney 文件夹无损拉取原图。
                  <div style={{ marginTop: 5, color: "#c084fc", fontSize: 10.5 }}>
                    {mjFolder ? `活跃文件夹: ${mjFolder}` : "参数: --v 7 --style raw --oref"}
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  className={`mm-btn${imageModel === "MIDJOURNEY_V7" ? " mm-btn--primary" : ""}`}
                  style={{ flex: 1 }}
                  onClick={() => {
                    setImageModel("MIDJOURNEY_V7");
                    if (mediaProvider === "dry_run") setMediaProvider("flow");
                  }}
                >
                  {imageModel === "MIDJOURNEY_V7" ? "已启用 MJ V7 生图" : "启用 MJ V7 生图"}
                </button>
                <button
                  type="button"
                  className="mm-btn"
                  onClick={() =>
                    void openMultimodalTab({ target: "midjourney", focus: true }).then(() =>
                      refreshAll(),
                    )
                  }
                >
                  <SvgGlobeIcon />
                  <span>MJ网页</span>
                </button>
              </div>
            </div>

            {/* Card 3: Meta Muse */}
            <div className="mm-engine-card mm-engine-card--muse gsap-bento-card">
              <div>
                <div className="mm-engine-card__head">
                  <span className="mm-engine-card__title">
                    <SvgMuseWaveIcon />
                    <span>Meta Muse · 有声视频协同</span>
                  </span>
                  <span className="mm-status-badge mm-status-badge--muse">
                    <span className="mm-status-dot" />
                    <span>
                      {status?.muse.tab_ready
                        ? "muse.ai 已连"
                        : status?.muse.copilot_fallback_active
                        ? "双引擎协同就绪"
                        : "待连接"}
                    </span>
                  </span>
                </div>
                <div style={{ fontSize: 11.5, color: "#94a3b8", lineHeight: 1.5, marginTop: 8 }}>
                  负责 <strong style={{ color: "#e2e8f0" }}>10秒自然开口对白视频 (Make Photo Talk)</strong>{" "}
                  与多图合成；未打开网页时自动启用 Muse × Flow 协同兜底。
                  <div style={{ marginTop: 5, color: "#7dd3fc", fontSize: 10.5 }}>
                    {status?.muse.tab_connected
                      ? status.muse.login_required
                        ? "muse.ai 已打开（登录后直连）"
                        : "muse.ai 网页直连已激活"
                      : "已开启零超时自动协同保护"}
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  className={`mm-btn${mediaProvider === "muse" ? " mm-btn--muse" : ""}`}
                  style={{ flex: 1 }}
                  onClick={() => setMediaProvider(mediaProvider === "muse" ? "flow" : "muse")}
                >
                  {mediaProvider === "muse" ? "当前通道：Meta Muse" : "切换为 Muse 通道"}
                </button>
                <button
                  type="button"
                  className="mm-btn"
                  onClick={() =>
                    void openMultimodalTab({ target: "muse", focus: true }).then(() =>
                      refreshAll(),
                    )
                  }
                >
                  <SvgGlobeIcon />
                  <span>打开Muse</span>
                </button>
              </div>
            </div>
          </div>

          {/* Section 2: 1-Click Multi-Modal Relay Pipeline Builder */}
          <div className="mm-pipeline-box gsap-pipeline-panel">
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 8,
                marginBottom: 10,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: "#f1f5f9",
                    letterSpacing: "-0.01em",
                  }}
                >
                  {t(
                    "一键多模态双节点接力（左列定妆首帧 ➔ 右列动态视频自动连线开拍）",
                    "1-Click Multi-Modal Dual-Node Relay (Keyframe ➔ Video)",
                  )}
                </span>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <button
                  type="button"
                  className={`mm-btn${comboImageEngine === "mj" ? " mm-btn--primary" : ""}`}
                  onClick={() => setComboImageEngine("mj")}
                >
                  <SvgMjSailIcon />
                  <span>首帧: MJ V7</span>
                </button>
                <button
                  type="button"
                  className={`mm-btn${comboImageEngine === "banana" ? " mm-btn--flow" : ""}`}
                  onClick={() => setComboImageEngine("banana")}
                >
                  <SvgFlowFilmIcon />
                  <span>首帧: Banana 0c</span>
                </button>
                <span style={{ color: "#64748b", fontSize: 12 }}>➔</span>
                <button
                  type="button"
                  className={`mm-btn${comboVideoEngine === "flow_omni" ? " mm-btn--flow" : ""}`}
                  onClick={() => setComboVideoEngine("flow_omni")}
                >
                  <SvgFlowFilmIcon />
                  <span>视频: Flow Omni 1.2</span>
                </button>
                <button
                  type="button"
                  className={`mm-btn${comboVideoEngine === "muse" ? " mm-btn--muse" : ""}`}
                  onClick={() => setComboVideoEngine("muse")}
                >
                  <SvgMuseWaveIcon />
                  <span>视频: Meta Muse</span>
                </button>
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr auto",
                gap: 8,
                alignItems: "center",
              }}
            >
              <input
                type="text"
                className="settings-panel__project-input"
                placeholder="1. 输入首帧画面描述（如：阳光雪松门廊下老母亲手持牛皮账本与儿子对峙）"
                value={comboImagePrompt}
                onChange={(e) => setComboImagePrompt(e.target.value)}
              />
              <input
                type="text"
                className="settings-panel__project-input"
                placeholder="2. 可选：下游视频动作与台词（留空默认 1.0x 原速自然跟拍）"
                value={comboVideoPrompt}
                onChange={(e) => setComboVideoPrompt(e.target.value)}
              />
              <button
                ref={launchBtnRef}
                type="button"
                className="mm-btn mm-btn--primary"
                disabled={comboBusy || !comboImagePrompt.trim()}
                onClick={() => void handleLaunchComboPipeline()}
                style={{ padding: "8px 15px", whiteSpace: "nowrap" }}
              >
                <span>{comboBusy ? "创建中…" : "创建双节点并开拍"}</span>
              </button>
            </div>
          </div>

          {/* Section 3: Live Midjourney Browser Tab Asset Grid with GSAP 3D Tilt & Wave Stagger */}
          <div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 9,
              }}
            >
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: "#f1f5f9" }}>
                  {t(
                    `Midjourney 网页实时高清图库${mjFolder ? ` · ${mjFolder}` : ""}`,
                    "Live Midjourney Tab High-Res Assets",
                  )}
                </div>
                <div style={{ fontSize: 11, color: "#8a8f98", marginTop: 2 }}>
                  {t(
                    "实时同步 Chrome 已打开的 www.midjourney.com 页面，点击一键拉取 467KB+ 原始 .jpeg 上画布并直连视频节点",
                    "Synced directly from your open www.midjourney.com tab in Chrome.",
                  )}
                </div>
              </div>
              <span className="mm-status-badge mm-status-badge--mj">
                <span className="mm-status-dot" />
                <span>
                  {mjAssets.length > 0
                    ? `已就绪 ${mjAssets.length} 张原图`
                    : "未检测到 MJ 页面"}
                </span>
              </span>
            </div>

            {mjAssets.length === 0 ? (
              <div
                style={{
                  padding: 24,
                  textAlign: "center",
                  background: "rgba(255,255,255,0.02)",
                  border: "1px dashed rgba(255,255,255,0.12)",
                  borderRadius: 12,
                  color: "#94a3b8",
                  fontSize: 12.5,
                }}
              >
                当前未读取到 Midjourney 网页画面。请点击上方「MJ网页」打开你的 Midjourney 页面后再点「刷新桥接状态」。
              </div>
            ) : (
              <div ref={gridRef} className="mm-mj-grid" onScroll={handleScrollParallax}>
                {mjAssets.map((item) => {
                  const busyAnchor = importingKey === `${item.key}_anchor_flow_omni`;
                  const busyFlowVid = importingKey === `${item.key}_shot_with_video_flow_omni`;
                  const busyMuseVid = importingKey === `${item.key}_shot_with_video_muse`;
                  return (
                    <div
                      key={item.key}
                      className="mm-mj-card gsap-mj-card"
                      onPointerMove={(e) => attachGsapCardTilt(e.currentTarget, e, 4)}
                      onPointerLeave={(e) => resetGsapCardTilt(e.currentTarget)}
                    >
                      <div className="mm-mj-card__media">
                        <img
                          src={item.thumbUrl}
                          alt={item.alt || item.key}
                          loading="lazy"
                        />
                        <span className="mm-mj-card__tag">
                          #{item.jobId.slice(0, 6)} · v{item.variantIdx + 1}
                        </span>
                      </div>
                      <div className="mm-mj-card__actions">
                        <button
                          type="button"
                          className="mm-btn"
                          disabled={Boolean(importingKey)}
                          onClick={() => void handleImportMjAsset(item, "anchor", "flow_omni")}
                          style={{ width: "100%" }}
                        >
                          <SvgImportIcon />
                          <span>{busyAnchor ? "无损拉取中…" : "导入为画布锚点/分镜"}</span>
                        </button>
                        <div style={{ display: "flex", gap: 5 }}>
                          <button
                            type="button"
                            className="mm-btn mm-btn--flow"
                            disabled={Boolean(importingKey)}
                            onClick={() =>
                              void handleImportMjAsset(item, "shot_with_video", "flow_omni")
                            }
                            style={{ flex: 1, fontSize: 10.5, padding: "4px 6px" }}
                            title="无损导入此 MJ 原图并自动连线创建 Flow Omni 1.2 视频节点"
                          >
                            <SvgFlowFilmIcon />
                            <span>{busyFlowVid ? "连线中…" : "接 Flow 视频"}</span>
                          </button>
                          <button
                            type="button"
                            className="mm-btn mm-btn--muse"
                            disabled={Boolean(importingKey)}
                            onClick={() =>
                              void handleImportMjAsset(item, "shot_with_video", "muse")
                            }
                            style={{ flex: 1, fontSize: 10.5, padding: "4px 6px" }}
                            title="无损导入此 MJ 原图并自动连线创建 Meta Muse 视频节点"
                          >
                            <SvgMuseWaveIcon />
                            <span>{busyMuseVid ? "连线中…" : "接 Muse 视频"}</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
