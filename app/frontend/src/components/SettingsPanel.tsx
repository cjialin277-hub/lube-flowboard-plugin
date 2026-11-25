import { useEffect, useRef, useState } from "react";
import { useGenerationStore } from "../store/generation";
import {
  useSettingsStore,
  type ImageModelKey,
  type VideoQuality,
} from "../store/settings";
import {
  getPinnedFlowProject,
  setPaygateTier,
  setPinnedFlowProject,
  type PinnedFlowProject,
} from "../api/client";
import { BRAND_EDITION_EN, BRAND_EDITION_ZH, BRAND_NAME_EN, BRAND_NAME_ZH, useLang } from "../i18n";

// Loose on purpose: "is there a uuid in what they typed", not the backend's
// full project/-segment rule. Used only to enable the Save button.
const UUID_ANYWHERE =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

/**
 * Dashboard Settings popover anchored to the AccountPanel gear button.
 *
 * Surfaces the model context that drives every generation:
 *   - Paygate tier — read from FLOWBOARD_PAYGATE_TIER, read-only here.
 *     Flow's createProject stopped returning anything to detect it from
 *     in the September 2026 migration, so it is declared, not discovered.
 *   - Google Flow project — the single project uuid every board generates
 *     into. Server state (agent-side override on top of .env), so unlike
 *     everything else here it is fetched/PUT directly, never persisted to
 *     localStorage.
 *   - Video quality — Veo 3.1 Lite / Fast / Quality, plus Ultra-only
 *     Lite Relaxed / Fast Relaxed (0-credit low-priority queue). Applies
 *     to BOTH portrait and landscape; backend resolves
 *     [tier][quality][aspect] → concrete Flow model key.
 *   - Image model — Banana Pro vs Banana 2 picker. Persisted to
 *     localStorage; every gen_image / edit_image dispatch reads it.
 */

const IMAGE_MODELS: { key: ImageModelKey; label: string; hint: string }[] = [
  {
    key: "NANO_BANANA_PRO",
    label: "Nano Banana Pro",
    hint: "GEM_PIX_2 — 0 积分高精多图空间融合（推荐角色+空场首帧）",
  },
  {
    key: "MIDJOURNEY_V7",
    label: "Midjourney V7 (MJ 审美生图)",
    hint: "MJ V7 --style raw 电影级光影 · 生成后可直连右侧 Flow 拍动态视频",
  },
  {
    key: "NANO_BANANA_2",
    label: "Nano Banana 2",
    hint: "NARWHAL — 轻量快速模型",
  },
];

// Order: lite → fast → quality (paid), then the Ultra-only relaxed
// variants (0-credit low-priority queue). Lite/Fast/Quality are
// available on both Pro (Tier 1) and Ultra (Tier 2); the *_relaxed
// entries are Ultra-only — Pro users see them locked.
const VIDEO_QUALITIES: {
  key: VideoQuality;
  label: string;
  hint: string;
  ultraOnly: boolean;
}[] = [
  {
    key: "lite",
    label: "Veo 3.1 Lite",
    hint: "Fastest generation, lightest model. Applies to both 16:9 and 9:16.",
    ultraOnly: false,
  },
  {
    key: "fast",
    label: "Veo 3.1 Fast",
    hint: "Default — balanced fidelity and speed. Applies to both 16:9 and 9:16.",
    ultraOnly: false,
  },
  {
    key: "quality",
    label: "Veo 3.1 Quality",
    hint: "Highest fidelity, slowest. Best for hero shots. Applies to both 16:9 and 9:16.",
    ultraOnly: false,
  },
  {
    key: "lite_relaxed",
    label: "Veo 3.1 Lite (Low Priority)",
    hint: "Same Lite checkpoint, low-priority queue — 0 credits. Slower turnaround when Flow is busy.",
    ultraOnly: true,
  },
];

