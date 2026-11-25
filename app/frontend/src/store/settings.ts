import { create } from "zustand";

/**
 * Per-user model preferences. Survives page reload via localStorage —
 * single-user, single-host app, so no need for server persistence.
 *
 * Image model: Flow ships two checkpoints — "NANO_BANANA_PRO" (premium,
 * higher quality, slower) and "NANO_BANANA_2" (faster, lighter). Users
 * pick once in the dashboard Settings panel; every gen_image / edit_image
 * dispatch reads the cached preference and forwards it to the worker.
 *
 * Video model is currently derived from paygate tier + aspect (resolved
 * server-side via VIDEO_MODEL_KEYS), so it's a *display* on the panel
 * rather than a switchable preference. When/if Flow ships variants per
 * tier (e.g. fast vs quality) we extend this store with `videoModelKey`.
 */
export type ImageModelKey = "NANO_BANANA_PRO" | "NANO_BANANA_2" | "MIDJOURNEY_V7";
// Veo 3.1 ships in four flavours:
//   - Lite (smaller checkpoint, fastest, lower fidelity)
//   - Fast (default — bigger model, balanced)
//   - Quality (highest fidelity, slowest)
//   - Lite Relaxed (Lite on a low-priority queue, 0 credits — Ultra only)
// Choice applies globally across both portrait and landscape; backend
// resolves the actual model key at dispatch time from [tier][quality][aspect].
// Tier 1 (Pro) users picking `lite_relaxed` fall back to Fast on the
// backend (and the Settings UI locks that radio for them).
export type VideoQuality =
  | "fast"
  | "lite"
  | "quality"
  | "lite_relaxed";

// Video model family. "veo" = the existing Veo 3.1 i2v family controlled
// by videoQuality (lite/fast/quality/...). "omni_flash" = the new
// reference-image r2v model with per-duration credit cost and no
// per-tier quality variants — duration is picked per dispatch in the
// GenerationDialog. The video dispatch path branches on this.
export type VideoModelFamily = "veo" | "omni_flash";

// Omni Flash duration → credit cost (informational, surfaced in the
// dialog so the user sees the cost before submit). Mirrors the backend
// OMNI_FLASH_CREDIT_COST table — pin both via tests.
export const OMNI_FLASH_CREDIT_COST: Record<4 | 6 | 8 | 10, number> = {
  4: 15,
  6: 20,
  8: 25,
  10: 30,
};
export type OmniFlashDuration = 4 | 6 | 8 | 10;
export const OMNI_FLASH_DURATIONS: OmniFlashDuration[] = [4, 6, 8, 10];

// Generation backend. "flow" = the existing Chrome-extension → Google
// Flow path. "muse" = delegated to a Pax worker via the provider-job
// queue (no Flow plan, no extension needed). Picked per dispatch in the
// GenerationDialog and sticky — persisted here like the model picks.
export type MediaProviderKey = "flow" | "dry_run" | "muse" | "midjourney";
export type DefaultAspect = "portrait" | "landscape";
export type AspectVisualKind = "portrait" | "landscape" | "square";
export type ThemeMode = "dark" | "light";
export type WallpaperId = "puppy-1" | "puppy-2" | "puppy-3" | "puppy-4" | "none";

export interface WallpaperPreset {
  id: Exclude<WallpaperId, "none">;
  index: number;
  url: string;
  labelZh: string;
  labelEn: string;
}

export const WALLPAPER_PRESETS: WallpaperPreset[] = [
  {
    id: "puppy-1",
    index: 1,
    url: "/wallpapers/puppy-1.jpg",
    labelZh: "1/4 · 歪头甜笑",
    labelEn: "1/4 · Sweet Smile",
  },
  {
    id: "puppy-2",
    index: 2,
    url: "/wallpapers/puppy-2.jpg",
    labelZh: "2/4 · 蝴蝶结乖坐",
    labelEn: "2/4 · Ribbon Bow",
  },
  {
    id: "puppy-3",
    index: 3,
    url: "/wallpapers/puppy-3.jpg",
    labelZh: "3/4 · 丝巾小绅士",
    labelEn: "3/4 · Scarf Gentleman",
  },
  {
    id: "puppy-4",
    index: 4,
    url: "/wallpapers/puppy-4.jpg",
    labelZh: "4/4 · 乖巧握手",
    labelEn: "4/4 · Little Paw",
  },
];

export function aspectKindOf(
  aspectRatio?: string | null,
  fallback: DefaultAspect = "portrait",
): AspectVisualKind {
  if (typeof aspectRatio === "string" && aspectRatio.trim()) {
    const up = aspectRatio.toUpperCase();
    if (up.includes("PORTRAIT")) return "portrait";
    if (up.includes("LANDSCAPE")) return "landscape";
    if (up.includes("SQUARE")) return "square";
  }
  return fallback;
}

export function defaultAspectEnum(
  kind: "image" | "video",
  aspect: DefaultAspect,
): string {
  if (kind === "video") {
    return aspect === "portrait"
      ? "VIDEO_ASPECT_RATIO_PORTRAIT"
      : "VIDEO_ASPECT_RATIO_LANDSCAPE";
  }
  return aspect === "portrait"
    ? "IMAGE_ASPECT_RATIO_PORTRAIT"
    : "IMAGE_ASPECT_RATIO_LANDSCAPE";
}

