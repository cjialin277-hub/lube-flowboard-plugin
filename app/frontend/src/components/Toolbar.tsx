import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useReactFlow } from "@xyflow/react";
import {
  applyDirectorTemplate,
  assembleBoardMaster,
  getShortDramaMemory,
  listDirectorTemplates,
  mediaUrl,
  mountShortDramaCast,
  type DirectorTemplateDTO,
  type ShortDramaMemoryResponse,
} from "../api/client";
import { useBoardStore } from "../store/board";
import { WALLPAPER_PRESETS, useSettingsStore } from "../store/settings";
import { ActivityBell } from "./activity/ActivityBell";
import { AiProviderBadge } from "./AiProviderBadge";
import { MultimodalHubModal } from "./MultimodalHubModal";
import { useGsapMagnetic } from "../lib/gsapEffects";
import { BRAND_NAME_EN, BRAND_NAME_ZH, displayBoardName, useLang } from "../i18n";

type TemplateTargetMode = "new_board" | "append" | "replace";

export function Toolbar() {
  const boardId = useBoardStore((s) => s.boardId);
  const boardName = useBoardStore((s) => s.boardName);
  const renameBoard = useBoardStore((s) => s.renameBoard);
  const refreshBoardState = useBoardStore((s) => s.refreshBoardState);
  const createNewBoard = useBoardStore((s) => s.createNewBoard);
  const mediaProvider = useSettingsStore((s) => s.mediaProvider);
  const setMediaProvider = useSettingsStore((s) => s.setMediaProvider);
  const defaultAspect = useSettingsStore((s) => s.defaultAspect);
  const setDefaultAspect = useSettingsStore((s) => s.setDefaultAspect);
  const themeMode = useSettingsStore((s) => s.themeMode);
  const toggleThemeMode = useSettingsStore((s) => s.toggleThemeMode);
  const wallpaperId = useSettingsStore((s) => s.wallpaperId);
  const setWallpaperId = useSettingsStore((s) => s.setWallpaperId);
  const cycleWallpaper = useSettingsStore((s) => s.cycleWallpaper);
  const activeWallpaper = WALLPAPER_PRESETS.find((w) => w.id === wallpaperId) ?? null;
  const { fitView } = useReactFlow();
  const { lang, toggleLang, t } = useLang();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Upgrade 3: Master Assembly state
  const [assembling, setAssembling] = useState(false);

  // Upgrade 5: Director Template & Short-Drama Memory dropdown state
  const [tplOpen, setTplOpen] = useState(false);
  const [tplLoading, setTplLoading] = useState(false);
  const [applyingSeq, setApplyingSeq] = useState<string | null>(null);
  const [templates, setTemplates] = useState<DirectorTemplateDTO[]>([]);
  const [sdMemory, setSdMemory] = useState<ShortDramaMemoryResponse | null>(null);
  const [mountingCast, setMountingCast] = useState(false);
  const [tplMode, setTplMode] = useState<TemplateTargetMode>("new_board");
  const tplMenuRef = useRef<HTMLDivElement>(null);

  // Lightweight toolbar feedback banner
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [mmOpen, setMmOpen] = useState(false);
  const [wpMenuOpen, setWpMenuOpen] = useState(false);
  const wpMenuRef = useRef<HTMLDivElement>(null);
  const mmBtnRef = useGsapMagnetic<HTMLButtonElement>(0.22);
  const masterBtnRef = useGsapMagnetic<HTMLButtonElement>(0.22);

  useEffect(() => {
    if (!wpMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (wpMenuRef.current && !wpMenuRef.current.contains(e.target as Node)) {
        setWpMenuOpen(false);
      }
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setWpMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [wpMenuOpen]);

  const isDryRun = mediaProvider === "dry_run";

  useEffect(() => {
    const onOpenHub = () => setMmOpen(true);
    window.addEventListener("flowboard:open-multimodal-hub", onOpenHub);
    return () => window.removeEventListener("flowboard:open-multimodal-hub", onOpenHub);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6500);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!tplOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (tplMenuRef.current && !tplMenuRef.current.contains(e.target as Node)) {
        setTplOpen(false);
      }
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setTplOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [tplOpen]);

  function startEdit() {
    setDraft(displayBoardName(boardName, lang));
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.select());
  }

  function commitEdit() {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== boardName) {
      renameBoard(trimmed);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") inputRef.current?.blur();
    if (e.key === "Escape") {
      setEditing(false);
    }
  }

  function toggleDryRun() {
    setMediaProvider(isDryRun ? "flow" : "dry_run");
  }

  async function toggleTemplateMenu() {
    const next = !tplOpen;
    setTplOpen(next);
    if (next && (templates.length === 0 || !sdMemory)) {
      setTplLoading(true);
      try {
        const [tplRes, memRes] = await Promise.all([
          listDirectorTemplates(),
          getShortDramaMemory().catch(() => null),
        ]);
        setTemplates(tplRes.items ?? []);
        if (memRes) setSdMemory(memRes);
      } catch (err) {
        setNotice({
          kind: "err",
          text: err instanceof Error ? err.message : t("读取导演模板失败", "Failed to load director templates"),
        });
      } finally {
        setTplLoading(false);
      }
    }
  }

  async function handleMountCast() {
    if (mountingCast || boardId === null) return;
    setMountingCast(true);
    try {
      const res = await mountShortDramaCast(boardId, { upload_to_flow: true });
      await refreshBoardState();
      setTplOpen(false);
      setTimeout(() => {
        void fitView({ padding: 0.2, duration: 240 });
      }, 100);
      setNotice({
        kind: "ok",
        text: t(
          `已将 Cole Family 四人纯白底角色锚点（${res.mounted_count} 人）挂载到当前画布`,
          `Mounted ${res.mounted_count} Cole Family pure-white character anchors`,
        ),
      });
    } catch (err) {
      setNotice({
        kind: "err",
        text: err instanceof Error ? err.message : t("挂载短剧角色失败", "Failed to mount cast"),
      });
    } finally {
      setMountingCast(false);
    }
  }

  async function handleApplyTemplate(tpl: DirectorTemplateDTO) {
    if (applyingSeq) return;
    setApplyingSeq(tpl.seq_id);
    try {
      let targetBoardId = boardId;
      if (tplMode === "new_board" || targetBoardId === null) {
        const shortName = tpl.name.split("（")[0].slice(0, 24);
        const createdId = await createNewBoard(`${tpl.seq_id} · ${shortName}`);
        if (createdId === null) {
          throw new Error(t("新建画布失败", "Failed to create board"));
        }
        targetBoardId = createdId;
      }
      const res = await applyDirectorTemplate(targetBoardId, {
        seq_id: tpl.seq_id,
        clear_existing: tplMode === "replace",
      });
      await refreshBoardState();
      setTplOpen(false);
      setTimeout(() => {
        void fitView({ padding: 0.2, duration: 260 });
      }, 120);
      setNotice({
        kind: "ok",
        text: t(
          `已套用 ${res.seq_id}（铺设 ${res.created_nodes} 个节点 · ${res.step_count} 镜）`,
          `Applied ${res.seq_id} (${res.created_nodes} nodes, ${res.step_count} shots)`,
        ),
      });
    } catch (err) {
      setNotice({
        kind: "err",
        text: err instanceof Error ? err.message : t("套用模板失败", "Failed to apply template"),
      });
    } finally {
      setApplyingSeq(null);
    }
  }

  async function handleAssembleMaster() {
    if (boardId === null || assembling) return;
    setAssembling(true);
    try {
      const res = await assembleBoardMaster(boardId, {
        export_jianying: true,
        copy_to_jianying_dir: true,
      });
      await refreshBoardState();
      const draftMsg = res.jianying_installed_path
        ? t("，已同步至剪映草稿箱", ", synced to Jianying drafts")
        : res.jianying_draft_path
        ? t("，已导出剪映草稿包", ", Jianying draft exported")
        : "";
      setNotice({
        kind: "ok",
        text: t(
          `✅ 合成完成：${res.clip_count} 镜 · ${res.duration_s}s（1.0x 无字幕 +4dB）${draftMsg}`,
          `✅ Master assembled: ${res.clip_count} clips · ${res.duration_s}s${draftMsg}`,
        ),
      });
    } catch (err) {
      setNotice({
        kind: "err",
        text: err instanceof Error ? err.message : t("合成总成片失败", "Master assembly failed"),
      });
    } finally {
      setAssembling(false);
    }
  }

  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <span className="toolbar-brand-mark" aria-hidden="true">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="12" height="10" rx="2" />
            <path d="M5.5 3v10M10.5 3v10M2 6.5h3.5M10.5 6.5H14M2 9.5h3.5M10.5 9.5H14" />
          </svg>
        </span>
        <span className="toolbar-wordmark">{lang === "zh" ? BRAND_NAME_ZH : BRAND_NAME_EN}</span>
        <span className="toolbar-version-pill">2.7</span>
        <span className="toolbar-sep" aria-hidden="true">/</span>
        {editing ? (
          <input
            ref={inputRef}
            className="toolbar-name-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={onKeyDown}
            aria-label={t("画布名称", "Board name")}
          />
        ) : (
          <button
            className="toolbar-name-btn"
            onClick={startEdit}
            aria-label={t("重命名画布", "Rename board")}
            title={t("点击重命名画布", "Click to rename")}
          >
            {displayBoardName(boardName, lang)}
          </button>
        )}
      </div>

      {notice && (
        <div
          className={`toolbar-toast-banner toolbar-toast-banner--${notice.kind}`}
          role="status"
        >
          <span>{notice.text}</span>
          <button
            type="button"
            className="toolbar-toast-banner__close"
            onClick={() => setNotice(null)}
            aria-label={t("关闭提示", "Dismiss")}
          >
            ×
          </button>
        </div>
      )}

      <div className="toolbar-actions">
        {/* Group 1: Production */}
        <div className="toolbar-group">
          <div className="toolbar-dropdown-wrap" ref={tplMenuRef}>
            <button
              type="button"
              className={`toolbar-action-btn${tplOpen ? " toolbar-action-btn--active" : ""}`}
              onClick={() => void toggleTemplateMenu()}
              title={t("从沙漏母库一键铺设四列导演分镜模板", "Apply Hourglass SEQ-xxx 4-column template")}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="2" y="2.5" width="5" height="5" rx="1" />
                <rect x="9" y="2.5" width="5" height="5" rx="1" />
                <rect x="2" y="9" width="5" height="4.5" rx="1" />
                <rect x="9" y="9" width="5" height="4.5" rx="1" />
              </svg>
              <span>{t("短剧记忆 · 模板", "Memory & Templates")}</span>
              <svg className="toolbar-caret" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 6l4 4 4-4" />
              </svg>
            </button>

            {tplOpen && (
              <div className="toolbar-tpl-menu" role="dialog" aria-label={t("短剧记忆与沙漏导演模板", "Short-Drama Memory & Director Templates")}>
                <div className="toolbar-tpl-menu__header">
                  <div>
                    <div className="toolbar-tpl-menu__title">
                      {t("Cornerstone 短剧记忆母库 & 沙漏分镜模板 (SEQ-xxx)", "Cornerstone Short-Drama Memory & Hourglass Templates")}
                    </div>
                    <div className="toolbar-tpl-menu__sub">
                      {t("已接入 4 层沙漏知识库 + Harness²/RRSI 原则引擎 + Cole Family 四人纯白底常驻角色资产", "Connected to 4-Layer Hourglass KB + Harness²/RRSI Guardrails + Cole Family White Assets")}
                    </div>
                  </div>
                  <div className="toolbar-tpl-mode-row" role="group" aria-label={t("铺板方式", "Target mode")}>
                    <button
                      type="button"
                      className={`source-select-mini${tplMode === "new_board" ? " first-last-cand__btn--active" : ""}`}
                      onClick={() => setTplMode("new_board")}
                    >
                      {t("新建画布", "New board")}
                    </button>
                    <button
                      type="button"
                      className={`source-select-mini${tplMode === "append" ? " first-last-cand__btn--active" : ""}`}
                      onClick={() => setTplMode("append")}
                    >
                      {t("追加当前", "Append")}
                    </button>
                    <button
                      type="button"
                      className={`source-select-mini${tplMode === "replace" ? " first-last-cand__btn--active" : ""}`}
                      onClick={() => setTplMode("replace")}
                    >
                      {t("清空覆写", "Replace")}
                    </button>
                  </div>
                </div>

                {sdMemory && (
                  <div
                    style={{
                      padding: "10px 14px",
                      borderBottom: "1px solid var(--border)",
                      background: "rgba(99, 102, 241, 0.06)",
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text)" }}>
                        {t("常驻纯白底角色库 (Cole Family 4人) · 跨集 100% 锁脸", "Cole Family Pure-White Character Vault")}
                      </span>
                      <button
                        type="button"
                        className="source-select-mini first-last-cand__btn--active"
                        disabled={mountingCast || boardId === null}
                        onClick={() => void handleMountCast()}
                        style={{ padding: "3px 9px", fontSize: 11, cursor: "pointer" }}
                      >
                        {mountingCast
                          ? t("同步 Flow 并挂载中…", "Mounting…")
                          : t("+ 一键挂载四人白底角色到当前画布", "+ Mount 4 White-BG Roles")}
                      </button>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 6 }}>
                      {sdMemory.cast.map((c) => (
                        <div
                          key={c.role}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            padding: "5px 7px",
                            borderRadius: 7,
                            background: "var(--panel-high)",
                            border: "1px solid var(--border)",
                          }}
                          title={c.identity_lock}
                        >
                          {c.face_media_id && (
                            <img
                              src={mediaUrl(c.face_media_id)}
                              alt={c.role}
                              style={{
                                width: 28,
                                height: 28,
                                borderRadius: 6,
                                objectFit: "cover",
                                background: "#fff",
                                border: "1px solid rgba(0,0,0,0.12)",
                                flexShrink: 0,
                              }}
                            />
                          )}
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                              {c.role}
                            </div>
                            <div style={{ fontSize: 9.5, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                              {c.slot.replace(/[<>]/g, "")}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {sdMemory.active_principles.map((p) => (
                        <span
                          key={p.id}
                          style={{
                            fontSize: 10,
                            padding: "2px 6px",
                            borderRadius: 4,
                            background: "rgba(16, 185, 129, 0.14)",
                            border: "1px solid rgba(16, 185, 129, 0.35)",
                            color: "#10b981",
                            fontWeight: 600,
                          }}
                        >
                          ✓ {p.id} {p.name}
                        </span>
                      ))}
                      {sdMemory.forbidden_recent_keywords.length > 0 && (
                        <span
                          style={{
                            fontSize: 10,
                            padding: "2px 6px",
                            borderRadius: 4,
                            background: "rgba(239, 68, 68, 0.14)",
                            border: "1px solid rgba(239, 68, 68, 0.35)",
                            color: "#ef4444",
                            fontWeight: 600,
                          }}
                        >
                          ✕ 近期疲劳禁用词: {sdMemory.forbidden_recent_keywords.join(", ")}
                        </span>
                      )}
                    </div>
                  </div>
                )}

                <div className="toolbar-tpl-list">
                  {tplLoading ? (
                    <div className="toolbar-tpl-empty">{t("正在读取沙漏母库…", "Loading templates…")}</div>
                  ) : templates.length === 0 ? (
                    <div className="toolbar-tpl-empty">{t("未找到可用模板", "No templates found")}</div>
                  ) : (
                    templates.map((tpl) => {
                      const busy = applyingSeq === tpl.seq_id;
                      return (
                        <button
                          key={tpl.seq_id}
                          type="button"
                          className="toolbar-tpl-item"
                          disabled={applyingSeq !== null}
                          onClick={() => void handleApplyTemplate(tpl)}
                        >
                          <div className="toolbar-tpl-item__top">
                            <span className="toolbar-tpl-item__id">{tpl.seq_id}</span>
                            <span className="toolbar-tpl-item__badge">{tpl.score_total}{t("分", "pt")}</span>
                            <span className="toolbar-tpl-item__badge">{tpl.step_count}{t("镜", " shots")}</span>
                            <span className="toolbar-tpl-item__badge">{tpl.aspect_ratio}</span>
                            {tpl.has_first_last && (
                              <span className="toolbar-tpl-item__badge toolbar-tpl-item__badge--fl">
                                {t("⇄ 首尾帧", "⇄ Start→End")}
                              </span>
                            )}
                            {busy && (
                              <span className="toolbar-tpl-item__busy">{t("铺板中…", "Applying…")}</span>
                            )}
                          </div>
                          <div className="toolbar-tpl-item__name">{tpl.name}</div>
                          {tpl.description && (
                            <div className="toolbar-tpl-item__desc">{tpl.description}</div>
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>

          <button
            ref={mmBtnRef}
            type="button"
            className="toolbar-action-btn toolbar-action-btn--multimodal"
            onClick={() => setMmOpen(true)}
            title={t(
              "打开三引擎多模态制片协同台：一键从当前 Midjourney 网页导入高清原图、切换 MJ V7 / Meta Muse / Google Flow 跨平台接力生产",
              "Open Tri-Engine Multi-Modal Co-Pilot (Google Flow × Midjourney × Meta Muse)",
            )}
          >
            <svg width="13" height="13" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path
                d="M9 1.8L15.8 5.7V12.3L9 16.2L2.2 12.3V5.7L9 1.8Z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
              <circle cx="9" cy="9" r="2.2" fill="#38bdf8" />
            </svg>
            <span>{t("多模态协同 (MJ · Muse)", "MJ · Muse Hub")}</span>
          </button>

          <button
            ref={masterBtnRef}
            type="button"
            className={`toolbar-action-btn toolbar-action-btn--master${assembling ? " toolbar-action-btn--busy" : ""}`}
            disabled={boardId === null || assembling}
            onClick={() => void handleAssembleMaster()}
            title={t(
              "按1.0x原生帧率合成无字幕24fps全片（+4dB人声+自动闪避BGM）并导出剪映草稿",
              "Assemble 24fps zero-subtitle master (+4dB, ducked BGM) & export Jianying draft",
            )}
          >
            {assembling ? (
              <span className="toolbar-spinner" aria-hidden="true" />
            ) : (
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polygon points="5,3 13,8 5,13" />
              </svg>
            )}
            <span>{assembling ? t("合成中…", "Assembling…") : t("合成全片", "Assemble")}</span>
          </button>
        </div>

        <span className="toolbar-divider" aria-hidden="true" />

        {/* Group 2: Aspect & Provider Switch */}
        <div className="toolbar-group">
          <div
            className="toolbar-aspect-switch"
            role="group"
            aria-label={t("默认画布比例", "Default canvas aspect ratio")}
          >
            <button
              type="button"
              className={`toolbar-aspect-switch__btn${defaultAspect === "portrait" ? " toolbar-aspect-switch__btn--active" : ""}`}
              onClick={() => setDefaultAspect("portrait")}
              title={t("默认 9:16 竖屏显示与生成", "Default 9:16 Portrait")}
              aria-pressed={defaultAspect === "portrait"}
            >
              <svg width="10" height="13" viewBox="0 0 10 13" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                <rect x="1.2" y="1" width="7.6" height="11" rx="1.4" />
              </svg>
              <span>9:16</span>
            </button>
            <button
              type="button"
              className={`toolbar-aspect-switch__btn${defaultAspect === "landscape" ? " toolbar-aspect-switch__btn--active" : ""}`}
              onClick={() => setDefaultAspect("landscape")}
              title={t("默认 16:9 横屏显示与生成", "Default 16:9 Landscape")}
              aria-pressed={defaultAspect === "landscape"}
            >
              <svg width="13" height="10" viewBox="0 0 13 10" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                <rect x="1" y="1.2" width="11" height="7.6" rx="1.4" />
              </svg>
              <span>16:9</span>
            </button>
          </div>
          <button
            type="button"
            className={`toolbar-mode-pill${isDryRun ? " toolbar-mode-pill--dryrun" : ""}`}
            onClick={toggleDryRun}
            title={
              isDryRun
                ? t("当前为【干跑测试模式】：0积分本地极速合成提示词+分镜图+推镜视频，不调 Google Flow；点击切回实拍模式", "Dry-Run active (0 credits local preview). Click to switch back to live Google Flow.")
                : t("当前为【Google Flow 实拍模式】；点击一键切换为 0 积分本地【干跑测试模式】", "Live Google Flow mode. Click to switch to 0-credit local Dry-Run mode.")
            }
            aria-pressed={isDryRun}
          >
            <span className="toolbar-mode-pill__dot" aria-hidden="true" />
            <span>
              {isDryRun
                ? t("干跑 · 0积分", "Dry Run · 0c")
                : t("Flow 实拍", "Live Flow")}
            </span>
          </button>
        </div>

        <span className="toolbar-divider" aria-hidden="true" />

        {/* Group 3: Wallpaper, Daylight Theme & Utilities */}
        <div className="toolbar-group">
          <div className="toolbar-wp-wrap" ref={wpMenuRef}>
            <div className="toolbar-wp-pill">
              <button
                type="button"
                className="toolbar-wp-pill__cycle"
                onClick={() => cycleWallpaper()}
                title={t(
                  `点击循环切换 4 张萌宠画布背景（当前：${activeWallpaper ? activeWallpaper.labelZh : "无壁纸"}）`,
                  `Click to cycle 4 puppy wallpapers (Current: ${activeWallpaper ? activeWallpaper.labelEn : "None"})`,
                )}
              >
                {activeWallpaper ? (
                  <img
                    src={activeWallpaper.url}
                    alt=""
                    className="toolbar-wp-pill__thumb"
                  />
                ) : (
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                    <rect x="2" y="2.5" width="12" height="11" rx="2" />
                    <circle cx="5.8" cy="6.2" r="1.2" />
                    <path d="M2.5 11.5L6.2 8.2L9.4 10.8L11.5 9L13.5 11.5" />
                  </svg>
                )}
                <span>
                  {activeWallpaper
                    ? t(`背景 ${activeWallpaper.index}/4`, `BG ${activeWallpaper.index}/4`)
                    : t("无背景", "No BG")}
                </span>
              </button>
              <button
                type="button"
                className="toolbar-wp-pill__arrow"
                onClick={() => setWpMenuOpen((v) => !v)}
                aria-label={t("选择画布背景图", "Pick canvas wallpaper")}
                title={t("展开 4 张萌宠背景预览", "Open 4-wallpaper gallery")}
              >
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="3,4.5 6,7.5 9,4.5" />
                </svg>
              </button>
            </div>

            {wpMenuOpen && (
              <div className="toolbar-wp-popover" role="menu">
                <div className="toolbar-wp-popover__header">
                  <span>{t("画布背景切换 (4 张萌宠壁纸)", "Canvas Wallpaper (4 Presets)")}</span>
                  <button
                    type="button"
                    className="toolbar-wp-popover__next"
                    onClick={() => cycleWallpaper()}
                  >
                    {t("下一张 ↻", "Next ↻")}
                  </button>
                </div>
                <div className="toolbar-wp-popover__grid">
                  {WALLPAPER_PRESETS.map((wp) => {
                    const active = wallpaperId === wp.id;
                    return (
                      <button
                        key={wp.id}
                        type="button"
                        className={`toolbar-wp-card${active ? " toolbar-wp-card--active" : ""}`}
                        onClick={() => {
                          setWallpaperId(wp.id);
                          setWpMenuOpen(false);
                        }}
                      >
                        <img src={wp.url} alt={wp.labelZh} />
                        <span className="toolbar-wp-card__label">
                          {lang === "zh" ? wp.labelZh : wp.labelEn}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  className={`toolbar-wp-popover__clear${wallpaperId === "none" ? " toolbar-wp-popover__clear--active" : ""}`}
                  onClick={() => {
                    setWallpaperId("none");
                    setWpMenuOpen(false);
                  }}
                >
                  {t("切换为纯色网格（关闭背景图）", "Pure Grid (Hide Wallpaper)")}
                </button>
              </div>
            )}
          </div>

          <button
            type="button"
            className={`toolbar-theme-btn${themeMode === "light" ? " toolbar-theme-btn--light" : ""}`}
            onClick={() => toggleThemeMode()}
            title={
              themeMode === "light"
                ? t("当前为【白天模式】；点击切换回黑曜石夜间模式", "Daylight Mode active. Click to switch to Dark Mode.")
                : t("当前为【夜间模式】；点击切换为明亮白天模式", "Dark Mode active. Click to switch to Daylight Mode.")
            }
            aria-label={t("切换白天/夜间模式", "Toggle Daylight / Dark Mode")}
          >
            {themeMode === "light" ? (
              <svg width="13" height="13" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                <circle cx="9" cy="9" r="3.6" fill="currentColor" fillOpacity="0.2" />
                <path d="M9 1.8V3.6M9 14.4V16.2M1.8 9H3.6M14.4 9H16.2M3.9 3.9L5.2 5.2M12.8 12.8L14.1 14.1M14.1 3.9L12.8 5.2M5.2 12.8L3.9 14.1" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
                <path d="M14.5 11.4A6.2 6.2 0 0 1 6.6 3.5a6.2 6.2 0 1 0 7.9 7.9Z" />
              </svg>
            )}
            <span>{themeMode === "light" ? t("白天", "Day") : t("夜间", "Night")}</span>
          </button>

          <button
            type="button"
            className="toolbar-lang-btn"
            onClick={toggleLang}
            title={t("点击切换为英文界面 (Switch to English)", "切换为简体中文界面")}
            aria-label={t("切换语言", "Toggle language")}
          >
            {lang === "zh" ? "中 / EN" : "EN / 中"}
          </button>
          <ActivityBell />
          <AiProviderBadge />
        </div>
      </div>
      <MultimodalHubModal open={mmOpen} onClose={() => setMmOpen(false)} />
    </div>
  );
}
