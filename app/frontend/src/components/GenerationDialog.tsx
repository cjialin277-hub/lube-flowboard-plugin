import { useEffect, useRef, useState } from "react";
import { useGenerationStore } from "../store/generation";
import { useBoardStore, type StoryboardGrid } from "../store/board";
import {
  STORYBOARD_GRIDS,
  buildStoryboardPrompt,
  buildStoryboardVideoPrompt,
  normaliseStoryboardGrid,
  totalPanels,
} from "../lib/storyboardPrompt";
import {
  useSettingsStore,
  defaultAspectEnum,
  OMNI_FLASH_CREDIT_COST,
  OMNI_FLASH_DURATIONS,
  type OmniFlashDuration,
  type VideoQuality,
} from "../store/settings";
import {
  autoPrompt as autoPromptApi,
  autoPromptBatch as autoPromptBatchApi,
  mediaUrl,
  patchEdge,
  patchNode,
  polishPrompt as polishPromptApi,
} from "../api/client";
import {
  CHARACTER_GENDERS,
  CHARACTER_COUNTRIES,
  CHARACTER_VIBES,
  type GenderKey,
  type CountryKey,
  type VibeKey,
} from "../constants/character";
import { displayBoardName, useLang } from "../i18n";

const REF_SOURCE_TYPES = new Set([
  "character",
  "image",
  "visual_asset",
  // Storyboard outputs are first-class refs — they're composite images
  // that can feed downstream image / Omni-video / character nodes.
  "Storyboard",
]);

function buildCharacterPrompt(
  gender: GenderKey | null,
  country: CountryKey | null,
  vibe: VibeKey,
  extras: string,
  whiteStudioAnchor: boolean,
): string {
  const g = CHARACTER_GENDERS.find((x) => x.key === gender)?.tag;
  const c = CHARACTER_COUNTRIES.find((x) => x.key === country)?.tag;
  const subject = [c, g].filter(Boolean).join(" ") || "person";
  const vibeTokens = CHARACTER_VIBES.find((v) => v.key === vibe)?.tokens ?? [];
  const tail = extras.trim();
  return [
    `Live-action 35mm cinema casting reference of a single ${subject} character`,
    "clear unobstructed facial features, natural skin pores and fine grain, authentic eye focus without plastic retouching",
    "soft balanced neutral studio key light on the face for Veo identity consistency",
    ...vibeTokens,
    tail || null,
    whiteStudioAnchor
      ? "chest-up front-facing bust portrait on a seamless pure white seamless studio cyclorama background, clean collar edges"
      : "chest-up medium close-up framing, calm grounded dramatic poise",
    "relaxed natural closed mouth without extreme grimace, NO TEXT IN THE IMAGE, NO WATERMARKS",
  ]
    .filter(Boolean)
    .join(", ");
}

const IMAGE_ASPECT_RATIOS = [
  { key: "IMAGE_ASPECT_RATIO_PORTRAIT", label: "9:16 竖屏" },
  { key: "IMAGE_ASPECT_RATIO_LANDSCAPE", label: "16:9 横屏" },
  { key: "IMAGE_ASPECT_RATIO_SQUARE", label: "1:1 头像" },
] as const;

const VIDEO_ASPECT_RATIOS = [
  { key: "VIDEO_ASPECT_RATIO_PORTRAIT", label: "9:16 竖屏" },
  { key: "VIDEO_ASPECT_RATIO_LANDSCAPE", label: "16:9 横屏" },
] as const;

// Cinematic camera grammar aligned with flow-evolve M01-M11 moves
const CAMERA_MOVEMENTS = [
  { key: "dynamic", label: "Dynamic", labelZh: "自动运镜", instruction: "" },
  {
    key: "static",
    label: "Static",
    labelZh: "固定机位",
    instruction:
      "Camera: locked-off static tripod frame, no zoom, pan, or dolly, letting actor micro-expressions and breath carry tension.",
  },
  {
    key: "dolly_in",
    label: "Dolly-in",
    labelZh: "M01 慢推情绪",
    instruction:
      "Camera: slow smooth forward dolly-in on 50mm prime lens tightening from chest-up to emotional medium close-up.",
  },
  {
    key: "dolly_out",
    label: "Dolly-out",
    labelZh: "M02 缓拉交代",
    instruction:
      "Camera: measured slow backward dolly-out revealing room depth and spatial distance between characters.",
  },
  {
    key: "tracking",
    label: "Tracking",
    labelZh: "M05 平稳跟拍",
    instruction:
      "Camera: smooth chest-height Steadicam tracking move matching the actor's measured pace.",
  },
  {
    key: "ots",
    label: "180° OTS",
    labelZh: "M11 过肩正反打",
    instruction:
      "Camera: locked 180-degree over-the-shoulder frame keeping the listener's blurred foreground shoulder consistently on one frame edge.",
  },
  {
    key: "rack_focus",
    label: "Rack Focus",
    labelZh: "M10 拉焦转移",
    instruction:
      "Camera: shallow 85mm rack focus pulling sharply from foreground prop to the character's eyes.",
  },
  {
    key: "orbit",
    label: "Subtle Orbit",
    labelZh: "M09 轻弧环绕",
    instruction:
      "Camera: slow controlled 20-degree arc around the confrontation axis without crossing the 180-degree line.",
  },
] as const;

type CameraKey = (typeof CAMERA_MOVEMENTS)[number]["key"];

// Video model picker shown in the dialog — mirrors the unified list from
// SettingsPanel so the user can override the model per-dispatch without
// opening the gear menu. Selecting a chip mutates the global settings
// store (same pattern as the Omni-duration chips below), so the choice
// is sticky for subsequent dispatches.
// Each chip is either a Veo quality combo or Omni Flash. `ultraOnly`
// chips are locked when the detected paygate tier isn't TIER_TWO —
// the backend would silently fall back to Fast otherwise.
type VeoChip = {
  kind: "veo";
  quality: VideoQuality;
  label: string;
  ultraOnly: boolean;
};
type OmniChip = { kind: "omni"; label: string };
type VideoModelChip = VeoChip | OmniChip;

const VIDEO_MODEL_CHIPS: readonly VideoModelChip[] = [
  { kind: "veo", quality: "lite", label: "Veo 3.1 Lite", ultraOnly: false },
  { kind: "veo", quality: "fast", label: "Veo 3.1 Fast", ultraOnly: false },
  { kind: "veo", quality: "quality", label: "Veo 3.1 Quality", ultraOnly: false },
  { kind: "veo", quality: "lite_relaxed", label: "Veo 3.1 Lite (Low Priority)", ultraOnly: true },
  { kind: "omni", label: "Omni Flash" },
];

function cameraInstruction(key: CameraKey): string {
  return CAMERA_MOVEMENTS.find((c) => c.key === key)?.instruction ?? "";
}

type ImageAspectKey = (typeof IMAGE_ASPECT_RATIOS)[number]["key"];
type VideoAspectKey = (typeof VIDEO_ASPECT_RATIOS)[number]["key"];
type AspectKey = ImageAspectKey | VideoAspectKey;

// Map an upstream image aspect onto the closest video aspect. Square has
// no direct video equivalent — fall back to portrait per the
// "default-to-9:16 on mismatch" rule.
function imageAspectToVideo(img: string | undefined): VideoAspectKey | null {
  if (img === "IMAGE_ASPECT_RATIO_LANDSCAPE") return "VIDEO_ASPECT_RATIO_LANDSCAPE";
  if (img === "IMAGE_ASPECT_RATIO_PORTRAIT") return "VIDEO_ASPECT_RATIO_PORTRAIT";
  if (img === "IMAGE_ASPECT_RATIO_SQUARE") return "VIDEO_ASPECT_RATIO_PORTRAIT";
  return null;
}