interface SettingsState {
  imageModel: ImageModelKey;
  videoQuality: VideoQuality;
  videoModel: VideoModelFamily;
  omniFlashDuration: OmniFlashDuration;
  mediaProvider: MediaProviderKey;
  defaultAspect: DefaultAspect;
  themeMode: ThemeMode;
  wallpaperId: WallpaperId;
  setImageModel(model: ImageModelKey): void;
  setVideoQuality(q: VideoQuality): void;
  setVideoModel(m: VideoModelFamily): void;
  setOmniFlashDuration(d: OmniFlashDuration): void;
  setMediaProvider(p: MediaProviderKey): void;
  setDefaultAspect(a: DefaultAspect): void;
  setThemeMode(t: ThemeMode): void;
  toggleThemeMode(): void;
  setWallpaperId(w: WallpaperId): void;
  cycleWallpaper(): void;
}

const STORAGE_KEY = "flowboard.settings.v1";

interface PersistShape {
  imageModel?: ImageModelKey;
  videoQuality?: VideoQuality;
  videoModel?: VideoModelFamily;
  omniFlashDuration?: OmniFlashDuration;
  mediaProvider?: MediaProviderKey;
  defaultAspect?: DefaultAspect;
  themeMode?: ThemeMode;
  wallpaperId?: WallpaperId;
}

function loadPersisted(): PersistShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function persist(state: PersistShape): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage disabled / quota — non-fatal, just lose persistence.
  }
}

const persisted = loadPersisted();

const VALID_VIDEO_QUALITIES: VideoQuality[] = ["fast", "lite", "quality", "lite_relaxed"];
const VALID_MEDIA_PROVIDERS: MediaProviderKey[] = ["flow", "dry_run", "muse", "midjourney"];
const VALID_ASPECTS: DefaultAspect[] = ["portrait", "landscape"];
const VALID_THEMES: ThemeMode[] = ["dark", "light"];
const VALID_WALLPAPERS: WallpaperId[] = ["puppy-1", "puppy-2", "puppy-3", "puppy-4", "none"];
const WALLPAPER_CYCLE_ORDER: Exclude<WallpaperId, "none">[] = [
  "puppy-1",
  "puppy-2",
  "puppy-3",
  "puppy-4",
];

function snapshotPersist(get: () => SettingsState): PersistShape {
  return {
    imageModel: get().imageModel,
    videoQuality: get().videoQuality,
    videoModel: get().videoModel,
    omniFlashDuration: get().omniFlashDuration,
    mediaProvider: get().mediaProvider,
    defaultAspect: get().defaultAspect,
    themeMode: get().themeMode,
    wallpaperId: get().wallpaperId,
  };
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  imageModel: persisted.imageModel ?? "NANO_BANANA_PRO",
  videoQuality:
    persisted.videoQuality && VALID_VIDEO_QUALITIES.includes(persisted.videoQuality)
      ? persisted.videoQuality
      : "fast",
  videoModel: persisted.videoModel ?? "veo",
  omniFlashDuration: persisted.omniFlashDuration ?? 4,
  mediaProvider:
    persisted.mediaProvider && VALID_MEDIA_PROVIDERS.includes(persisted.mediaProvider)
      ? persisted.mediaProvider
      : "flow",
  defaultAspect:
    persisted.defaultAspect && VALID_ASPECTS.includes(persisted.defaultAspect)
      ? persisted.defaultAspect
      : "portrait",
  themeMode:
    persisted.themeMode && VALID_THEMES.includes(persisted.themeMode)
      ? persisted.themeMode
      : "dark",
  wallpaperId:
    persisted.wallpaperId && VALID_WALLPAPERS.includes(persisted.wallpaperId)
      ? persisted.wallpaperId
      : "puppy-1",
  setImageModel(model) {
    set({ imageModel: model });
    persist(snapshotPersist(get));
  },
  setVideoQuality(q) {
    set({ videoQuality: q });
    persist(snapshotPersist(get));
  },
  setVideoModel(m) {
    set({ videoModel: m });
    persist(snapshotPersist(get));
  },
  setOmniFlashDuration(d) {
    set({ omniFlashDuration: d });
    persist(snapshotPersist(get));
  },
  setMediaProvider(p) {
    set({ mediaProvider: p });
    persist(snapshotPersist(get));
  },
  setDefaultAspect(a) {
    set({ defaultAspect: a });
    persist(snapshotPersist(get));
  },
  setThemeMode(t) {
    set({ themeMode: t });
    persist(snapshotPersist(get));
  },
  toggleThemeMode() {
    const next: ThemeMode = get().themeMode === "light" ? "dark" : "light";
    set({ themeMode: next });
    persist(snapshotPersist(get));
  },
  setWallpaperId(w) {
    set({ wallpaperId: w });
    persist(snapshotPersist(get));
  },
  cycleWallpaper() {
    const cur = get().wallpaperId;
    const idx = WALLPAPER_CYCLE_ORDER.indexOf(cur as Exclude<WallpaperId, "none">);
    const next =
      idx === -1
        ? "puppy-1"
        : WALLPAPER_CYCLE_ORDER[(idx + 1) % WALLPAPER_CYCLE_ORDER.length];
    set({ wallpaperId: next });
    persist(snapshotPersist(get));
  },
}));
