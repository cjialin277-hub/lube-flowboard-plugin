import { create } from "zustand";

export type Lang = "zh" | "en";

export const BRAND_NAME_ZH = "Lube 影视画布";
export const BRAND_NAME_EN = "Lube Studio";
export const BRAND_EDITION_ZH = "AI Ultra 影视叙事专版";
export const BRAND_EDITION_EN = "AI Ultra Cinema Edition";

const LANG_STORAGE_KEY = "flowboard.lang.v1";

function loadInitialLang(): Lang {
  try {
    const raw = localStorage.getItem(LANG_STORAGE_KEY);
    if (raw === "en" || raw === "zh") return raw;
  } catch {
    // ignore storage errors
  }
  return "zh"; // Default to Simplified Chinese for team usability
}

interface I18nState {
  lang: Lang;
  setLang(lang: Lang): void;
  toggleLang(): void;
}

export const useI18nStore = create<I18nState>((set, get) => ({
  lang: loadInitialLang(),
  setLang(lang) {
    set({ lang });
    try {
      localStorage.setItem(LANG_STORAGE_KEY, lang);
    } catch {
      // ignore
    }
  },
  toggleLang() {
    const next: Lang = get().lang === "zh" ? "en" : "zh";
    get().setLang(next);
  },
}));

export function getLang(): Lang {
  return useI18nStore.getState().lang;
}

export function tStatic(zh: string, en: string): string {
  return getLang() === "zh" ? zh : en;
}

export function useLang() {
  const lang = useI18nStore((s) => s.lang);
  const setLang = useI18nStore((s) => s.setLang);
  const toggleLang = useI18nStore((s) => s.toggleLang);
  const isZh = lang === "zh";
  const t = (zh: string, en: string) => (isZh ? zh : en);
  return { lang, isZh, setLang, toggleLang, t };
}

const DEFAULT_TITLES_EN: Record<string, string> = {
  character: "Character",
  image: "Image",
  video: "Video",
  prompt: "Prompt",
  note: "Note",
  visual_asset: "Visual asset",
  Storyboard: "Storyboard",
  merge: "Merge",
};

const DEFAULT_TITLES_ZH: Record<string, string> = {
  character: "角色锚点",
  image: "分镜画面",
  video: "动态视频",
  prompt: "导演提示词",
  note: "备注便签",
  visual_asset: "道具/场景",
  Storyboard: "分镜故事板",
  merge: "视频合并",
};

const ALL_DEFAULT_TITLES = new Set([
  ...Object.values(DEFAULT_TITLES_EN),
  ...Object.values(DEFAULT_TITLES_ZH),
]);

export function displayNodeTitle(
  title: string | undefined,
  type: string,
  lang: Lang,
): string {
  const trimmed = (title ?? "").trim();
  if (!trimmed || ALL_DEFAULT_TITLES.has(trimmed)) {
    return lang === "zh"
      ? (DEFAULT_TITLES_ZH[type] ?? type)
      : (DEFAULT_TITLES_EN[type] ?? type);
  }
  return trimmed;
}

export function displayBoardName(name: string | undefined, lang: Lang): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed || trimmed === "Untitled" || trimmed === "未命名画布") {
    return lang === "zh" ? "未命名画布" : "Untitled";
  }
  return trimmed;
}