// Walk upstream of the target node, collect each upstream's aspectRatio,
// then apply the user's rule:
//   • single distinct aspect → match it
//   • multiple distinct aspects → fall back to 9:16
//   • zero upstream / unknown → caller's default
function pickDefaultAspect(
  rfId: string,
  targetType: string,
  nodes: ReturnType<typeof useBoardStore.getState>["nodes"],
  edges: ReturnType<typeof useBoardStore.getState>["edges"],
): AspectKey | null {
  const upstreamAspects: string[] = [];
  for (const e of edges) {
    if (e.target !== rfId) continue;
    const src = nodes.find((n) => n.id === e.source);
    if (!src) continue;
    const ar = src.data.aspectRatio;
    if (typeof ar === "string" && ar.length > 0) upstreamAspects.push(ar);
  }
  if (upstreamAspects.length === 0) return null;

  if (targetType === "video") {
    const mapped = upstreamAspects
      .map(imageAspectToVideo)
      .filter((x): x is VideoAspectKey => x !== null);
    if (mapped.length === 0) return null;
    const unique = new Set(mapped);
    if (unique.size === 1) return mapped[0];
    return "VIDEO_ASPECT_RATIO_PORTRAIT";
  }
  // Image (and character — though character has its own opinionated
  // default; the caller short-circuits before reaching here).
  const validImg = upstreamAspects.filter((a): a is ImageAspectKey =>
    IMAGE_ASPECT_RATIOS.some((p) => p.key === a),
  );
  if (validImg.length === 0) return null;
  const unique = new Set(validImg);
  if (unique.size === 1) return validImg[0];
  return "IMAGE_ASPECT_RATIO_PORTRAIT";
}

// Small "ⓘ" affordance for moving static help-text out of the layout
// into a hover tooltip — keeps the dialog short while preserving the
// information for users who want it. Native `title` (plain text) is
// enough; we don't need rich markup in tooltips.
function InfoTip({ tip }: { tip: string }) {
  return (
    <span
      className="gen-dialog__info-tip"
      title={tip}
      aria-label={tip}
      role="img"
    >
      ⓘ
    </span>
  );
}

