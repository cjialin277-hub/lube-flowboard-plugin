import { useCallback, useEffect, useState } from "react";
import {
  completeOnboarding,
  getOnboardingStatus,
  openMultimodalTab,
  scanExtension,
  setPaygateTier,
  setPinnedFlowProject,
  updateMidjourneyConfig,
  type OnboardingStatusResponse,
} from "../api/client";
import { BRAND_EDITION_EN, BRAND_EDITION_ZH, BRAND_NAME_EN, BRAND_NAME_ZH, useLang } from "../i18n";
import { useGenerationStore } from "../store/generation";
import { AiProvidersSection } from "./settings/AiProvidersSection";

const UUID_ANYWHERE =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

interface OnboardingWizardModalProps {
  open: boolean;
  onFinished(): void;
}

export function OnboardingWizardModal({ open, onFinished }: OnboardingWizardModalProps) {
  const { lang, setLang, t } = useLang();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [status, setStatus] = useState<OnboardingStatusResponse | null>(null);
  const [projectDraft, setProjectDraft] = useState("");
  const [projectSaving, setProjectSaving] = useState(false);
  const [projectMsg, setProjectMsg] = useState<string | null>(null);
  const [projectErr, setProjectErr] = useState<string | null>(null);
  const [tierSaving, setTierSaving] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const [scanning, setScanning] = useState(false);

  // Step 3 optional engines (collapsed by default)
  const [extraExpanded, setExtraExpanded] = useState(false);
  const [mjBase, setMjBase] = useState("");
  const [mjKey, setMjKey] = useState("");
  const [mjVersion, setMjVersion] = useState("7");
  const [mjSaving, setMjSaving] = useState(false);
  const [mjNotice, setMjNotice] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);

  const refreshStatus = useCallback(async (syncDrafts = false) => {
    try {
      const data = await getOnboardingStatus();
      setStatus(data);
      if (data.paygate_tier === "PAYGATE_TIER_ONE" || data.paygate_tier === "PAYGATE_TIER_TWO") {
        useGenerationStore.setState({ paygateTier: data.paygate_tier });
      }
      if (syncDrafts) {
        setProjectDraft((prev) => prev || data.flow_project_id || "");
        setMjBase((prev) => prev || data.mj_api_base || "");
        setMjVersion(data.mj_version || "7");
      }
    } catch {
      // Backend momentarily restarting — next poll recovers.
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refreshStatus(true);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        void refreshStatus(false);
      }
    }, 2500);
    const onLlmChanged = () => void refreshStatus(false);
    window.addEventListener("flowboard:llm-config-changed", onLlmChanged);
    return () => {
      clearInterval(timer);
      window.removeEventListener("flowboard:llm-config-changed", onLlmChanged);
    };
  }, [open, refreshStatus]);

  if (!open) return null;

  const trimmedDraft = projectDraft.trim();
  const draftUuid = trimmedDraft.match(UUID_ANYWHERE)?.[0]?.toLowerCase() ?? null;
  const draftMultiAccount = trimmedDraft.match(/\/u\/\d+/)?.[0] ?? null;
  const detectedTabUuid =
    status?.flow_tab_url?.match(/project\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/)?.[1]?.toLowerCase() ?? null;

  async function handleCopyExtPath() {
    const extDir = status?.extension_dir || "";
    if (!extDir) return;
    try {
      await navigator.clipboard.writeText(extDir);
      setCopiedPath(true);
      setTimeout(() => setCopiedPath(false), 2000);
    } catch {
      // Fallback ignored if clipboard denied
    }
  }

  async function handleScanNow() {
    if (scanning) return;
    setScanning(true);
    try {
      await scanExtension();
      await refreshStatus(false);
    } finally {
      setScanning(false);
    }
  }

  async function handleSaveProject() {
    if (!draftUuid || projectSaving) return;
    setProjectSaving(true);
    setProjectErr(null);
    setProjectMsg(null);
    try {
      const res = await setPinnedFlowProject(trimmedDraft);
      useGenerationStore.setState({ projectId: null });
      setProjectDraft(res.flow_project_id ?? trimmedDraft);
      setProjectMsg(
        t(
          `已成功绑定项目 UUID：${res.flow_project_id}`,
          `Bound Flow project: ${res.flow_project_id}`,
        ),
      );
      await refreshStatus(false);
    } catch (err) {
      setProjectErr(err instanceof Error ? err.message : t("保存失败", "Save failed"));
    } finally {
      setProjectSaving(false);
    }
  }

  async function handlePickTier(nextTier: "PAYGATE_TIER_TWO" | "PAYGATE_TIER_ONE") {
    if (tierSaving) return;
    setTierSaving(true);
    try {
      await setPaygateTier(nextTier);
      useGenerationStore.setState({ paygateTier: nextTier });
      await refreshStatus(false);
    } finally {
      setTierSaving(false);
    }
  }

  async function handleSaveMj() {
    if (mjSaving) return;
    setMjSaving(true);
    setMjNotice(null);
    try {
      await updateMidjourneyConfig({
        api_base: mjBase.trim(),
        api_key: mjKey.trim() || undefined,
        version: mjVersion.trim() || "7",
      });
      setMjKey("");
      setMjNotice(t("Midjourney 网关配置已保存", "Midjourney gateway saved"));
      await refreshStatus(false);
    } catch (err) {
      setMjNotice(err instanceof Error ? err.message : t("保存失败", "Save failed"));
    } finally {
      setMjSaving(false);
    }
  }

  async function handleOpenTab(target: "midjourney" | "muse") {
    try {
      await openMultimodalTab({ target, focus: true });
      setTimeout(() => void refreshStatus(false), 1500);
    } catch {
      window.open(target === "midjourney" ? "https://www.midjourney.com/imagine" : "https://www.muse.ai/", "_blank", "noopener,noreferrer");
    }
  }

  async function handleFinish() {
    if (finishing) return;
    setFinishing(true);
    try {
      await completeOnboarding(true);
      window.dispatchEvent(new CustomEvent("flowboard:onboarding-changed"));
      onFinished();
    } finally {
      setFinishing(false);
    }
  }

  const flowReady = Boolean(status?.extension_connected && status?.flow_project_id);
  const llmReady = Boolean(status?.llm_configured);

  return (
    <div className="onboarding-backdrop" role="presentation">
      <div
        className="onboarding-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("新手绑定向导", "First-Run Setup Wizard")}
      >
        <div className="onboarding-modal__header">
          <div className="onboarding-modal__brand">
            <div className="onboarding-modal__logo" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <rect x="3" y="4" width="18" height="16" rx="3" stroke="currentColor" strokeWidth="1.7" />
                <path d="M9.5 8.5L15.5 12L9.5 15.5V8.5Z" fill="currentColor" />
              </svg>
            </div>
            <div>
              <div className="onboarding-modal__title">
                {lang === "zh" ? `${BRAND_NAME_ZH} · 首次绑定向导` : `${BRAND_NAME_EN} · Quick Setup`}
              </div>
              <div className="onboarding-modal__subtitle">
                {lang === "zh" ? BRAND_EDITION_ZH : BRAND_EDITION_EN} · {t("绑定你自己的账号后即可独立创作，互不串号", "Bind your own accounts to start creating independently")}
              </div>
            </div>
          </div>
          <div className="onboarding-modal__header-actions">
            <button
              type="button"
              className="onboarding-lang-btn"
              onClick={() => setLang(lang === "zh" ? "en" : "zh")}
            >
              {lang === "zh" ? "EN" : "中文"}
            </button>
            <button
              type="button"
              className="onboarding-skip-top"
              onClick={handleFinish}
              disabled={finishing}
              title={t("先进入画布，稍后可随时在左下角设置里重新打开向导", "Enter canvas now and configure later in Settings")}
            >
              {t("稍后再绑", "Later")}
            </button>
          </div>
        </div>

        {/* Stepper bar */}
        <div className="onboarding-stepper">
          <button
            type="button"
            className={`onboarding-step${step === 1 ? " onboarding-step--active" : ""}${flowReady ? " onboarding-step--done" : ""}`}
            onClick={() => setStep(1)}
          >
            <span className="onboarding-step__num">{flowReady ? "✓" : "1"}</span>
            <span className="onboarding-step__text">
              <strong>{t("绑定 Google Flow", "Google Flow")}</strong>
              <small>{flowReady ? t("已就绪", "Ready") : t("核心出图/出视频", "Core engine")}</small>
            </span>
          </button>
          <button
            type="button"
            className={`onboarding-step${step === 2 ? " onboarding-step--active" : ""}${llmReady ? " onboarding-step--done" : ""}`}
            onClick={() => setStep(2)}
          >
            <span className="onboarding-step__num">{llmReady ? "✓" : "2"}</span>
            <span className="onboarding-step__text">
              <strong>{t("绑定 AI 分镜大脑", "AI Brain")}</strong>
              <small>{llmReady ? t("已就绪", "Ready") : t("自动写词/拆镜（可跳过）", "Optional")}</small>
            </span>
          </button>
          <button
            type="button"
            className={`onboarding-step${step === 3 ? " onboarding-step--active" : ""}`}
            onClick={() => setStep(3)}
          >
            <span className="onboarding-step__num">3</span>
            <span className="onboarding-step__text">
              <strong>{t("可选引擎（MJ / Muse）", "MJ / Muse")}</strong>
              <small>{t("按需展开 · 可直接完成", "Optional")}</small>
            </span>
          </button>
        </div>

        {/* Body */}
        <div className="onboarding-modal__body">
          {step === 1 && (
            <div className="onboarding-pane">
              <div className="onboarding-card">
                <div className="onboarding-card__head">
                  <h3>{t("1. 加载 Chrome 桥接扩展并登录你自己的 Google Flow", "1. Load Chrome Extension & Sign In to Google Flow")}</h3>
                  <div className="onboarding-status-pills">
                    <span className={`onboarding-pill ${status?.extension_connected ? "onboarding-pill--ok" : "onboarding-pill--warn"}`}>
                      <span className="onboarding-pill__dot" />
                      {status?.extension_connected ? t("扩展桥接已连通", "Extension online") : t("等待加载扩展", "Waiting for extension")}
                    </span>
                    <span className={`onboarding-pill ${status?.flow_tab_connected ? "onboarding-pill--ok" : "onboarding-pill--idle"}`}>
                      <span className="onboarding-pill__dot" />
                      {status?.flow_tab_connected ? t("Flow 标签页已就绪", "Flow tab ready") : t("未检测到 Flow 页面", "No Flow tab")}
                    </span>
                  </div>
                </div>

                <ol className="onboarding-guide-list">
                  <li>
                    {t("在 Chrome 地址栏打开 ", "Open ")}
                    <code>chrome://extensions</code>
                    {t("，打开右上角「开发者模式」。", " in Chrome and enable Developer mode.")}
                  </li>
                  <li>
                    {t("点击「加载已解压的扩展程序」，选择下方路径中的 ", "Click Load unpacked and select this folder: ")}
                    <strong>extension</strong>
                    {t(" 文件夹：", "")}
                    <div className="onboarding-path-box">
                      <code>{status?.extension_dir || "extension"}</code>
                      <button type="button" className="onboarding-mini-btn" onClick={handleCopyExtPath}>
                        {copiedPath ? t("已复制", "Copied") : t("复制路径", "Copy")}
                      </button>
                    </div>
                  </li>
                  <li>
                    {t("打开 ", "Open ")}
                    <a href="https://flow.google.com/" target="_blank" rel="noopener noreferrer">
                      flow.google.com ↗
                    </a>
                    {t(" 登录你自己的 Google 账号，新建一个空白项目并刷新页面，上方绿灯会自动亮起。", " with your own Google account, open/create one project, and refresh the tab.")}
                  </li>
                </ol>

                <div className="onboarding-inline-actions">
                  <button type="button" className="onboarding-secondary-btn" onClick={handleScanNow} disabled={scanning}>
                    {scanning ? t("正在检测…", "Checking…") : t("立即检测连接状态", "Re-check connection")}
                  </button>
                  <a
                    className="onboarding-link-btn"
                    href="https://flow.google.com/"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t("打开 Google Flow ↗", "Open Google Flow ↗")}
                  </a>
                </div>
              </div>

              <div className="onboarding-card">
                <div className="onboarding-card__head">
                  <h3>{t("2. 粘贴你的 Google Flow 项目网址（自动提取 UUID）", "2. Paste Your Google Flow Project URL")}</h3>
                  {status?.flow_project_id && (
                    <span className="onboarding-pill onboarding-pill--ok">
                      <span className="onboarding-pill__dot" />
                      {t("已绑定", "Bound")}
                    </span>
                  )}
                </div>
                <p className="onboarding-desc">
                  {t(
                    "进入 flow.google.com 任意空白项目后，直接复制浏览器地址栏整串网址粘贴到下方即可（生成的图片和视频都会安全保存在你自己的项目中）。",
                    "Open any project on flow.google.com and paste its full URL below.",
                  )}
                </p>
                {detectedTabUuid && detectedTabUuid !== status?.flow_project_id && (
                  <div className="onboarding-inline-actions" style={{ marginBottom: 10 }}>
                    <button
                      type="button"
                      className="onboarding-mini-btn"
                      onClick={() => setProjectDraft(status?.flow_tab_url || detectedTabUuid)}
                    >
                      {t(`一键填入 Chrome 当前打开的项目 (${detectedTabUuid.slice(0, 8)}…)`, `Auto-fill open Flow tab (${detectedTabUuid.slice(0, 8)}…)`)}
                    </button>
                  </div>
                )}
                <div className="onboarding-input-row">
                  <input
                    type="text"
                    className="onboarding-input"
                    value={projectDraft}
                    onChange={(e) => setProjectDraft(e.target.value)}
                    placeholder="https://flow.google.com/project/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    spellCheck={false}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && draftUuid) void handleSaveProject();
                    }}
                  />
                  <button
                    type="button"
                    className="onboarding-primary-btn"
                    disabled={!draftUuid || projectSaving}
                    onClick={handleSaveProject}
                  >
                    {projectSaving ? t("保存中…", "Saving…") : t("保存绑定", "Bind")}
                  </button>
                </div>
                {draftUuid && (
                  <div className="onboarding-hint onboarding-hint--ok">
                    {t(
                      `已识别项目 UUID：${draftUuid}${draftMultiAccount ? `（多账号路径 ${draftMultiAccount}/）` : ""}`,
                      `Detected UUID: ${draftUuid}${draftMultiAccount ? ` (${draftMultiAccount}/)` : ""}`,
                    )}
                  </div>
                )}
                {projectMsg && <div className="onboarding-hint onboarding-hint--ok">{projectMsg}</div>}
                {projectErr && <div className="onboarding-hint onboarding-hint--err">{projectErr}</div>}
              </div>

              <div className="onboarding-card">
                <div className="onboarding-card__head">
                  <h3>{t("3. 选择你的 Google Flow 订阅等级", "3. Select Your Google Flow Subscription Plan")}</h3>
                </div>
                <div className="onboarding-tier-grid">
                  <button
                    type="button"
                    disabled={tierSaving}
                    className={`onboarding-tier-card${status?.paygate_tier === "PAYGATE_TIER_TWO" ? " onboarding-tier-card--active" : ""}`}
                    onClick={() => handlePickTier("PAYGATE_TIER_TWO")}
                  >
                    <div className="onboarding-tier-card__title">
                      Google AI Ultra <span className="onboarding-badge">推荐</span>
                    </div>
                    <div className="onboarding-tier-card__desc">
                      {t("解锁 Veo 3.1 Fast Ultra 高优通道 + Nano Banana Pro 0 积分生图", "Veo 3.1 Fast Ultra + Nano Banana Pro 0-credit images")}
                    </div>
                  </button>
                  <button
                    type="button"
                    disabled={tierSaving}
                    className={`onboarding-tier-card${status?.paygate_tier === "PAYGATE_TIER_ONE" ? " onboarding-tier-card--active" : ""}`}
                    onClick={() => handlePickTier("PAYGATE_TIER_ONE")}
                  >
                    <div className="onboarding-tier-card__title">Google AI Pro</div>
                    <div className="onboarding-tier-card__desc">
                      {t("标准 Pro 订阅通道（支持 Veo 3.1 Lite / Fast / Quality）", "Standard Pro plan (Veo 3.1 Lite / Fast / Quality)")}
                    </div>
                  </button>
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="onboarding-pane">
              <div className="onboarding-info-banner">
                {t(
                  "用于画布内的「自动生成分镜提示词」「反推图片特征」「剧本拆镜」。可直接使用你本机已登录的 Claude / Gemini / Codex CLI，或在 OpenAI 行填入自己的 API Key；如果暂时不想配置，也可以直接点右下角「下一步」跳过，不影响手动填词出图出视频。",
                  "Drives auto-prompting, image vision briefs, and script planning. Pick any local CLI or enter your own OpenAI API Key — or skip for now and configure later.",
                )}
              </div>
              <div className="onboarding-llm-embed">
                <AiProvidersSection />
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="onboarding-pane">
              <div className="onboarding-card">
                <div className="onboarding-card__head">
                  <h3>{t("第三方多模态引擎（Midjourney & Meta Muse · 可选）", "Optional Engines (Midjourney & Meta Muse)")}</h3>
                  <button
                    type="button"
                    className="onboarding-mini-btn"
                    onClick={() => setExtraExpanded((v) => !v)}
                  >
                    {extraExpanded ? t("收起配置", "Collapse") : t("展开按需绑定", "Expand")}
                  </button>
                </div>
                <p className="onboarding-desc">
                  {t(
                    "仅使用 Google Flow 已经可以完整完成「生角色图 ➔ 生关键帧 ➔ 生视频 ➔ 合成片」全流程。如果你自己有 Midjourney V7 或 Meta Muse 账号，可以展开绑定，否则直接点击下方「完成并进入画布」即可。",
                    "Google Flow alone covers the entire pipeline. Expand only if you also want to connect your own Midjourney V7 or Meta Muse account.",
                  )}
                </p>

                {extraExpanded && (
                  <div className="onboarding-extra-grid">
                    <div className="onboarding-subcard">
                      <div className="onboarding-subcard__head">
                        <strong>Midjourney V7</strong>
                        <span className={`onboarding-pill ${status?.mj_tab_connected || status?.mj_api_key_set ? "onboarding-pill--ok" : "onboarding-pill--idle"}`}>
                          <span className="onboarding-pill__dot" />
                          {status?.mj_tab_connected
                            ? t("网页已连接", "Web tab ready")
                            : status?.mj_api_key_set
                              ? t("网关已配置", "Gateway set")
                              : t("未配置", "Optional")}
                        </span>
                      </div>
                      <p className="onboarding-desc">
                        {t("方式 A（免费直连）：打开并登录 Midjourney 网页即可直接从画布导入素材；方式 B：填入自建 MJ Proxy 网关。", "Mode A: sign in to midjourney.com in Chrome. Mode B: optional MJ gateway API.")}
                      </p>
                      <button
                        type="button"
                        className="onboarding-secondary-btn"
                        onClick={() => handleOpenTab("midjourney")}
                      >
                        {t("打开 Midjourney 网页登录 ↗", "Open Midjourney Web ↗")}
                      </button>
                      <div className="onboarding-form-col">
                        <input
                          type="text"
                          className="onboarding-input"
                          value={mjBase}
                          onChange={(e) => setMjBase(e.target.value)}
                          placeholder={t("可选：MJ 网关地址（如 https://api.example.com/mj）", "Optional: MJ API Base URL")}
                        />
                        <input
                          type="password"
                          className="onboarding-input"
                          value={mjKey}
                          onChange={(e) => setMjKey(e.target.value)}
                          placeholder={
                            status?.mj_api_key_set
                              ? t("已保存 API Key（留空保持不变）", "API Key saved (leave blank to keep)")
                              : t("可选：MJ API Key", "Optional: MJ API Key")
                          }
                        />
                        <div className="onboarding-inline-actions">
                          <button type="button" className="onboarding-mini-btn" onClick={handleSaveMj} disabled={mjSaving}>
                            {mjSaving ? t("保存中…", "Saving…") : t("保存 MJ 网关", "Save MJ Gateway")}
                          </button>
                          {mjNotice && <span className="onboarding-hint onboarding-hint--ok">{mjNotice}</span>}
                        </div>
                      </div>
                    </div>

                    <div className="onboarding-subcard">
                      <div className="onboarding-subcard__head">
                        <strong>Meta Muse</strong>
                        <span className={`onboarding-pill ${status?.muse_tab_connected ? "onboarding-pill--ok" : "onboarding-pill--idle"}`}>
                          <span className="onboarding-pill__dot" />
                          {status?.muse_tab_connected ? t("网页已连接", "Web tab ready") : t("未配置", "Optional")}
                        </span>
                      </div>
                      <p className="onboarding-desc">
                        {t("通过 Chrome 扩展直连你的 Meta Muse 网页标签页，适合多模态创意补拍。", "Connect your signed-in Meta Muse tab via the Chrome extension.")}
                      </p>
                      <button
                        type="button"
                        className="onboarding-secondary-btn"
                        onClick={() => handleOpenTab("muse")}
                      >
                        {t("打开 Meta Muse 网页登录 ↗", "Open Meta Muse Web ↗")}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="onboarding-summary-card">
                <div className="onboarding-summary-row">
                  <span>{t("Google Flow 扩展桥接", "Flow Extension")}</span>
                  <strong className={status?.extension_connected ? "is-ok" : "is-warn"}>
                    {status?.extension_connected ? t("已连通", "Connected") : t("待加载（可稍后连接）", "Pending")}
                  </strong>
                </div>
                <div className="onboarding-summary-row">
                  <span>{t("Flow 项目绑定", "Flow Project")}</span>
                  <strong className={status?.flow_project_id ? "is-ok" : "is-warn"}>
                    {status?.flow_project_id ? status.flow_project_id : t("尚未填写（进入后在左下角设置补填）", "Not bound yet")}
                  </strong>
                </div>
                <div className="onboarding-summary-row">
                  <span>{t("订阅等级", "Plan")}</span>
                  <strong className="is-ok">
                    {status?.paygate_tier === "PAYGATE_TIER_ONE" ? "Google AI Pro" : "Google AI Ultra"}
                  </strong>
                </div>
                <div className="onboarding-summary-row">
                  <span>{t("AI 分镜大脑", "AI Brain")}</span>
                  <strong className={llmReady ? "is-ok" : "is-idle"}>
                    {llmReady ? t("已配置", "Configured") : t("已跳过（可随时在顶部 AI 按钮补配）", "Skipped for now")}
                  </strong>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="onboarding-modal__footer">
          <div className="onboarding-modal__footer-left">
            {step > 1 && (
              <button
                type="button"
                className="onboarding-secondary-btn"
                onClick={() => setStep((s) => (s === 3 ? 2 : 1))}
              >
                {t("← 上一步", "← Back")}
              </button>
            )}
          </div>
          <div className="onboarding-modal__footer-right">
            {step < 3 ? (
              <button
                type="button"
                className="onboarding-primary-btn"
                onClick={() => setStep((s) => (s === 1 ? 2 : 3))}
              >
                {step === 2 && !llmReady ? t("跳过此步，下一步 →", "Skip & Next →") : t("下一步 →", "Next →")}
              </button>
            ) : (
              <button
                type="button"
                className="onboarding-primary-btn onboarding-primary-btn--finish"
                onClick={handleFinish}
                disabled={finishing}
              >
                {finishing ? t("正在进入…", "Opening…") : t("完成绑定，进入画布", "Finish & Enter Canvas")}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