interface SettingsPanelProps {
  open: boolean;
  onClose(): void;
  // Provided by AccountPanel. Called when the user clicks "Sign out"
  // — AccountPanel owns the post-logout state reset (clear cached
  // profile, kick the /me poll). Pass undefined when no identity is
  // loaded (the button auto-hides in that case).
  onLogout?: () => Promise<void> | void;
  // True while the parent's logout call is in flight — disables the
  // button so a double-click doesn't fire two POSTs.
  logoutPending?: boolean;
  // Called after the pinned Flow project is saved or cleared, so the
  // sidebar — which shows the same pinned id — re-reads instead of
  // displaying the value the user just replaced.
  onFlowProjectChange?: () => void;
}

export function SettingsPanel({
  open,
  onClose,
  onLogout,
  logoutPending,
  onFlowProjectChange,
}: SettingsPanelProps) {
  const tier = useGenerationStore((s) => s.paygateTier);
  const imageModel = useSettingsStore((s) => s.imageModel);
  const setImageModel = useSettingsStore((s) => s.setImageModel);
  const videoQuality = useSettingsStore((s) => s.videoQuality);
  const setVideoQuality = useSettingsStore((s) => s.setVideoQuality);
  const videoModel = useSettingsStore((s) => s.videoModel);
  const setVideoModel = useSettingsStore((s) => s.setVideoModel);
  const { lang, setLang, t } = useLang();

  const panelRef = useRef<HTMLDivElement>(null);

  // Esc closes (click-outside is handled by the backdrop's onClick).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Pinned Flow project. Server state — read on open and PUT on save, never
  // mirrored into the persisted settings store, because the agent (and the
  // boards it rebinds) own it, not this browser.
  const [flowProject, setFlowProject] = useState<PinnedFlowProject | null>(null);
  const [flowProjectError, setFlowProjectError] = useState<string | null>(null);
  const [projectDraft, setProjectDraft] = useState("");
  const [projectSaving, setProjectSaving] = useState(false);
  const [projectSaveError, setProjectSaveError] = useState<string | null>(null);
  const [projectNotice, setProjectNotice] = useState<string | null>(null);
  const [tierSaving, setTierSaving] = useState(false);

  async function handleSwitchTier(nextTier: "PAYGATE_TIER_TWO" | "PAYGATE_TIER_ONE") {
    if (tierSaving || tier === nextTier) return;
    setTierSaving(true);
    try {
      await setPaygateTier(nextTier);
      useGenerationStore.setState({ paygateTier: nextTier });
    } finally {
      setTierSaving(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setFlowProject(null);
    setFlowProjectError(null);
    setProjectSaveError(null);
    setProjectNotice(null);
    getPinnedFlowProject()
      .then((p) => {
        if (!alive) return;
        setFlowProject(p);
        setProjectDraft(p.flow_project_id ?? "");
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setFlowProjectError(
          err instanceof Error ? err.message : "Could not read the pinned project",
        );
      });
    return () => {
      alive = false;
    };
  }, [open]);

  // `null` clears the override and falls back to .env; a string pins it.
  async function saveFlowProject(next: string | null) {
    if (projectSaving) return;
    setProjectSaving(true);
    setProjectSaveError(null);
    setProjectNotice(null);
    try {
      const res = await setPinnedFlowProject(next);
      setFlowProject({
        flow_project_id: res.flow_project_id,
        source: res.source,
        env_project_id: res.env_project_id,
      });
      setProjectDraft(res.flow_project_id ?? "");
      // The generation store caches the project id for the whole page load
      // and nothing else clears it. Without this the dialog says "Saved",
      // the backend rebinds the boards, and every subsequent dispatch still
      // carries the OLD uuid — which flow_sdk takes as an explicit argument
      // and never resolves, so renders keep landing in the previous Flow
      // project with no error anywhere. Exactly the failure this whole
      // setting exists to remove, one layer up.
      useGenerationStore.setState({ projectId: null });
      setProjectNotice(
        res.rebound_boards > 0
          ? `Saved — ${res.rebound_boards} board${res.rebound_boards === 1 ? "" : "s"} re-pointed at this project`
          : "Saved",
      );
      onFlowProjectChange?.();
    } catch (err) {
      // 400 detail arrives verbatim from the backend (see setPinnedFlowProject).
      setProjectSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setProjectSaving(false);
    }
  }

  const trimmedDraft = projectDraft.trim();
  const draftUuid = trimmedDraft.match(UUID_ANYWHERE)?.[0]?.toLowerCase() ?? null;
  const draftMultiAccount = trimmedDraft.match(/\/u\/\d+/)?.[0] ?? null;
  // Always allow clicking Save / Re-bind whenever a valid UUID or Flow project URL
  // (including https://flow.google.com/u/1/project/<uuid>) is present in the input.
  const canSaveProject = !!draftUuid;
  const isSameProjectRebind =
    !!draftUuid &&
    flowProject?.source === "override" &&
    draftUuid === flowProject.flow_project_id;
  const legacyEnvId =
    flowProject?.source === "env" &&
    !!flowProject.flow_project_id &&
    !UUID_ANYWHERE.test(flowProject.flow_project_id);

  if (!open) return null;

  const tierLabel = tier === "PAYGATE_TIER_TWO"
    ? "Ultra"
    : tier === "PAYGATE_TIER_ONE"
      ? "Pro"
      : "Detecting…";

  return (
    <div
      className="settings-panel-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <div className="settings-panel__header">
        <span className="settings-panel__title">{t("全局设置", "Settings")}</span>
        <button
          type="button"
          className="settings-panel__close"
          onClick={onClose}
          aria-label={t("关闭设置", "Close settings")}
        >
          ×
        </button>
      </div>

      <div className="settings-panel__section">
        <div className="settings-panel__label">{t("界面语言 / Language", "Language")}</div>
        <div className="aspect-chip-row">
          <button
            type="button"
            className={`aspect-chip${lang === "zh" ? " aspect-chip--active" : ""}`}
            onClick={() => setLang("zh")}
          >
            简体中文
          </button>
          <button
            type="button"
            className={`aspect-chip${lang === "en" ? " aspect-chip--active" : ""}`}
            onClick={() => setLang("en")}
          >
            English
          </button>
        </div>
      </div>

      <div className="settings-panel__section">
        <div className="settings-panel__label">{t("Google Flow 订阅等级", "Account tier")}</div>
        <div className="aspect-chip-row">
          <button
            type="button"
            disabled={tierSaving}
            className={`aspect-chip${tier === "PAYGATE_TIER_TWO" ? " aspect-chip--active" : ""}`}
            onClick={() => handleSwitchTier("PAYGATE_TIER_TWO")}
          >
            AI Ultra ({t("高优", "Tier 2")})
          </button>
          <button
            type="button"
            disabled={tierSaving}
            className={`aspect-chip${tier === "PAYGATE_TIER_ONE" ? " aspect-chip--active" : ""}`}
            onClick={() => handleSwitchTier("PAYGATE_TIER_ONE")}
          >
            AI Pro ({t("标准", "Tier 1")})
          </button>
        </div>
        <div className="settings-panel__hint">
          {t(`当前生效：${tierLabel}（点击即可实时切换，无需改 .env 或重启）。`, `Active: ${tierLabel} (runtime override, no restart needed).`)}
        </div>
      </div>

      {/* The one uuid every board generates into. Flow dropped project
          creation + listing in the September 2026 migration, so there is no
          way to pick one from a list — the user pastes it, and until they do
          nothing can generate. */}
      <div className="settings-panel__section">
        <div className="settings-panel__label">{t("绑定的 Google Flow 项目 UUID", "Google Flow project")}</div>
        {flowProjectError ? (
          <>
            <div className="settings-panel__project-error">{flowProjectError}</div>
            <div className="settings-panel__hint">
              Close and re-open Settings to retry.
            </div>
          </>
        ) : !flowProject ? (
          <div className="settings-panel__value settings-panel__value--readonly">
            Loading…
          </div>
        ) : (
          <>
            {flowProject.source === "none" ? (
              <div className="settings-panel__project-error">
                No Flow project is configured, so every generation will fail.
                Open a project at{" "}
                <a
                  className="settings-panel__about-link"
                  href="https://flow.google.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  flow.google.com
                </a>
                , copy its uuid out of the address bar, and paste it below.
              </div>
            ) : (
              <>
                <div className="settings-panel__value settings-panel__value--readonly">
                  <code>{flowProject.flow_project_id}</code>
                </div>
                <div className="settings-panel__hint">
                  {flowProject.source === "override"
                    ? "Set here in Settings — overrides .env."
                    : "Pinned by FLOWBOARD_FLOW_PROJECT_ID in the agent's .env."}
                </div>
              </>
            )}

            <div className="settings-panel__project-row">
              <input
                type="text"
                className="settings-panel__project-input"
                value={projectDraft}
                placeholder="粘贴 https://flow.google.com/u/1/project/... 或 UUID"
                spellCheck={false}
                autoComplete="off"
                disabled={projectSaving}
                aria-label="Flow project uuid"
                onChange={(e) => setProjectDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canSaveProject) {
                    saveFlowProject(trimmedDraft);
                  }
                }}
              />
              <button
                type="button"
                className="settings-panel__project-btn"
                disabled={projectSaving || !canSaveProject}
                onClick={() => saveFlowProject(trimmedDraft)}
              >
                {projectSaving
                  ? t("保存中…", "Saving…")
                  : isSameProjectRebind
                    ? t("重新同步", "Re-bind")
                    : t("保存替换", "Save")}
              </button>
            </div>
            {draftMultiAccount && draftUuid && (
              <div className="settings-panel__project-ok">
                {t(
                  `✓ 已识别多账号路径 ${draftMultiAccount}/ · 项目 UUID: ${draftUuid}`,
                  `✓ Detected multi-account path ${draftMultiAccount}/ · UUID: ${draftUuid}`,
                )}
              </div>
            )}

            {legacyEnvId && (
              <div className="settings-panel__hint">
                The id in <code>.env</code> is not a uuid. It still works —
                anything already pinned keeps working — but pinning it from
                here would need a uuid, so Save stays off until you paste one.
              </div>
            )}

            {flowProject.source === "override" && (
              <button
                type="button"
                className="settings-panel__project-clear"
                disabled={projectSaving}
                onClick={() => saveFlowProject(null)}
              >
                Clear override —{" "}
                {flowProject.env_project_id
                  ? `fall back to ${flowProject.env_project_id} from .env`
                  : "leaves no project configured, so generation stops working"}
              </button>
            )}

            {projectSaveError && (
              <div className="settings-panel__project-error">{projectSaveError}</div>
            )}
            {projectNotice && !projectSaveError && (
              <div className="settings-panel__project-ok">{projectNotice}</div>
            )}

            <div className="settings-panel__hint">
              {t("所有画布的生图与生视频都会发往此 Google Flow 项目；修改保存后自动迁移旧画布。", "Every board generates into this project. Saving re-points existing boards.")}
            </div>
          </>
        )}
      </div>

      {/* Single unified Video model picker — flat list of every option
          (Veo tiers + Omni Flash). Selecting a Veo row stamps both
          videoModel="veo" + the matching quality; selecting Omni Flash
          stamps videoModel="omni_flash" (duration is picked per dispatch
          in the GenerationDialog). */}
      <div className="settings-panel__section">
        <div className="settings-panel__label">{t("默认视频生成模型", "Video model")}</div>
        <div className="settings-panel__radio-group">
          {VIDEO_QUALITIES.map((q) => {
            const locked = q.ultraOnly && tier !== "PAYGATE_TIER_TWO";
            const checked = videoModel === "veo" && videoQuality === q.key;
            return (
              <label
                key={q.key}
                className={`settings-panel__radio${checked ? " settings-panel__radio--active" : ""}${locked ? " settings-panel__radio--locked" : ""}`}
              >
                <input
                  type="radio"
                  name="video-model"
                  value={`veo:${q.key}`}
                  checked={checked}
                  disabled={locked}
                  onChange={() => {
                    setVideoModel("veo");
                    setVideoQuality(q.key);
                  }}
                />
                <div>
                  <div className="settings-panel__radio-label">
                    {q.label}
                    {q.ultraOnly && (
                      <span className="model-badge">Ultra only</span>
                    )}
                  </div>
                  <div className="settings-panel__radio-hint">{q.hint}</div>
                </div>
              </label>
            );
          })}
          <label
            className={`settings-panel__radio${videoModel === "omni_flash" ? " settings-panel__radio--active" : ""}`}
          >
            <input
              type="radio"
              name="video-model"
              value="omni_flash"
              checked={videoModel === "omni_flash"}
              onChange={() => setVideoModel("omni_flash")}
            />
            <div>
              <div className="settings-panel__radio-label">
                Omni Flash (r2v)
              </div>
              <div className="settings-panel__radio-hint">
                Reference-image to video. Variable duration (4 / 6 / 8 / 10s)
                picked per dispatch — 15 / 20 / 25 / 30 credits. Portrait +
                landscape supported.
              </div>
            </div>
          </label>
        </div>
      </div>

      <div className="settings-panel__section">
        <div className="settings-panel__label">{t("默认图片生成模型", "Image model")}</div>
        <div className="settings-panel__radio-group">
          {IMAGE_MODELS.map((m) => (
            <label
              key={m.key}
              className={`settings-panel__radio${imageModel === m.key ? " settings-panel__radio--active" : ""}`}
            >
              <input
                type="radio"
                name="image-model"
                value={m.key}
                checked={imageModel === m.key}
                onChange={() => setImageModel(m.key)}
              />
              <div>
                <div className="settings-panel__radio-label">{m.label}</div>
                <div className="settings-panel__radio-hint">{m.hint}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div className="settings-panel__section">
        <div className="settings-panel__label">{t("关于版本与新手向导", "About & Setup Wizard")}</div>
        <div className="settings-panel__about-row">
          <span className="settings-panel__about-key">{t("工作室版本", "Edition")}</span>
          <span className="settings-panel__about-value">
            {lang === "zh" ? `${BRAND_NAME_ZH} · ${BRAND_EDITION_ZH}` : `${BRAND_NAME_EN} · ${BRAND_EDITION_EN}`} <code>v2.0</code>
          </span>
        </div>
        <div style={{ marginTop: 10 }}>
          <button
            type="button"
            className="settings-panel__project-btn"
            style={{ width: "100%" }}
            onClick={() => {
              onClose();
              window.dispatchEvent(new CustomEvent("flowboard:open-onboarding"));
            }}
          >
            {t("重新打开新手账号绑定向导", "Re-open First-Run Setup Wizard")}
          </button>
        </div>
      </div>

      {onLogout && (
        // Sign out lives here (not in the AccountPanel chip) so the
        // chip stays narrow enough for the email + status row to
        // render without ellipsizing on default sidebar widths.
        <div className="settings-panel__section settings-panel__section--logout">
          <button
            type="button"
            className="settings-panel__logout-btn"
            onClick={onLogout}
            disabled={logoutPending}
          >
            {logoutPending ? "Signing out…" : "Sign out from Flow account"}
          </button>
          <div className="settings-panel__hint">
            Clears the cached identity and tells the extension to drop
            its in-memory token. The WebSocket stays open so signing
            back in doesn't require a Chrome restart.
          </div>
        </div>
      )}
      </div>
    </div>
  );
}