export function GenerationDialog() {
  const openDialog = useGenerationStore((s) => s.openDialog);
  const closeGenerationDialog = useGenerationStore((s) => s.closeGenerationDialog);
  const dispatchGeneration = useGenerationStore((s) => s.dispatchGeneration);
  const nodes = useBoardStore((s) => s.nodes);
  const { lang, isZh, t } = useLang();

  const [prompt, setPrompt] = useState(openDialog.prompt);
  const [aspectRatio, setAspectRatio] = useState<AspectKey>("IMAGE_ASPECT_RATIO_LANDSCAPE");
  const [variants, setVariants] = useState(1);
  const [camera, setCamera] = useState<CameraKey>("dynamic");
  // Storyboard layout. The node dispatches via the standard image
  // handler with a locked template prompt wrapping the user's topic
  // into a single composite NxN grid. See lib/storyboardPrompt.ts.
  const [storyboardGrid, setStoryboardGrid] = useState<StoryboardGrid>("2x2");

  // Character builder state — only used when targetType === "character".
  const [charGender, setCharGender] = useState<GenderKey | null>(null);
  const [charCountry, setCharCountry] = useState<CountryKey | null>(null);
  const [charVibe, setCharVibe] = useState<VibeKey>("dramatic_realism");
  const [charExtras, setCharExtras] = useState("");
  const [whiteStudioAnchor, setWhiteStudioAnchor] = useState(true);
  const [polishingPrompt, setPolishingPrompt] = useState(false);

  // Auto-prompt state — set when the user submits an empty prompt and we
  // synthesise one from upstream context. Surfaced as a small ✨ badge.
  const [autoBuilding, setAutoBuilding] = useState(false);
  const [autoPromptUsed, setAutoPromptUsed] = useState(false);

  // Per-variant selection for multi-source i2v. Default: all selected.
  // Stored as a Set of indices so the UI can toggle individual variants
  // and "All / None" without juggling parallel arrays.
  const [selectedSourceIdx, setSelectedSourceIdx] = useState<Set<number>>(new Set());
  // Tracks which Source-Reference chip's variant picker is currently
  // open. Holds the edge id the picker is anchored to (one open at a
  // time). Click another chip → swap; click the same chip → close;
  // click outside (handled inline) → close.
  const [openVariantPicker, setOpenVariantPicker] = useState<string | null>(null);
  // First + Last frame transition mode (RPC `nprQif`) when >= 2 upstream images exist.
  const [firstLastMode, setFirstLastMode] = useState(false);
  const [firstLastStartId, setFirstLastStartId] = useState("");
  const [firstLastEndId, setFirstLastEndId] = useState("");
  const [firstLastDuration, setFirstLastDuration] = useState<OmniFlashDuration>(8);

  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFocusRef = useRef<HTMLTextAreaElement>(null);
  const triggerRef = useRef<Element | null>(null);

  const rfId = openDialog.rfId;
  const node = nodes.find((n) => n.id === rfId);
  const boardName = useBoardStore((s) => s.boardName);
  const nodeCount = nodes.length;
  const edges = useBoardStore((s) => s.edges);

  // Hooks MUST be called unconditionally on every render — pull
  // videoModel out first, derive the boolean after.
  const videoModelFamily = useSettingsStore((s) => s.videoModel);
  const videoQuality = useSettingsStore((s) => s.videoQuality);
  const setVideoModel = useSettingsStore((s) => s.setVideoModel);
  const setVideoQuality = useSettingsStore((s) => s.setVideoQuality);
  const omniFlashDuration = useSettingsStore((s) => s.omniFlashDuration);
  const setOmniFlashDuration = useSettingsStore(
    (s) => s.setOmniFlashDuration,
  );
  // Generation backend — sticky choice; dispatch reads it from here.
  const mediaProvider = useSettingsStore((s) => s.mediaProvider);
  const setMediaProvider = useSettingsStore((s) => s.setMediaProvider);
  const imageModel = useSettingsStore((s) => s.imageModel);
  const setImageModel = useSettingsStore((s) => s.setImageModel);
  // Auto-detected paygate tier (PAYGATE_TIER_ONE / TIER_TWO). Used to
  // lock the Ultra-only model chips (lite_relaxed) for Pro users — same
  // gating as the SettingsPanel.
  const paygateTier = useGenerationStore((s) => s.paygateTier);

  const targetType = node?.data.type ?? "image";
  const isVideo = targetType === "video";
  const isCharacter = targetType === "character";
  const isStoryboard = targetType === "Storyboard";
  // Omni Flash is a video model but with image-target semantics: it
  // takes ingredients (multi reference images), NOT a single i2v start
  // frame. So the dialog should show the same "Source references" chip
  // list that image targets use, and hide Veo's source-image selector.
  const isOmniVideo = isVideo && videoModelFamily === "omni_flash";
  // Prompt nodes are text-only — clicking Generate runs auto_prompt
  // synthesis from upstream context and writes the result back to
  // node.data.prompt. No image dispatch, no aspect/variants.
  const isPrompt = targetType === "prompt";

  // Find upstream source image for video nodes. When the upstream has
  // multiple variants, we batch-i2v one video per variant — `sourceMediaIds`
  // captures the full set; `sourceMediaId` is the active variant for the
  // legacy single-source path.
  const sourceEdge = isVideo ? edges.find((e) => e.target === rfId) : undefined;
  const sourceNode = sourceEdge ? nodes.find((n) => n.id === sourceEdge.source) : undefined;

  // Storyboard → video: when ANY upstream node is a Storyboard composite,
  // the motion prompt MUST follow a fixed template that asks Flow to
  // animate the panels in order. 2x2→4 frames; 2x3→6; 2x4→8. Other
  // refs (character / location / visual_asset) still flow as normal —
  // the prompt itself is what's locked. Pick the first storyboard
  // upstream's grid (multi-storyboard edges are an edge case we don't
  // optimize for).
  const storyboardUpstream = isVideo
    ? edges
        .filter((e) => e.target === rfId)
        .map((e) => nodes.find((n) => n.id === e.source))
        .find((n) => n?.data.type === "Storyboard")
    : undefined;
  const hasStoryboardUpstream = !!storyboardUpstream;
  const storyboardUpstreamGrid = normaliseStoryboardGrid(
    storyboardUpstream?.data.storyboardGrid,
  );
  const sourceMediaId = sourceNode?.data.mediaId ?? null;
  // Drop null placeholders from the upstream variant list — partial-
  // batch results may carry them, but downstream dispatch needs a
  // dense array of valid mediaIds to feed into Flow.
  const sourceMediaIds: string[] = isVideo
    ? (sourceNode?.data.mediaIds ?? (sourceMediaId ? [sourceMediaId] : []))
        .filter((m): m is string => typeof m === "string" && m.length > 0)
    : [];

  // Image nodes: list every upstream ref edge feeding this target. We
  // walk edges (not just nodes) so we can read each edge's variant pin
  // and show the EXACT thumbnail Flow will receive — when an edge is
  // pinned to variant 2 of a 4-variant source, the chip shows variant 2,
  // not the source's "active" mediaId. Mirrors the resolution used by
  // `collectUpstreamRefMediaIds` at dispatch time so the preview can't
  // diverge from the actual API call.
  //
  // We also surface the full `allVariants` list + the edge id so the
  // chip can offer a per-source variant picker without re-querying
  // the store on click.
  // Prompt sources — text-only upstream nodes whose `prompt` feeds the
  // auto-prompt synth as context. They have no mediaId so they live in a
  // separate list from refSourceNodes; the dialog renders them as a
  // text-only chip alongside image refs so the user can SEE that a
  // Prompt node is influencing the gen.
  // Both image targets AND Omni-video targets use the ingredient chip
  // list (multi-ref upstream → one chip per edge). Veo i2v video has
  // its own single-source-with-variant-batch picker below.
  const promptSourceNodes = (!isVideo || isOmniVideo) && rfId
    ? edges
        .filter((e) => e.target === rfId)
        .map((e) => {
          const n = nodes.find((node) => node.id === e.source);
          if (!n || n.data.type !== "prompt") return null;
          const text = typeof n.data.prompt === "string" ? n.data.prompt : "";
          return { edgeId: e.id, node: n, text };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    : [];

  const refSourceNodes = (!isVideo || isOmniVideo) && rfId
    ? edges
        .filter((e) => e.target === rfId)
        .map((e) => {
          const n = nodes.find((node) => node.id === e.source);
          if (!n || !REF_SOURCE_TYPES.has(n.data.type)) return null;
          const variants = (Array.isArray(n.data.mediaIds) ? n.data.mediaIds : [])
            .filter((m): m is string => typeof m === "string" && m.length > 0);
          const pin = (e.data?.sourceVariantIdx ?? null) as number | null;
          let mediaId: string | undefined;
          let variantIdx: number | null = null;
          if (pin !== null && pin >= 0 && pin < variants.length) {
            mediaId = variants[pin];
            variantIdx = pin;
          } else if (typeof n.data.mediaId === "string" && n.data.mediaId) {
            mediaId = n.data.mediaId;
            // When dispatch falls back to source.mediaId, that's
            // typically variants[0] (gen-result writes mediaId =
            // mediaIds[0]). Surface that as the displayed variantIdx
            // so the chip's badge matches what Flow will receive,
            // even before the user clicks to pin explicitly.
            const idx = variants.indexOf(n.data.mediaId);
            variantIdx = idx >= 0 ? idx : null;
          } else if (variants.length > 0) {
            mediaId = variants[0];
            variantIdx = 0;
          }
          if (!mediaId) return null;
          return {
            edgeId: e.id,
            node: n,
            mediaId,
            variantIdx,
            allVariants: variants,
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    : [];

  // Video First+Last frame candidates: collect rendered mediaIds across all
  // upstream image-bearing edges (plus multi-variant fallback on a single edge).
  const videoUpstreamFrames = (() => {
    if (!isVideo || !rfId) return [] as Array<{ mediaId: string; label: string; shortId: string }>;
    const seen = new Set<string>();
    const out: Array<{ mediaId: string; label: string; shortId: string }> = [];
    const upstreamImageEdges = edges.filter((e) => e.target === rfId);
    for (const e of upstreamImageEdges) {
      const n = nodes.find((node) => node.id === e.source);
      if (!n || !REF_SOURCE_TYPES.has(n.data.type)) continue;
      const variants = (Array.isArray(n.data.mediaIds) ? n.data.mediaIds : []).filter(
        (m): m is string => typeof m === "string" && m.length > 0,
      );
      const pin = (e.data?.sourceVariantIdx ?? null) as number | null;
      const chosen =
        pin !== null && pin >= 0 && pin < variants.length
          ? variants[pin]
          : typeof n.data.mediaId === "string" && n.data.mediaId
          ? n.data.mediaId
          : variants[0];
      if (chosen && !seen.has(chosen)) {
        seen.add(chosen);
        out.push({ mediaId: chosen, label: n.data.title, shortId: n.data.shortId });
      }
      if (upstreamImageEdges.length === 1 && variants.length >= 2) {
        variants.forEach((vm, idx) => {
          if (!seen.has(vm)) {
            seen.add(vm);
            out.push({ mediaId: vm, label: `${n.data.title} v${idx + 1}`, shortId: n.data.shortId });
          }
        });
      }
    }
    return out;
  })();
  const canUseFirstLast = isVideo && videoUpstreamFrames.length >= 2;
  const activeFirstLast = canUseFirstLast && firstLastMode;

  // Reset form when dialog opens for a different node
  useEffect(() => {
    if (rfId !== null) {
      // Default: whatever prompt the caller seeded (last-saved on the node,
      // or empty for a fresh gen). Storyboard→video overrides this below
      // with the locked motion template.
      let initialPrompt = openDialog.prompt;
      const openNode = nodes.find((n) => n.id === rfId);
      const openNodeType = openNode?.data.type ?? "image";
      if (openNodeType === "video") {
        const sb = useBoardStore
          .getState()
          .edges.filter((e) => e.target === rfId)
          .map((e) =>
            useBoardStore.getState().nodes.find((n) => n.id === e.source),
          )
          .find((n) => n?.data.type === "Storyboard");
        if (sb) {
          const g = normaliseStoryboardGrid(sb.data.storyboardGrid);
          initialPrompt = buildStoryboardVideoPrompt(g);
        }
      }
      setPrompt(initialPrompt);
      // Character → always 1:1 portrait headshot (its own opinionated
      // default; ignores upstream aspect because character is the source).
      // Image / video → match upstream aspect when available; fall back to
      // landscape (image) / landscape (video) when the graph has no info.
      let nextAspect: AspectKey;
      if (openNodeType === "character") {
        nextAspect = "IMAGE_ASPECT_RATIO_SQUARE";
      } else {
        const inherited = pickDefaultAspect(
          rfId,
          openNodeType,
          nodes,
          useBoardStore.getState().edges,
        );
        if (inherited !== null) {
          nextAspect = inherited;
        } else {
          const globalSide = useSettingsStore.getState().defaultAspect;
          nextAspect = defaultAspectEnum(
            openNodeType === "video" ? "video" : "image",
            globalSide,
          ) as AspectKey;
        }
      }
      setAspectRatio(nextAspect);
      setVariants(1);
      setCamera("dynamic");
      // Hydrate storyboard grid from existing node data when reopening.
      // Fresh nodes + legacy values ("3x3" from 1.2.15-1.2.18) → "2x2".
      const openNodeData = useBoardStore
        .getState()
        .nodes.find((n) => n.id === rfId)?.data;
      setStoryboardGrid(normaliseStoryboardGrid(openNodeData?.storyboardGrid));
      setCharGender(null);
      setCharCountry(null);
      setCharVibe("dramatic_realism");
      setCharExtras("");
      setWhiteStudioAnchor(true);
      setAutoBuilding(false);
      setAutoPromptUsed(false);
      // Default-select every upstream source variant for video targets so
      // the user just hits Generate when they want all videos.
      const upstreamEdge = useBoardStore
        .getState()
        .edges.find((e) => e.target === rfId);
      const upstreamNode = upstreamEdge
        ? useBoardStore.getState().nodes.find((n) => n.id === upstreamEdge.source)
        : undefined;
      const ups =
        upstreamNode?.data.mediaIds ??
        (upstreamNode?.data.mediaId ? [upstreamNode.data.mediaId] : []);
      setSelectedSourceIdx(new Set(ups.map((_, i) => i)));

      // Hydrate First+Last transition mode when >=2 rendered upstream frames exist.
      const curEdges = useBoardStore.getState().edges;
      const curNodes = useBoardStore.getState().nodes;
      const flFrames: string[] = [];
      const flSeen = new Set<string>();
      const inEdges = openNodeType === "video" ? curEdges.filter((e) => e.target === rfId) : [];
      for (const e of inEdges) {
        const sn = curNodes.find((x) => x.id === e.source);
        if (!sn || !REF_SOURCE_TYPES.has(sn.data.type)) continue;
        const vars = (Array.isArray(sn.data.mediaIds) ? sn.data.mediaIds : []).filter(
          (m): m is string => typeof m === "string" && m.length > 0,
        );
        const pin = (e.data?.sourceVariantIdx ?? null) as number | null;
        const mid =
          pin !== null && pin >= 0 && pin < vars.length
            ? vars[pin]
            : typeof sn.data.mediaId === "string" && sn.data.mediaId
            ? sn.data.mediaId
            : vars[0];
        if (mid && !flSeen.has(mid)) {
          flSeen.add(mid);
          flFrames.push(mid);
        }
        if (inEdges.length === 1 && vars.length >= 2) {
          vars.forEach((vm) => {
            if (!flSeen.has(vm)) {
              flSeen.add(vm);
              flFrames.push(vm);
            }
          });
        }
      }
      if (flFrames.length >= 2) {
        setFirstLastMode(openNodeData?.firstLastMode === true);
        setFirstLastStartId(flFrames[0]);
        setFirstLastEndId(flFrames[1]);
      } else {
        setFirstLastMode(false);
        setFirstLastStartId("");
        setFirstLastEndId("");
      }
      setFirstLastDuration(8);

      triggerRef.current = document.activeElement;
      // Focus textarea on open
      setTimeout(() => firstFocusRef.current?.focus(), 50);
    } else {
      // Return focus on close
      if (triggerRef.current instanceof HTMLElement) {
        triggerRef.current.focus();
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rfId]);

  // Keyboard handling
  useEffect(() => {
    if (rfId === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // ESC closes the variant picker first if open, otherwise the
        // dialog. Lets the user back out of a stray picker click
        // without losing their prompt + form state.
        if (openVariantPicker !== null) {
          e.preventDefault();
          setOpenVariantPicker(null);
          return;
        }
        e.preventDefault();
        closeGenerationDialog();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleSubmit();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  // Click-outside to close the variant picker. We listen on
  // `mousedown` instead of `click` so the close fires BEFORE the chip's
  // `onClick` toggle would otherwise re-open it on the same gesture.
  // A click that lands inside any `.ref-source-chip-wrap` is ignored —
  // chip-internal handlers (toggle / swap / pick) own those.
  useEffect(() => {
    if (openVariantPicker === null) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".ref-source-chip-wrap")) return;
      setOpenVariantPicker(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [openVariantPicker]);

  // Focus trap
  useEffect(() => {
    if (rfId === null) return;
    const el = dialogRef.current;
    if (!el) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusable = el.querySelectorAll<HTMLElement>(
        "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    el.addEventListener("keydown", onKeyDown);
    return () => el.removeEventListener("keydown", onKeyDown);
  }, [rfId]);

  if (rfId === null) return null;

  /** Pick a different variant on a Source Reference chip. PATCHes the
   * edge so the dispatch path picks the new variant, then mirrors the
   * change into the local store so the chip thumbnail updates without
   * waiting for a board refresh. The pick also surfaces on the canvas
   * via the `v{N}` chip on the edge. */
  async function pickVariantForEdge(edgeId: string, variantIdx: number) {
    setOpenVariantPicker(null);
    const edgeDbId = parseInt(edgeId, 10);
    if (isNaN(edgeDbId)) return;
    try {
      const updated = await patchEdge(edgeDbId, {
        source_variant_idx: variantIdx,
      });
      useBoardStore.getState().updateEdgeData(edgeId, {
        sourceVariantIdx: updated.source_variant_idx,
      });
    } catch (err) {
      useGenerationStore.setState({
        error: `Couldn't pin variant: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  async function handleSubmit() {
    if (!rfId) return;
    // Defense in depth — block submit if the LLM layer is still composing
    // for this node from a prior dialog session. The Generate button is
    // already `disabled` at this point, but the user could still trigger
    // ⌘↵ via keyboard.
    if (
      node?.data.autoPromptStatus === "pending"
      || node?.data.aiBriefStatus === "pending"
    ) {
      return;
    }
    if (isStoryboard) {
      // Storyboard is a thin image-node wrapper. The user's prompt
      // textarea is the TOPIC; we wrap it in the locked template and
      // dispatch via the standard image path — Flow renders a single
      // composite NxN grid that visually narrates the topic.
      const wrapped = buildStoryboardPrompt(
        prompt,
        storyboardGrid,
        aspectRatio,
      );
      // Persist the chosen grid + topic on the node so reload shows
      // the same settings and `StoryboardBody` can render the grid badge.
      useBoardStore.getState().updateNodeData(rfId, {
        storyboardGrid,
        aiBrief: prompt,
      });
      const dbId = parseInt(rfId, 10);
      if (!isNaN(dbId)) {
        patchNode(dbId, {
          data: { storyboardGrid, aiBrief: prompt },
        }).catch(() => {});
      }
      dispatchGeneration(rfId, {
        prompt: wrapped,
        aspectRatio,
        kind: "image",
        variantCount: variants,
      });
      closeGenerationDialog();
      return;
    }
    if (isPrompt) {
      // Prompt nodes are user-authored seed text. The dialog is just
      // an editor — Save persists whatever the user typed (or cleared).
      // No auto-synth, no image/video dispatch. Downstream image/video
      // nodes pick up this prompt as upstream context at their own
      // dispatch time.
      const dbId = parseInt(rfId, 10);
      if (isNaN(dbId)) {
        closeGenerationDialog();
        return;
      }
      const finalPrompt = prompt;
      useBoardStore.getState().updateNodeData(rfId, {
        prompt: finalPrompt,
        status: finalPrompt.trim() ? "done" : "idle",
      });
      patchNode(dbId, {
        status: finalPrompt.trim() ? "done" : "idle",
        data: { prompt: finalPrompt },
      }).catch(() => {});
      closeGenerationDialog();
      return;
    }
    if (isCharacter) {
      const built = buildCharacterPrompt(
        charGender,
        charCountry,
        charVibe,
        charExtras,
        whiteStudioAnchor,
      );
      // Stamp the picker selections directly onto the node so the detail
      // panel can show "Country: Nhật Bản · Vibe: Douyin" later. These
      // choices don't round-trip through the backend params (they're
      // baked into the prompt text), so we persist them here at dispatch
      // time. patchNode merges, so this fires alongside the generation
      // store's own status patches without colliding.
      const charStamp: Record<string, unknown> = {};
      if (charCountry) charStamp.charCountry = charCountry;
      if (charVibe) charStamp.charVibe = charVibe;
      if (charGender) charStamp.charGender = charGender;
      if (Object.keys(charStamp).length > 0) {
        useBoardStore.getState().updateNodeData(rfId, charStamp);
        const dbId = parseInt(rfId, 10);
        if (!isNaN(dbId)) {
          patchNode(dbId, { data: charStamp }).catch(() => {});
        }
      }
      dispatchGeneration(rfId, {
        prompt: built,
        aspectRatio,
        variantCount: variants,
      });
      closeGenerationDialog();
      return;
    }
    // Image / video branch — if user left the prompt blank, synthesise
    // from upstream briefs (composition prompt for image, motion prompt
    // for video) before dispatching. For image with variants > 1 use the
    // batch endpoint so each variant gets its own pose-distinct prompt.
    let finalPrompt = prompt;
    let perVariantPrompts: string[] | undefined;
    if (!finalPrompt.trim()) {
      const dbId = parseInt(rfId, 10);
      if (isNaN(dbId)) {
        return;
      }
      setAutoBuilding(true);
      // Mark the target node as "auto-prompt running" so the canvas
      // can render a busy treatment + block duplicate dispatches on
      // the same node. Cleared in finally below regardless of outcome.
      useBoardStore.getState().updateNodeData(rfId, { autoPromptStatus: "pending" });
      try {
        if (!isVideo && variants > 1) {
          const res = await autoPromptBatchApi(dbId, variants);
          perVariantPrompts = res.prompts;
          // Show all N prompts joined so the user can verify before
          // dispatch — we don't dispatch until they re-click Generate
          // (so they see what was synthesised first time around either)…
          // actually simpler: dispatch immediately with the first as the
          // "display" prompt; full per-variant list goes through opts.
          finalPrompt = res.prompts[0] ?? "";
          setPrompt(res.prompts.join("\n\n— variant —\n\n"));
        } else {
          const res = await autoPromptApi(dbId, isVideo ? { camera } : undefined);
          finalPrompt = res.prompt;
          setPrompt(finalPrompt);
        }
        setAutoPromptUsed(true);
        useBoardStore.getState().updateNodeData(rfId, { autoPromptStatus: undefined });
      } catch (err) {
        if (mediaProvider === "dry_run") {
          const dryFallback = isVideo
            ? "Smooth 35mm live-action motion shot matching upstream visual references, natural breath and eye movement, motivated room light, NO SUBTITLES."
            : "Live-action 35mm cinematic rehearsal shot matching upstream board references, motivated natural light, NO TEXT IN THE IMAGE.";
          if (!isVideo && variants > 1) {
            perVariantPrompts = Array.from({ length: variants }, (_, i) => `${dryFallback} (camera angle ${i + 1})`);
          }
          finalPrompt = dryFallback;
          setPrompt(finalPrompt);
          useBoardStore.getState().updateNodeData(rfId, { autoPromptStatus: undefined });
        } else {
          setAutoBuilding(false);
          useBoardStore.getState().updateNodeData(rfId, { autoPromptStatus: "failed" });
          useGenerationStore.setState({
            error: err instanceof Error
              ? `Auto-prompt failed: ${err.message}`
              : "Auto-prompt failed",
          });
          return;
        }
      }
      setAutoBuilding(false);
    }
    if (isVideo) {
      // Append the camera-movement constraint to whatever motion prompt
      // we have (manual or auto-synthesised). Putting it last makes it
      // the dominant instruction the model resolves against — overrides
      // any conflicting "slow dolly-in" the synthesizer might have output.
      const camInstruction = cameraInstruction(camera);
      const videoPrompt = camInstruction
        ? `${finalPrompt}. ${camInstruction}`
        : finalPrompt;
      if (activeFirstLast && firstLastStartId && firstLastEndId) {
        const dbId = parseInt(rfId, 10);
        useBoardStore.getState().updateNodeData(rfId, { firstLastMode: true });
        if (!isNaN(dbId)) {
          patchNode(dbId, { data: { firstLastMode: true } }).catch(() => {});
        }
        dispatchGeneration(rfId, {
          prompt: videoPrompt,
          aspectRatio,
          kind: "video",
          firstLastMode: true,
          startMediaId: firstLastStartId,
          endMediaId: firstLastEndId,
          durationS: firstLastDuration,
          variantCount: 1,
        });
      } else {
        if (node?.data.firstLastMode) {
          const dbId = parseInt(rfId, 10);
          useBoardStore.getState().updateNodeData(rfId, { firstLastMode: false });
          if (!isNaN(dbId)) {
            patchNode(dbId, { data: { firstLastMode: false } }).catch(() => {});
          }
        }
        // Filter the upstream variants to the user's selection — the dialog
        // shows one toggleable thumbnail per variant + an All/None action.
        const picked = sourceMediaIds.filter((_, i) => selectedSourceIdx.has(i));
        const useMulti = picked.length > 1;
        dispatchGeneration(rfId, {
          prompt: videoPrompt,
          aspectRatio,
          kind: "video",
          sourceMediaId: useMulti ? undefined : picked[0],
          sourceMediaIds: useMulti ? picked : undefined,
          // Tell the node UI how many video tiles to reserve while pending —
          // otherwise it defaults to 1 placeholder even though we're
          // dispatching N i2v ops.
          variantCount: picked.length,
        });
      }
    } else {
      dispatchGeneration(rfId, {
        prompt: finalPrompt,
        aspectRatio,
        variantCount: variants,
        prompts: perVariantPrompts,
      });
    }
    closeGenerationDialog();
  }

  // The dialog's local `autoBuilding` flag covers the in-flight window
  // when THIS dialog instance is composing. But the dialog can be closed
  // + reopened mid-flight, leaving the local flag fresh while the node-
  // level `autoPromptStatus` / `aiBriefStatus` is still pending from the
  // first run. Treat both signals as "busy" so the user can't double-fire.
  const nodeLLMBusy =
    node?.data.autoPromptStatus === "pending"
    || node?.data.aiBriefStatus === "pending";
  const isWorking = autoBuilding || nodeLLMBusy;

  // Both image and video allow empty prompt — we'll auto-synth on submit.
  // Veo i2v needs at least one selected source variant; Omni Flash
  // needs at least one ingredient (any upstream image-bearing node).
  // Other targets just need the LLM not be busy.
  const canGenerate = isCharacter
    ? charGender !== null || charCountry !== null || charExtras.trim().length > 0
    : activeFirstLast
    ? Boolean(firstLastStartId && firstLastEndId && firstLastStartId !== firstLastEndId) && !isWorking
    : isOmniVideo
    ? refSourceNodes.length > 0 && !isWorking
    : isVideo
    ? selectedSourceIdx.size > 0 && !isWorking
    : !isWorking;

  return (
    <div
      className="gen-dialog-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeGenerationDialog();
      }}
    >
      <div
        className="gen-dialog"
        role="dialog"
        aria-labelledby="gen-dialog-title"
        aria-modal="true"
        ref={dialogRef}
      >
        {/* Header */}
        <div className="gen-dialog__header">
          <div>
            <h2 id="gen-dialog-title" className="gen-dialog__title">
              {isVideo
                ? t("生成动态运镜视频", "Generate video")
                : isCharacter
                ? t("生成角色锁脸锚点", "Generate character")
                : isStoryboard
                ? t("生成分镜故事板", "Generate storyboard")
                : isPrompt
                ? t("编辑导演提示词", "Edit prompt")
                : t("生成电影分镜画面", "Generate image")}
            </h2>
            <span className="gen-dialog__subtitle">
              {t(`节点 #${node?.data.shortId ?? rfId}`, `Node #${node?.data.shortId ?? rfId}`)}
            </span>
          </div>
          <button
            className="gen-dialog__close"
            onClick={closeGenerationDialog}
            aria-label="Close dialog (Escape)"
          >
            esc
          </button>
        </div>

        {/* Prompt — hidden when character mode shows the builder instead */}
        {!isCharacter && (
          <div className="gen-dialog__field">
            <div className="gen-dialog__label-row">
              <label className="gen-dialog__label" htmlFor="gen-prompt">
                {isVideo ? t("运镜与动作提示词（可留空自动编写）", "Motion prompt") : t("画面提示词（可留空自动编写）", "Prompt")}
                {autoPromptUsed && (
                  <span className="gen-dialog__auto-badge" title={t("已由本机 AI 根据上游节点自动生成", "Auto-generated from upstream nodes")}>
                    {t("✨ 自动生成", "✨ auto")}
                  </span>
                )}
              </label>
              <div className="gen-dialog__label-tools">
                {!isStoryboard && !hasStoryboardUpstream && prompt.trim().length > 0 && (
                  <button
                    type="button"
                    className="source-select-mini"
                    disabled={polishingPrompt || isWorking}
                    onClick={async () => {
                      setPolishingPrompt(true);
                      try {
                        const res = await polishPromptApi({
                          raw_text: prompt,
                          mode: isVideo ? (activeFirstLast ? "first_last" : isOmniVideo ? "omni" : "video") : "image",
                          camera,
                        });
                        setPrompt(res.prompt);
                      } catch {
                        // Keep draft on error
                      } finally {
                        setPolishingPrompt(false);
                      }
                    }}
                    title={t("按 Flow 2026 + Realman 规范净化/润色（清除 3200K/[]/—/$）", "Polish & sanitize into Flow 2026 prose")}
                  >
                    {polishingPrompt ? t("润色中…", "Polishing…") : t("✨ 导演润色", "✨ Polish")}
                  </button>
                )}
                <span className="gen-dialog__char-count">{prompt.length}/1500</span>
              </div>
            </div>
            <textarea
              id="gen-prompt"
              ref={firstFocusRef}
              className="gen-dialog__textarea"
              rows={5}
              maxLength={1500}
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                if (autoPromptUsed) setAutoPromptUsed(false);
              }}
              placeholder={
                isVideo
                  ? t("直接留空即可自动按 0-3s / 3-6s / 6-8s 编写叙事微动作与动态运镜提示词 ✨（也可手动输入英文提示词）", "Leave blank to auto-synthesize cinematic motion & camera beats from the source image ✨")
                  : isPrompt
                  ? t("输入通用导演风格/光影指令，连线给下游分镜图或视频节点…", "Enter reusable style/lighting direction to feed downstream image / video nodes…")
                  : t("直接留空即可结合上游角色与场景，自动生成多机位电影分镜提示词 ✨（也可手动输入英文提示词）", "Leave blank to auto-synthesize cinematic shot prompts from upstream nodes ✨")
              }
              disabled={isWorking}
              readOnly={hasStoryboardUpstream}
              title={
                hasStoryboardUpstream
                  ? "Locked: storyboard motion template (animates panels in order)"
                  : undefined
              }
            />
            {hasStoryboardUpstream && (
              <p className="gen-dialog__hint gen-dialog__hint--locked">
                🎬 <strong>Storyboard motion template</strong> — locked because an
                upstream Storyboard node is feeding this video. Flow animates
                the composite panels in order (frame 1 →
                {" "}{totalPanels(storyboardUpstreamGrid)}). Other refs
                (character / location / visual_asset) still flow through normally.
              </p>
            )}
            {isWorking && (
              <p className="gen-dialog__hint">
                {node?.data.aiBriefStatus === "pending"
                  ? t("✨ 正在识别上游参考画面…", "✨ Analyzing source image…")
                  : t("✨ 正在根据上游参考编写电影分镜提示词…", "✨ Composing prompt from upstream context…")}
              </p>
            )}
          </div>
        )}

        {/* Character builder (character node only) */}
        {isCharacter && (
          <>
            <div className="gen-dialog__field">
              <span className="gen-dialog__label">{t("角色性别", "Gender")}</span>
              <div className="aspect-chip-row">
                {CHARACTER_GENDERS.map((g) => (
                  <button
                    key={g.key}
                    type="button"
                    className={`aspect-chip${charGender === g.key ? " aspect-chip--active" : ""}`}
                    onClick={() => setCharGender(charGender === g.key ? null : g.key)}
                  >
                    {isZh ? g.labelZh : g.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="gen-dialog__field">
              <span className="gen-dialog__label">{t("地区 / 骨相特征", "Region / Look")}</span>
              <div className="aspect-chip-row">
                {CHARACTER_COUNTRIES.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    className={`aspect-chip${charCountry === c.key ? " aspect-chip--active" : ""}`}
                    onClick={() => setCharCountry(charCountry === c.key ? null : c.key)}
                  >
                    {isZh ? c.labelZh : c.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="gen-dialog__field">
              <span className="gen-dialog__label">{t("人物妆造气质", "Vibe")}</span>
              <div className="aspect-chip-row">
                {CHARACTER_VIBES.map((v) => (
                  <button
                    key={v.key}
                    type="button"
                    className={`aspect-chip${charVibe === v.key ? " aspect-chip--active" : ""}`}
                    onClick={() => setCharVibe(v.key)}
                  >
                    {isZh ? v.labelZh : v.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="gen-dialog__field">
              <label className="gen-dialog__checkbox-row">
                <input
                  type="checkbox"
                  checked={whiteStudioAnchor}
                  onChange={(e) => setWhiteStudioAnchor(e.target.checked)}
                />
                <span>
                  {t(
                    "纯白底棚拍胸上锁脸锚点（推荐：跨镜融合时零背景穿模、零变脸）",
                    "Seamless pure-white bust portrait anchor (zero background bleed)",
                  )}
                </span>
              </label>
            </div>

            <div className="gen-dialog__field">
              <div className="gen-dialog__label-row">
                <label className="gen-dialog__label" htmlFor="gen-char-extras">
                  {t("补充人物设定（可选，建议用英文）", "Extra character details (optional)")}
                  <InfoTip tip={t("自动拼接清晰五官锁脸中性光 + 剧情世界观妆造质感，确保后续 Veo 视频不崩脸。", "Auto-builds clear facial structure + neutral face light + world-consistent styling for Veo identity lock.")} />
                </label>
                <span className="gen-dialog__char-count">{charExtras.length}/200</span>
              </div>
              <textarea
                id="gen-char-extras"
                ref={firstFocusRef}
                className="gen-dialog__textarea"
                rows={3}
                maxLength={200}
                value={charExtras}
                onChange={(e) => setCharExtras(e.target.value)}
                placeholder={t("例如：30s corporate heiress, dark tailored coat, calm sharp gaze…", "Age, hairstyle, outfit, demeanor…")}
              />
            </div>
          </>
        )}

        {/* First + Last frame transition mode (RPC nprQif) when >= 2 upstream frames exist */}
        {canUseFirstLast && (
          <div className="gen-dialog__field first-last-box">
            <div className="gen-dialog__label-row">
              <span className="gen-dialog__label">
                {t("🎞️ 首尾帧过渡模式 (Start → End · nprQif)", "🎞️ First → Last Transition (nprQif)")}
                <InfoTip tip={t("适合同机位特效变身、光影渐变：传入起幅图与落幅图，由 Omni Flash 在两端之间精准生成连续过渡。不同场景跨机位严禁强用。", "Same-camera Start → End transition via Omni Flash. Ideal for morphs & lighting shifts.")} />
              </span>
              <button
                type="button"
                className={`aspect-chip${firstLastMode ? " aspect-chip--active" : ""}`}
                onClick={() => setFirstLastMode((v) => !v)}
              >
                {firstLastMode
                  ? t("✓ 已启用首尾帧", "✓ Enabled")
                  : t("开启首尾帧", "Enable Start→End")}
              </button>
            </div>

            {firstLastMode && (
              <div className="first-last-panel">
                <div className="first-last-pair">
                  <div className="first-last-slot">
                    <span className="first-last-slot__tag">{t("起幅 Start", "Start")}</span>
                    <img
                      className="first-last-slot__img"
                      src={mediaUrl(firstLastStartId)}
                      alt="Start frame"
                    />
                  </div>
                  <button
                    type="button"
                    className="first-last-swap-btn"
                    title={t("一键互换起幅与落幅", "Swap Start & End frames")}
                    onClick={() => {
                      const prevStart = firstLastStartId;
                      setFirstLastStartId(firstLastEndId);
                      setFirstLastEndId(prevStart);
                    }}
                  >
                    ⇄
                  </button>
                  <div className="first-last-slot">
                    <span className="first-last-slot__tag first-last-slot__tag--end">{t("落幅 End", "End")}</span>
                    <img
                      className="first-last-slot__img"
                      src={mediaUrl(firstLastEndId)}
                      alt="End frame"
                    />
                  </div>
                </div>

                {videoUpstreamFrames.length > 2 && (
                  <div className="first-last-candidates">
                    {videoUpstreamFrames.map((f) => {
                      const isStart = f.mediaId === firstLastStartId;
                      const isEnd = f.mediaId === firstLastEndId;
                      return (
                        <div key={f.mediaId} className="first-last-cand">
                          <img className="first-last-cand__img" src={mediaUrl(f.mediaId)} alt={f.label} />
                          <div className="first-last-cand__btns">
                            <button
                              type="button"
                              className={`source-select-mini${isStart ? " first-last-cand__btn--active" : ""}`}
                              onClick={() => setFirstLastStartId(f.mediaId)}
                            >
                              {t("设起幅", "Start")}
                            </button>
                            <button
                              type="button"
                              className={`source-select-mini${isEnd ? " first-last-cand__btn--active" : ""}`}
                              onClick={() => setFirstLastEndId(f.mediaId)}
                            >
                              {t("设落幅", "End")}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                <div className="aspect-chip-row" style={{ marginTop: 6 }}>
                  {OMNI_FLASH_DURATIONS.map((d) => (
                    <button
                      key={d}
                      type="button"
                      className={`aspect-chip${firstLastDuration === d ? " aspect-chip--active" : ""}`}
                      onClick={() => setFirstLastDuration(d as OmniFlashDuration)}
                    >
                      {d}s
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Source image — Veo i2v ONLY. Omni Flash uses the ingredient
            chip list (`refSourceNodes`) above, same shape as image
            targets. */}
        {isVideo && !isOmniVideo && !activeFirstLast && (
          <div className="gen-dialog__field">
            <div className="gen-dialog__label-row">
              <span className="gen-dialog__label">
                {t(`首帧来源图${sourceMediaIds.length > 1 ? ` (${sourceMediaIds.length} 张可选)` : ""}`, `Source image${sourceMediaIds.length > 1 ? `s (${sourceMediaIds.length})` : ""}`)}
              </span>
              {sourceMediaIds.length > 1 && (
                <div className="source-select-actions">
                  <button
                    type="button"
                    className="source-select-mini"
                    onClick={() =>
                      setSelectedSourceIdx(
                        new Set(sourceMediaIds.map((_, i) => i)),
                      )
                    }
                  >
                    {t("全选", "All")}
                  </button>
                  <button
                    type="button"
                    className="source-select-mini"
                    onClick={() => setSelectedSourceIdx(new Set())}
                  >
                    {t("全不选", "None")}
                  </button>
                </div>
              )}
            </div>
            {sourceMediaIds.length > 0 && sourceNode ? (
              <>
                <div className="source-image-row">
                  {sourceMediaIds.map((mid, i) => {
                    const checked = selectedSourceIdx.has(i);
                    return (
                      <button
                        key={mid}
                        type="button"
                        className={`source-thumb${checked ? " source-thumb--checked" : ""}`}
                        onClick={() => {
                          setSelectedSourceIdx((prev) => {
                            const next = new Set(prev);
                            if (next.has(i)) next.delete(i);
                            else next.add(i);
                            return next;
                          });
                        }}
                        aria-pressed={checked}
                        aria-label={`Variant ${i + 1}${checked ? " selected" : ""}`}
                      >
                        <img
                          className="source-image-row__thumb"
                          src={mediaUrl(mid)}
                          alt={sourceNode.data.title}
                        />
                        <span className="source-thumb__check" aria-hidden="true">
                          {checked ? "✓" : ""}
                        </span>
                      </button>
                    );
                  })}
                  <span className="source-image-row__label">
                    #{sourceNode.data.shortId}
                  </span>
                </div>
                <p className="gen-dialog__hint">
                  {selectedSourceIdx.size === 0 ? (
                    <span style={{ color: "#ef4444" }}>
                      {t("请至少勾选 1 张首帧画面来生成视频。", "Select at least 1 variant to generate video.")}
                    </span>
                  ) : isZh ? (
                    <>
                      将按相同提示词与运镜设置生成 <strong>{selectedSourceIdx.size} 条视频</strong>
                      {selectedSourceIdx.size === sourceMediaIds.length
                        ? "（全部变体）"
                        : `（已选 ${selectedSourceIdx.size}/${sourceMediaIds.length} 张）`}。
                    </>
                  ) : (
                    <>
                      Will generate <strong>{selectedSourceIdx.size} video(s)</strong> with the same prompt & camera setting.
                    </>
                  )}
                </p>
              </>
            ) : (
              <div className="source-image-row source-image-row--empty">
                {t("请先从左侧连入一张已生成画面的「分镜画面」节点作为视频首帧", "Connect an upstream image node with rendered media first")}
              </div>
            )}
          </div>
        )}

        {/* Source references — image refs (character/image/visual_asset/
            Storyboard) AND prompt-text refs. Prompt nodes don't have
            media but their text feeds the auto-prompt synth, so we
            surface them as text chips next to the thumbnails. */}
        {(!isVideo || isOmniVideo) && !activeFirstLast
          && (refSourceNodes.length > 0 || promptSourceNodes.length > 0)
          && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              {t(`已连入参考源 (${refSourceNodes.length + promptSourceNodes.length})`, `Source references (${refSourceNodes.length + promptSourceNodes.length})`)}
            </span>
            <div className="ref-source-row">
              {promptSourceNodes.map((p) => {
                const preview = p.text.trim() || "(empty prompt)";
                return (
                  <div
                    key={p.edgeId}
                    className="ref-source-chip ref-source-chip--prompt"
                    title={`${p.node.data.title || "Prompt"} — ${preview}`}
                  >
                    <div className="ref-source-chip__prompt-body">
                      <span className="ref-source-chip__prompt-icon" aria-hidden="true">✦</span>
                      <span className="ref-source-chip__prompt-text">
                        {preview}
                      </span>
                    </div>
                    <span className="ref-source-chip__id">
                      #{p.node.data.shortId}
                    </span>
                  </div>
                );
              })}
              {refSourceNodes.map((r) => {
                const isMulti = r.allVariants.length >= 2;
                const isPickerOpen = openVariantPicker === r.edgeId;
                const tooltip = isMulti
                  ? `${r.node.data.title} — variant ${(r.variantIdx ?? 0) + 1} · click to switch`
                  : r.node.data.title;
                return (
                  <div key={r.edgeId} className="ref-source-chip-wrap">
                    {isMulti ? (
                      <button
                        type="button"
                        className={`ref-source-chip ref-source-chip--switchable${
                          isPickerOpen ? " ref-source-chip--active" : ""
                        }`}
                        title={tooltip}
                        onClick={() =>
                          setOpenVariantPicker(isPickerOpen ? null : r.edgeId)
                        }
                      >
                        <img
                          className="ref-source-chip__img"
                          src={mediaUrl(r.mediaId)}
                          alt={r.node.data.title}
                        />
                        <span className="ref-source-chip__variant">
                          v{(r.variantIdx ?? 0) + 1}
                        </span>
                        <span className="ref-source-chip__id">
                          #{r.node.data.shortId}
                        </span>
                      </button>
                    ) : (
                      <div className="ref-source-chip" title={tooltip}>
                        <img
                          className="ref-source-chip__img"
                          src={mediaUrl(r.mediaId)}
                          alt={r.node.data.title}
                        />
                        <span className="ref-source-chip__id">
                          #{r.node.data.shortId}
                        </span>
                      </div>
                    )}
                    {isMulti && isPickerOpen && (
                      <div
                        className="ref-source-chip__picker"
                        role="dialog"
                        aria-label={`Pick variant for ${r.node.data.title}`}
                      >
                        {r.allVariants.map((mid, i) => {
                          const isCurrent = i === (r.variantIdx ?? 0);
                          return (
                            <button
                              key={mid}
                              type="button"
                              className={`ref-source-chip__picker-item${
                                isCurrent ? " ref-source-chip__picker-item--current" : ""
                              }`}
                              onClick={() => void pickVariantForEdge(r.edgeId, i)}
                              title={`Variant ${i + 1}`}
                              aria-current={isCurrent ? "true" : undefined}
                            >
                              <img
                                className="ref-source-chip__picker-img"
                                src={mediaUrl(mid)}
                                alt={`Variant ${i + 1}`}
                              />
                              <span className="ref-source-chip__picker-label">
                                v{i + 1}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Backend — which engine renders this dispatch. Sticky across
            dialogs (settings store). Muse = muse2api gateway, or a
            Pax worker via the provider-job queue; no Flow plan or
            extension needed. */}
        {!isPrompt && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              {t("生成通道", "Backend")}
              <InfoTip tip={t("Flow 实拍 = 通过 Chrome 扩展直连你的 Google Flow AI Ultra 账号；Midjourney V7 = 启用 MJ V7 (--v 7 --oref) 电影级审美生图并可无缝接给 Flow 视频节点；干跑测试 = 0积分本地极速演练。", "Flow = Chrome extension → Google Flow. Midjourney V7 = MJ V7 aesthetic image engine. Dry Run = 0-credit local rehearsal.")} />
            </span>
            <div className="aspect-chip-row">
              <button
                key="flow"
                type="button"
                className={`aspect-chip${mediaProvider === "flow" && (isVideo || imageModel !== "MIDJOURNEY_V7") ? " aspect-chip--active" : ""}`}
                onClick={() => {
                  setMediaProvider("flow");
                  if (!isVideo && imageModel === "MIDJOURNEY_V7") {
                    setImageModel("NANO_BANANA_PRO");
                  }
                }}
              >
                {t("🎬 Flow 实拍", "Flow")}
              </button>
              {!isVideo && (
                <button
                  key="midjourney"
                  type="button"
                  className={`aspect-chip${(mediaProvider === "midjourney" || (mediaProvider === "flow" && imageModel === "MIDJOURNEY_V7")) ? " aspect-chip--active" : ""}`}
                  onClick={() => {
                    setMediaProvider("flow");
                    setImageModel("MIDJOURNEY_V7");
                  }}
                >
                  {t("🎨 Midjourney V7", "🎨 Midjourney V7")}
                </button>
              )}
              <button
                key="dry_run"
                type="button"
                className={`aspect-chip${mediaProvider === "dry_run" ? " aspect-chip--active aspect-chip--dryrun" : ""}`}
                onClick={() => setMediaProvider("dry_run")}
              >
                {t("🧪 干跑测试 (0积分)", "🧪 Dry Run (0c)")}
              </button>
              <button
                key="muse"
                type="button"
                className={`aspect-chip${mediaProvider === "muse" ? " aspect-chip--active" : ""}`}
                onClick={() => setMediaProvider("muse")}
              >
                Muse
              </button>
            </div>
          </div>
        )}

        {/* Aspect ratio — irrelevant for prompt nodes (text-only). */}
        {!isPrompt && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">{t("画幅比例", "Aspect ratio")}</span>
            <div className="aspect-chip-row">
              {(isVideo ? VIDEO_ASPECT_RATIOS : IMAGE_ASPECT_RATIOS).map((ar) => (
                <button
                  key={ar.key}
                  className={`aspect-chip${aspectRatio === ar.key ? " aspect-chip--active" : ""}`}
                  onClick={() => setAspectRatio(ar.key)}
                  type="button"
                >
                  {ar.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Omni Flash duration picker — video only, when the user's
            settings select the Omni model family. Replaces the implicit
            ~8s Veo duration with a per-dispatch radio. Credit cost is
            surfaced beside each option. */}
        {isOmniVideo && !activeFirstLast && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              Duration (Omni Flash)
              <InfoTip tip="Omni Flash dispatches via video:batchAsyncGenerateVideoReferenceImages with the upstream image(s) as IMAGE_USAGE_TYPE_ASSET refs. Duration scales credit cost: 4s=15, 6s=20, 8s=25, 10s=30." />
            </span>
            <div className="aspect-chip-row">
              {OMNI_FLASH_DURATIONS.map((d) => {
                const active = omniFlashDuration === d;
                return (
                  <button
                    key={d}
                    type="button"
                    className={`aspect-chip${active ? " aspect-chip--active" : ""}`}
                    onClick={() =>
                      setOmniFlashDuration(d as OmniFlashDuration)
                    }
                    title={`${d}s — ${OMNI_FLASH_CREDIT_COST[d]} credits`}
                  >
                    {d}s · {OMNI_FLASH_CREDIT_COST[d]}c
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Model picker (video only) — mirrors the unified list from
            SettingsPanel. Native <select> for compactness; selecting an
            option stamps videoModel + videoQuality on the global
            settings store so the override sticks for the next dispatch.
            Encode option `value` as "veo:<quality>" or "omni" so the
            change handler can split it back into the two store fields. */}
        {isVideo && !activeFirstLast && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              {t("视频模型档位", "Model")}
              <InfoTip tip={t("切换后会自动记住：Veo 3.1 为首帧图生视频（Lite Low Priority 为 Ultra 0 积分闲时通道）；Omni Flash 支持多参考图与 4/6/8/10 秒可选时长。", "Sticky across dispatches. Veo uses i2v start frame; Omni Flash uses multi-image ingredients.")} />
            </span>
            <select
              className="gen-dialog__select"
              value={
                videoModelFamily === "omni_flash"
                  ? "omni"
                  : `veo:${videoQuality}`
              }
              onChange={(e) => {
                const v = e.target.value;
                if (v === "omni") {
                  setVideoModel("omni_flash");
                  return;
                }
                const [, quality] = v.split(":") as ["veo", VideoQuality];
                setVideoModel("veo");
                setVideoQuality(quality);
              }}
            >
              {VIDEO_MODEL_CHIPS.map((m) => {
                if (m.kind === "omni") {
                  return (
                    <option key="omni" value="omni">
                      Omni Flash
                    </option>
                  );
                }
                const locked =
                  m.ultraOnly && paygateTier !== "PAYGATE_TIER_TWO";
                return (
                  <option
                    key={`veo:${m.quality}`}
                    value={`veo:${m.quality}`}
                    disabled={locked}
                  >
                    {m.label}
                    {m.ultraOnly ? " · Ultra only" : ""}
                  </option>
                );
              })}
            </select>
          </div>
        )}

        {/* Camera movement (video only) */}
        {isVideo && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              {t("摄影机运镜模式", "Camera")}
              <InfoTip tip={t("已按 flow-evolve 2026 标准升级：支持自动运镜、固定机位、M01 慢推情绪、M02 缓拉交代、M05 平稳跟拍、M11 180°过肩正反打、M10 拉焦转移与 M09 轻弧环绕。", "Supports Dynamic, Static tripod, Dolly-in/out, Tracking, 180° OTS, Rack Focus, and Subtle Orbit.")} />
            </span>
            <div className="aspect-chip-row">
              {CAMERA_MOVEMENTS.map((c) => (
                <button
                  key={c.key}
                  className={`aspect-chip${camera === c.key ? " aspect-chip--active" : ""}`}
                  onClick={() => setCamera(c.key)}
                  type="button"
                  title={c.instruction}
                >
                  {isZh ? c.labelZh : c.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Variants stepper — image + storyboard (storyboard reuses the
            image dispatch path; up to 4 composite variants per request).
            Hidden for video (its own one-clip-per-source-variant flow
            above) and prompt nodes. */}
        {!isVideo && !isPrompt && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">{t("生成变体数（多机位覆盖）", "Variants")}</span>
            <div className="variants-stepper">
              <button
                type="button"
                disabled={variants <= 1}
                aria-label={t("减少张数", "Decrease variants")}
                onClick={() => setVariants((v) => Math.max(1, v - 1))}
              >
                −
              </button>
              <span>{variants}</span>
              <button
                type="button"
                disabled={variants >= 4}
                aria-label={t("增加张数", "Increase variants")}
                onClick={() => setVariants((v) => Math.min(4, v + 1))}
              >
                +
              </button>
              <span className="variants-stepper__hint">{t("单次可出 1–4 张不同景别机位", "1–4 images per request")}</span>
            </div>
          </div>
        )}

        {/* Grid radio — storyboard only. Three options: 2x2 (4 panels),
            2x3 (6), 2x4 (8). For 2x3 / 2x4 the rows × cols flip based on
            the chosen aspect ratio: landscape → wide grid (e.g. 2×3),
            portrait → tall grid (3×2). */}
        {isStoryboard && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              {t("分镜网格布局", "Grid")}
              <InfoTip tip={t("故事板会一次性画出多宫格连续剧情分镜。2×3 / 2×4 会随画幅竖屏/横屏自动翻转行列（竖屏变成 3×2 / 4×2 保持每格清晰）。", "Storyboard renders a composite grid and flips rows×cols for portrait shots.")} />
            </span>
            <div className="aspect-chip-row">
              {STORYBOARD_GRIDS.map((g) => {
                const total = totalPanels(g);
                const isPortrait = aspectRatio.includes("PORTRAIT");
                // For symmetric 2x2 the label is just "2×2". For 2x3 /
                // 2x4 we render the concrete rows×cols pair that Flow
                // will receive, so the user sees orientation reflected.
                let dimsLabel = "2×2";
                if (g !== "2x2") {
                  const big = g === "2x3" ? 3 : 4;
                  dimsLabel = isPortrait ? `${big}×2` : `2×${big}`;
                }
                return (
                  <button
                    key={g}
                    type="button"
                    className={`aspect-chip${storyboardGrid === g ? " aspect-chip--active" : ""}`}
                    onClick={() => setStoryboardGrid(g)}
                    title={`${total} panels (${dimsLabel})`}
                  >
                    {dimsLabel} · {total} panels
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="gen-dialog__footer">
          <span className="gen-dialog__board-ctx">
            {displayBoardName(boardName, lang)} · {t(`${nodeCount} 个节点`, `${nodeCount} node${nodeCount !== 1 ? "s" : ""}`)}
          </span>
          <button
            className="gen-dialog__cta"
            type="button"
            onClick={handleSubmit}
            disabled={!canGenerate}
            title={
              nodeLLMBusy && !autoBuilding
                ? t("后台正在合成提示词，请稍候", "Backend is still composing — try again in a moment")
                : undefined
            }
          >
            {isWorking
              ? t("正在编写提示词…", "Building…")
              : isPrompt
              ? t("保存指令 ⌘↵", "Save ⌘↵")
              : t("开始生成 ⌘↵", "Generate ⌘↵")}
          </button>
        </div>
      </div>
    </div>
  );
}
