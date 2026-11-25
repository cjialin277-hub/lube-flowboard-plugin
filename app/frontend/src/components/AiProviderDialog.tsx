import { useEffect, useRef } from "react";
import { AiProvidersSection } from "./settings/AiProvidersSection";
import { useLang } from "../i18n";

/**
 * Standalone dialog for the AI Providers panel.
 *
 * Two modes:
 *  - **User-opened** (`force=false`): backdrop click + ESC + ✕ all close.
 *  - **Forced setup** (`force=true`): no close affordances. The parent
 *    (ForcedSetupGate at the App level) controls visibility based on
 *    `/api/llm/config.configured`. Once the user Applies with a provider
 *    pinned on all 3 features, the next /config poll flips
 *    `configured=true` and the parent unmounts the dialog.
 *
 * SettingsPanel (Google Flow tier / video quality / image model) is a
 * separate dialog — Flow billing decisions don't belong with LLM
 * provider switches.
 */

interface AiProviderDialogProps {
  open: boolean;
  onClose(): void;
  /** When true, hide ✕, ignore ESC, ignore backdrop click. */
  force?: boolean;
}

export function AiProviderDialog({ open, onClose, force = false }: AiProviderDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const { t } = useLang();

  useEffect(() => {
    if (!open || force) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, force]);

  if (!open) return null;

  return (
    <div
      className={`ai-provider-dialog-backdrop${force ? " ai-provider-dialog-backdrop--force" : ""}`}
      role="presentation"
      onClick={(e) => {
        if (force) return;
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="ai-provider-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="AI Providers"
      >
        <div className="ai-provider-dialog__header">
          <span className="ai-provider-dialog__title">
            {force ? t("配置本地 AI 提示词引擎", "Set up your AI providers") : t("AI 提示词引擎配置", "AI Providers")}
          </span>
          {!force && (
            <button
              type="button"
              className="ai-provider-dialog__close"
              onClick={onClose}
              aria-label="Close AI Providers"
            >
              ×
            </button>
          )}
        </div>
        {force && (
          <div className="ai-provider-dialog__force-banner" role="alert">
            {t("请为「自动分镜提示词」「视觉画面解析」「剧本节点规划」分别选择本地 AI 引擎（推荐选 Gemini (agy)），点击底部「保存配置」即可进入画布。", "Pick an AI provider for Auto-prompt, Vision, and Planner, then click Apply to continue.")}
          </div>
        )}
        <AiProvidersSection />
      </div>
    </div>
  );
}
