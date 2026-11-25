"""Auto-prompt synthesizer (Cinematic & Short-Drama Narrative Edition).

Given a target node, walks the immediate-upstream graph, collects
``aiBrief`` / ``prompt`` text from each parent node, and asks the configured
Auto-Prompt provider to compose cinematic character-anchor, multi-angle shot
coverage, or Veo 3.1 / Omni narrative motion prompts.

Provider routing goes through ``run_llm("auto_prompt", ...)``. User picks
which one in Settings → AI Providers (e.g., Gemini via ``agy`` CLI, Claude,
or Codex).
"""
from __future__ import annotations

import json
import logging
import re
from typing import Optional

from sqlmodel import select

from flowboard.db import get_session
from flowboard.db.models import Edge, Node
from flowboard.node_mirror import apply_node_patch
from flowboard.services.activity import record_activity
from flowboard.services.llm import run_llm
from flowboard.services.llm.base import LLMError

logger = logging.getLogger(__name__)


_HEX_COLOR_RE = re.compile(r"(?<![A-Za-z0-9])#[0-9a-fA-F]{6}\b")
_WARM_KELVIN_RE = re.compile(r"\b(?:2[4-9]00|3[0-4]00)\s*K\b", re.IGNORECASE)
_DAYLIGHT_KELVIN_RE = re.compile(r"\b(?:5[0-9]00|6[0-5]00)\s*K\b", re.IGNORECASE)
_ANY_KELVIN_RE = re.compile(r"\b[1-9]\d{3}\s*K\b")
_BRACKET_HEADER_RE = re.compile(
    r"\[(?:Scene\s*\d*|Shot\s*\d*|Kitchen|Living\s*Room|Bedroom|Hallway|Exterior|Interior|EXT\.?|INT\.?|[^\]]{1,24})\]\s*",
    re.IGNORECASE,
)
_DOLLAR_AMOUNT_RE = re.compile(r"\$\s*(\d[\d,]*(?:\.\d+)?)")
_JARGON_TAGS_RE = re.compile(
    r"(?:机位理由|负空间声明|禁止换脸|禁止越轴|防穿模声明|摄影机理由|导演备注)\s*[:：]?\s*",
)


def sanitize_flow_prompt(text: str) -> str:
    """Strip 2026 Google Flow OBS hazard tokens without disturbing clean prose.

    Rules synced with flow-evolve / FAILURES-MODES:
      - No Kelvin color temps (2700K/3200K/5600K) that Flow OCR burns as labels
      - No #RRGGBB hex codes
      - No [Scene]/[Kitchen] bracket headers
      - No em-dashes ``—`` (use commas)
      - No ``$`` currency symbols
      - No Chinese production-jargon labels (e.g. ``机位理由：``)
    """
    if not text:
        return ""
    cleaned = text
    cleaned = _WARM_KELVIN_RE.sub("warm tungsten light", cleaned)
    cleaned = _DAYLIGHT_KELVIN_RE.sub("crisp natural daylight", cleaned)
    cleaned = _ANY_KELVIN_RE.sub("balanced natural light", cleaned)
    cleaned = _HEX_COLOR_RE.sub("", cleaned)
    cleaned = _BRACKET_HEADER_RE.sub("", cleaned)
    cleaned = cleaned.replace("—", ", ")
    cleaned = _DOLLAR_AMOUNT_RE.sub(r"\1 dollars", cleaned)
    cleaned = cleaned.replace("$", "")
    cleaned = _JARGON_TAGS_RE.sub("", cleaned)
    cleaned = re.sub(r"\s{2,}", " ", cleaned)
    cleaned = re.sub(r"\s+([,.!?;:])", r"\1", cleaned)
    return cleaned.strip()


# Character anchor system prompt: keeps crisp facial geometry, micro-pores
# Realman realism, and balanced neutral key light on the face for Veo
# identity-lock consistency.
_SYNTH_SYSTEM_CHARACTER = (
    "You are a cinematic casting & character-anchor prompt builder for a film "
    "and narrative short-drama pipeline (2026 Google Flow / Veo 3.1 / Omni "
    "Flash standards). Output ONE concise sentence (max 320 chars) for a "
    "photorealistic character reference portrait combining the input briefs.\n\n"
    "CHARACTER IDENTITY LOCK & REALMAN STYLING RULES:\n"
    "  • FACIAL CLARITY FOR VEO LOCK: keep both eyes, nose bridge, jawline, and "
    "facial structure clearly visible and unobstructed, lit by soft, even, "
    "balanced neutral key light on the face so downstream Veo i2v / multi-shot "
    "reference locking stays rock-solid without shadow-induced identity drift.\n"
    "  • REALMAN SKIN & TEXTURE (NO PLASTIC AI SHEEN): preserve natural pores, "
    "fine skin grain, authentic makeup texture, period or genre hairstyle, and "
    "lived-in collar texture; NEVER request beauty-filter airbrushing.\n"
    "  • EXPRESSION & POISE: grounded dramatic poise (calm resolve, guarded "
    "stillness, quiet intensity) with relaxed natural lips — avoid extreme "
    "grimaces that warp facial geometry.\n"
    "  • FRAMING & FLOW SAFETY: chest-up bust portrait facing front or subtle "
    "three-quarter poise on a clean uncluttered studio background, 50mm-85mm "
    "cinema prime lens, zero Kelvin numbers, zero brackets, zero em-dashes. "
    "End with 'NO TEXT IN THE IMAGE.' Output the prompt only."
)


_SYNTH_SYSTEM_IMAGE = (
    "You are a film director and cinematographer building shot-composition "
    "prompts for a cinematic narrative / short-drama pipeline (2026 Google "
    "Flow Nano Banana Pro & Realman live-action standards). Output ONE "
    "concise cinematic prose sentence (target 45-95 words, max 420 chars) "
    "for a photorealistic cinema frame combining the input briefs.\n\n"
    "CINEMATIC STAGING, ANTI-TELEPORT LOCKS & FOURTH-WALL RULES:\n"
    "  • FOURTH-WALL EYELINE: NEVER use e-commerce lookbook posing or unmotivated "
    "direct-to-lens catalogue staring. Direct the character's gaze into the "
    "narrative space — toward another character, a dramatic off-frame point of "
    "interest, or a story prop — preserving fourth-wall immersion.\n"
    "  • ANTI-TELEPORT SPATIAL & HAND LOCKS: explicitly lock left/right frame "
    "position (`frame-left`, `frame-right`), body facing direction, and both "
    "hands (`left hand holding…`, `right hand empty/resting…`).\n"
    "  • CONCISE REFERENCE FUSION: when combining character and setting images, "
    "state spatial blocking, pose, gaze, and lighting interaction cleanly — do "
    "NOT over-describe unreferenced background clutter or duplicate clothing "
    "details that conflict with attached character references.\n"
    "  • EXPRESSION & FACE READABILITY: grounded, story-driven micro-expressions "
    "(quiet tension, guarded restraint, realization, suppressed emotion, calm "
    "authority) with Realman skin pores and natural texture, lit by motivated "
    "warm tungsten or crisp daylight (NEVER write numeric Kelvin temperatures "
    "like 3200K/5600K, hex color codes, [bracket headers], $, or em-dashes).\n"
    "  • CINEMATIC COVERAGE MATRIX — pick ONE shot scale & camera setup from "
    "this pool (rotate across generations so shots form real film coverage):\n"
    "    · environmental establishing medium-wide shot placing the character "
    "within architectural depth and spatial geography\n"
    "    · over-the-shoulder dialogue framing with foreground depth cues and "
    "clear eyeline axis across the room\n"
    "    · emotional medium close-up with shallow depth of field isolating "
    "facial micro-expression and eye tension\n"
    "    · low-angle dramatic tension framing with high-contrast chiaroscuro "
    "practical and window lighting\n"
    "    · narrative three-quarter medium shot capturing the character mid-action "
    "at a doorway, desk, or spatial threshold\n"
    "    · elevated observational suspense framing emphasizing spatial isolation "
    "and atmospheric depth\n"
    "  • BLOCKING & PROPS: when a prop, costume, or key object (visual_asset) "
    "is in the inputs, integrate it naturally into physical cause-and-effect "
    "action — NEVER pose the subject displaying merchandise.\n\n"
    "Style: photorealistic live-action 35mm film still, 35mm/50mm prime lens, "
    "motivated cinematic lighting, natural film grain and depth of field. "
    "BACKGROUND PRIORITY — if any reference image's brief describes an "
    "environment, location, or scene (e.g. 'office', 'hallway', 'street', "
    "'café', 'park', 'interior room', 'courtyard'), USE that environment as the "
    "live setting of the shot: stage the character INTO that space with matching "
    "motivated light, perspective, and depth. Do NOT default to a blank studio "
    "when a location reference exists in the inputs; only fall back to a neutral "
    "indoor/studio background when zero location/scene references exist upstream. "
    "No production jargon labels, no markdown — end with 'NO TEXT IN THE IMAGE. "
    "NO SUBTITLES.' Output the prompt only."
)

# Appended to the image system prompt when the upstream graph contains
# 2+ distinct people (two-shot confrontation, dialogue axis, ensemble staging).
_MULTI_SUBJECT_CLAUSE = (
    "\n\nMULTI-SUBJECT MODE — CRITICAL: This scene contains MULTIPLE "
    "distinct characters. The upstream context lists every reference image "
    "with a `ref_image_N` label. Stage ALL characters into a single coherent "
    "dramatic couple / group blocking where every character appears in frame:\n"
    "  • REFERENCE BY POSITION: bind each character explicitly by their "
    "`ref_image_N` label and left/right frame side (e.g. 'ref_image_1 on "
    "frame-left facing right, ref_image_2 on frame-right turning toward "
    "ref_image_1') so Flow binds each person to the correct input image. "
    "NEVER replace `ref_image_N` with generic demographic labels.\n"
    "  • DRAMATIC BLOCKING & AXIS: compose relational staging — two-shot "
    "confrontation, over-the-shoulder dialogue tension keeping foreground "
    "shoulder consistently on one side, or foreground/background depth "
    "separation — keeping faces clearly readable for downstream Veo lock.\n"
    "  • EYELINE & FOURTH WALL: characters interact through authentic eyelines "
    "(locking eyes, one studying the other while the other looks away in tension) "
    "rather than posing toward the camera.\n"
    "  • COMPLEMENTARY STANCES & HAND LOCK: give each character complementary "
    "stances and explicit hand/empty-hand state reflecting power subtext.\n"
    "  • CHAR LIMIT: up to 440 chars for multi-subject scenes."
)

# Narrative Motion Synth for Veo 3.1 / Omni i2v: preserves time-coded beats,
# adds Plein/Realman physical cause->contact->reaction->settle grammar, forbids
# re-describing wardrobe/furniture already visible in start frame, and enforces
# post-dialogue breathing room + NO SUBTITLES.
_SYNTH_VIDEO_CORE = (
    "You are a film director and motion choreographer building i2v prompts "
    "(Veo 3.1 / Omni Flash 2026). Frame 0 IS already supplied by the start "
    "reference image — NEVER re-describe clothing or furniture already visible "
    "in frame 0 (causes texture warps); focus 100% on temporal motion, acting, "
    "camera choreography, and sound.\n\n"
    "INTENT FIRST. Read the dramatic subtext of frame 0: who is this character, "
    "what emotional tension or decision is unfolding right now, and what physical "
    "micro-action naturally follows? Treat the subject as a living actor with "
    "interiority inside a story scene, never a mannequin shifting poses.\n\n"
    "REALMAN ACTING & PHYSICAL CAUSE-AND-EFFECT:\n"
    "  • Structure is free when sustained stillness fits best, OR use crisp "
    "time-coded beats (`0-3s: … 3-6s: … 6-8s: …`) following a clear acting "
    "chain (stimulus -> beat of realization -> instinctive micro-reaction -> "
    "chosen response -> settle) and physical causality (force -> contact -> "
    "rebound -> settle).\n"
    "  • ANTI-FREEZE (safety floor): concrete living progression must occur "
    "across the clip — natural blinks, subtle breath rise, jaw/eyeline shift, "
    "purposeful hand/prop movement with explicit left/right hand tracking.\n"
    "  • NATURAL EXPRESSION & BREATHING: authentic breathing, subtle lip parting, "
    "and eye-focus shifts (stillness is valid when dramatically charged).\n\n"
    "AUDIO & BREATHING PAUSE — Veo generates native audio, and "
    "`PUBLIC_MIRROR_AUDIO_FILTER` can reject clips on unprompted speech:\n"
    "  • NO SPEECH BY DEFAULT: unless the prompt/upstream explicitly provides "
    "`Dialogue:`, write NO SPEECH (dialogue only written once inside its beat; "
    "leave a silent 0.5-1.0s closed-mouth reaction breath at the clip end).\n"
    "  • BACKGROUND MUSIC (default ON): subtle instrumental cinematic underscore "
    "matching the dramatic mood — strictly instrumental, no vocals.\n"
    "  • SFX: crisp diegetic room tone and foley cues in temporal order.\n\n"
    "No hard cuts, no Kelvin numbers, no brackets, no em-dashes, no `$`. "
    "End with 'NO SUBTITLES.' Max 480 chars. Output pure cinematic motion prose only."
)

# Multi-character dramatic interaction for video nodes.
_MULTI_SUBJECT_VIDEO_CLAUSE = (
    "\n\nMULTI-SUBJECT MODE: The source frame contains MULTIPLE distinct "
    "characters. Direct an authentic action-and-reaction exchange — natural "
    "dramatic co-presence beats synchronized choreography:\n"
    "  • Independent action & reaction: let frame-left / frame-right actors "
    "initiate and react with staggered timing (breathing shift, guarded glance, "
    "deliberate lean). Never make all characters move in mechanical unison.\n"
    "  • Eyeline & 180-degree axis: preserve left/right screen placement and "
    "consistent foreground shoulder side in OTS exchanges.\n"
    "  • ANTI-FREEZE applies PER SUBJECT: every character in frame must show "
    "living presence (blinks, breathing, gaze or posture response) across 0-8s.\n"
    "  • REFERENCE BY POSITION: address each character by their `ref_image_N` "
    "label or frame-left / frame-right placement — never generic demographic labels.\n"
    "  • Char limit bumps to 560 for multi-subject scenes."
)

_CAMERA_INSTRUCTIONS: dict[str, str] = {
    "dynamic": (
        "\n\nCamera (DYNAMIC CINEMATIC SCHEDULING): pair the actor's beat "
        "progression with ONE clean, physically motivated cinema camera movement "
        "— choose a slow emotional push-in (`Dolly-in`), smooth `Tracking` move, "
        "or depth-of-field `Rack Focus` shift between foreground prop and eyes."
    ),
    "static": (
        "\n\nCamera: STATIC locked-off tripod frame, no zoom / pan / dolly. "
        "Let actor staging, eyeline shifts, and lighting depth carry the beat."
    ),
    "dolly_in": (
        "\n\nCamera (M01 DOLLY-IN): slow 35mm/50mm smooth forward push-in on a "
        "tracked dolly from medium shot toward emotional medium close-up, "
        "preserving left/right screen axis."
    ),
    "dolly_out": (
        "\n\nCamera (M02 DOLLY-OUT): measured slow backward pull-back revealing "
        "the surrounding room geometry and power distance between subjects."
    ),
    "pan": (
        "\n\nCamera (M03 HORIZONTAL PAN): smooth tripod pan pivoting slowly to "
        "follow the actor's eyeline or reveal the second character in space."
    ),
    "truck": (
        "\n\nCamera (M04 LATERAL TRUCK): smooth sideways dolly glide parallel "
        "to the action plane with natural foreground parallax."
    ),
    "tracking": (
        "\n\nCamera (M05 TRACKING FOLLOW): steady Steadicam follow matching the "
        "subject's walking pace at consistent chest-level framing."
    ),
    "crane_up": (
        "\n\nCamera (M06 CRANE / PEDESTAL): subtle vertical rise opening "
        "architectural scale while keeping the subject anchored below."
    ),
    "rack_focus": (
        "\n\nCamera (M10 RACK FOCUS): shallow 85mm depth-of-field pull shifting "
        "crisp focus cleanly from a foreground story prop to the character's eyes."
    ),
    "ots": (
        "\n\nCamera (M11 OVER-THE-SHOULDER OTS): 180-degree locked over-the-shoulder "
        "dialogue frame keeping the listener's softly blurred shoulder consistently "
        "on one frame edge while holding sharp focus on the speaker's face."
    ),
    "orbit": (
        "\n\nCamera (M09 SUBTLE ORBIT): controlled slow 20-degree arc around the "
        "confrontation axis, shifting rim light across both faces without flipping sides."
    ),
}

# Preserve module-level constants for clarity & tests
_SYNTH_SYSTEM_VIDEO_DEFAULT = _SYNTH_VIDEO_CORE + _CAMERA_INSTRUCTIONS["dynamic"]
_SYNTH_SYSTEM_VIDEO_STATIC = _SYNTH_VIDEO_CORE + _CAMERA_INSTRUCTIONS["static"]


def _video_system_prompt(camera: Optional[str], subject_count: int = 1) -> str:
    cam_key = (camera or "dynamic").strip().lower()
    if cam_key not in _CAMERA_INSTRUCTIONS:
        cam_key = "dynamic"
    base = _SYNTH_VIDEO_CORE + _CAMERA_INSTRUCTIONS[cam_key]
    if subject_count >= 2:
        return base + _MULTI_SUBJECT_VIDEO_CLAUSE
    return base


def _character_system_prompt() -> str:
    return _SYNTH_SYSTEM_CHARACTER


class PromptSynthError(RuntimeError):
    pass


_REF_SOURCE_TYPES = {"character", "image", "visual_asset", "Storyboard"}


def _collect_upstream(node_id: int) -> tuple[list[dict], Optional[Node]]:
    """Return (upstream_brief_records, target_node)."""
    with get_session() as s:
        target = s.get(Node, node_id)
        if target is None:
            return [], None
        edges = s.exec(
            select(Edge).where(Edge.target_id == node_id).order_by(Edge.id)
        ).all()
        upstream_ids = [e.source_id for e in edges]
        records: list[dict] = []
        next_ref_index = 1
        for uid in upstream_ids:
            n = s.get(Node, uid)
            if n is None:
                continue
            data = n.data or {}
            ai_brief = data.get("aiBrief") if isinstance(data.get("aiBrief"), str) else None
            user_prompt = data.get("prompt") if isinstance(data.get("prompt"), str) else None
            brief = user_prompt or ai_brief
            subject_chars: list[str] = []
            if n.type == "image":
                gp_edges = s.exec(
                    select(Edge).where(Edge.target_id == uid).order_by(Edge.id)
                ).all()
                for ge in gp_edges:
                    gp = s.get(Node, ge.source_id)
                    if gp is not None and gp.type == "character":
                        subject_chars.append(gp.short_id)
            mids = data.get("mediaIds")
            has_media = bool(
                (isinstance(data.get("mediaId"), str) and data.get("mediaId"))
                or (isinstance(mids, list) and any(isinstance(m, str) and m for m in mids))
            )
            ref_index: Optional[int] = None
            if n.type in _REF_SOURCE_TYPES and has_media:
                ref_index = next_ref_index
                next_ref_index += 1
            records.append(
                {
                    "type": n.type,
                    "shortId": n.short_id,
                    "ref_index": ref_index,
                    "brief": brief if isinstance(brief, str) else None,
                    "prompt": user_prompt,
                    "title": data.get("title") if isinstance(data.get("title"), str) else None,
                    "has_media": has_media,
                    "subject_chars": subject_chars,
                }
            )
        return records, target


def _distinct_subjects(records: list[dict]) -> list[str]:
    """Ordered list of distinct character shortIds across upstream."""
    seen_set: set[str] = set()
    ordered: list[str] = []
    for r in records:
        ids: list[str] = []
        if r["type"] == "character":
            ids = [r["shortId"]]
        elif r["type"] == "image":
            ids = list(r.get("subject_chars") or [])
        for sid in ids:
            if sid and sid not in seen_set:
                seen_set.add(sid)
                ordered.append(sid)
    return ordered


def _image_system_prompt(subject_count: int) -> str:
    """Branch the image system prompt on subject count.

    1 subject → cinematic narrative single-character shot coverage.
    2+ subjects → append multi-character dramatic blocking clause using
    positional `ref_image_N` labels.
    """
    if subject_count >= 2:
        return _SYNTH_SYSTEM_IMAGE + _MULTI_SUBJECT_CLAUSE
    return _SYNTH_SYSTEM_IMAGE


def _format_user_message(records: list[dict], target: Node) -> str:
    """Render the upstream context into a compact prompt for the LLM."""
    label_for_short_id: dict[str, str] = {}
    for r in records:
        if r.get("ref_index"):
            label_for_short_id[r["shortId"]] = f"ref_image_{r['ref_index']}"

    by_type: dict[str, list[str]] = {}
    for r in records:
        text = r["brief"] or r["prompt"] or r["title"] or "(no description)"

        suffix = ""
        if r["type"] == "image" and r.get("subject_chars"):
            translated = [
                label_for_short_id[c]
                for c in r["subject_chars"]
                if c in label_for_short_id
            ]
            if translated:
                suffix = f"  [same subject as {', '.join(translated)}]"

        ref_index = r.get("ref_index")
        if ref_index is not None:
            line = f"ref_image_{ref_index}: {text}{suffix}"
        else:
            line = f"- {text}"
        by_type.setdefault(r["type"], []).append(line)

    parts: list[str] = []
    if by_type.get("character"):
        parts.append("Character(s) (character):\n  - " + "\n  - ".join(by_type["character"]))
    if by_type.get("visual_asset"):
        parts.append(
            "Narrative prop / costume / key object (visual_asset):\n  - "
            + "\n  - ".join(by_type["visual_asset"])
        )
    if by_type.get("image"):
        parts.append("Reference image(s):\n  - " + "\n  - ".join(by_type["image"]))
        if len(by_type["image"]) >= 2:
            parts.append(
                "ROLE INFERENCE: For each reference image above, infer its "
                "role from the brief. Briefs describing characters / wardrobe / "
                "key props → character or prop continuity reference. Briefs "
                "describing places / environments / outdoor or indoor spaces → "
                "SETTING reference (use as the shot's live environment). Compose "
                "a single cinematic frame that places the subject INTO any "
                "setting reference present — never silently drop a location reference."
            )
    if by_type.get("prompt"):
        parts.append(
            "Direction / style notes (prompt nodes — apply as directorial "
            "guidance):\n  - " + "\n  - ".join(by_type["prompt"])
        )

    subjects = _distinct_subjects(records)
    if len(subjects) >= 2:
        parts.append(
            f"DISTINCT SUBJECTS DETECTED: {len(subjects)} people. Treat "
            "as a single multi-subject scene; describe each subject's "
            "placement using the `ref_image_N` labels above."
        )

    target_data = target.data or {}
    target_title = target_data.get("title") if isinstance(target_data.get("title"), str) else None
    if target_title:
        parts.append(f"Target node title (hint): {target_title}")

    if not parts:
        return f"Target: {target_title or 'scene'}\n\nWrite a cinematic narrative film frame prompt."
    return "\n\n".join(parts) + "\n\nReturn only the prompt sentence."


_BATCH_SUFFIX = (
    "\n\nBATCH MODE (CINEMATIC COVERAGE MATRIX): Output a JSON ARRAY of "
    "EXACTLY {count} distinct prompts representing multi-camera film coverage "
    "of the scene. Each variant MUST pick a DIFFERENT shot scale and camera "
    "angle from the Cinematic Coverage Matrix (e.g. Variant 1: environmental "
    "establishing medium-wide shot; Variant 2: over-the-shoulder / spatial "
    "depth dialogue framing; Variant 3: emotional medium close-up with shallow "
    "DOF; Variant 4: low-angle dramatic chiaroscuro tension framing) — NEVER "
    "repeat the same shot scale or camera placement across variants, and NEVER "
    "break the fourth wall with lookbook lens-staring. Output ONLY the JSON "
    "array, no preamble, no markdown fences. Example:\n"
    "[\n"
    "  \"Cinematic medium-wide establishing shot, …, natural depth of field, …\",\n"
    "  \"Over-the-shoulder medium shot, …, tense off-camera eyeline, …\",\n"
    "  \"Emotional medium close-up, …, motivated rim light and shallow DOF, …\",\n"
    "  \"Low-angle dramatic shot, …, high-contrast chiaroscuro lighting, …\"\n"
    "]"
)


async def auto_prompt_batch(
    node_id: int, count: int, *, camera: Optional[str] = None
) -> list[str]:
    """Compose N cinematically distinct shot-coverage prompts in a single LLM call."""
    if count < 1:
        raise PromptSynthError("count must be >= 1")
    if count == 1:
        single = await auto_prompt(node_id, camera=camera)
        return [single]

    records, target = _collect_upstream(node_id)
    if target is None:
        raise PromptSynthError(f"node {node_id} not found")

    subject_count = len(_distinct_subjects(records))
    if target.type == "video":
        base_system = _video_system_prompt(camera, subject_count)
    elif target.type == "character":
        base_system = _character_system_prompt()
    else:
        base_system = _image_system_prompt(subject_count)
    system_prompt = base_system + _BATCH_SUFFIX.format(count=count)
    user_msg = _format_user_message(records, target)

    async with record_activity(
        "auto_prompt_batch",
        params={"node_id": node_id, "count": count, "camera": camera},
        node_id=node_id,
    ) as activity:
        try:
            text = await run_llm(
                "auto_prompt", user_msg, system_prompt=system_prompt, timeout=120.0
            )
        except LLMError as exc:
            raise PromptSynthError(f"auto-prompt provider failed: {exc}") from exc

        text = (text or "").strip()
        if text.startswith("```"):
            text = text.lstrip("`")
            if text.lower().startswith("json"):
                text = text[4:]
            text = text.rsplit("```", 1)[0].strip()

        try:
            arr = json.loads(text)
        except json.JSONDecodeError as exc:
            raise PromptSynthError(
                f"auto-prompt provider returned non-JSON for batch: {text[:200]!r}"
            ) from exc
        if not isinstance(arr, list):
            raise PromptSynthError("auto-prompt batch response is not a JSON array")
        prompts = [sanitize_flow_prompt(str(p).strip()) for p in arr if isinstance(p, str) and str(p).strip()]
        if not prompts:
            raise PromptSynthError("auto-prompt batch returned no valid prompts")
        while len(prompts) < count:
            prompts.append(prompts[-1])
        prompts = prompts[:count]
        activity.set_result({"prompts": prompts})
        apply_node_patch(node_id, data_patch={"prompt": prompts[0]})
        return prompts


async def auto_prompt(node_id: int, *, camera: Optional[str] = None) -> str:
    """Compose a generation prompt by walking upstream + asking the
    configured Auto-Prompt provider.

    Branch by target type:
    - ``character`` → character identity anchor with balanced neutral face light
      + authentic story-world styling texture.
    - ``image`` (default) → cinematic narrative shot composition.
    - ``video`` → 0-3s / 3-6s / 6-8s narrative micro-action + dynamic camera
      choreography (defaults to dynamic unless ``camera == "static"``).
    """
    records, target = _collect_upstream(node_id)
    if target is None:
        raise PromptSynthError(f"node {node_id} not found")

    subject_count = len(_distinct_subjects(records))
    if target.type == "video":
        system_prompt = _video_system_prompt(camera, subject_count)
    elif target.type == "character":
        system_prompt = _character_system_prompt()
    else:
        system_prompt = _image_system_prompt(subject_count)
    user_msg = _format_user_message(records, target)

    async with record_activity(
        "auto_prompt",
        params={"node_id": node_id, "camera": camera},
        node_id=node_id,
    ) as activity:
        try:
            text = await run_llm(
                "auto_prompt",
                user_msg,
                system_prompt=system_prompt,
                timeout=90.0,
            )
        except LLMError as exc:
            raise PromptSynthError(f"auto-prompt provider failed: {exc}") from exc

        text = sanitize_flow_prompt((text or "").strip().strip('"').strip("'"))
        if not text:
            raise PromptSynthError("empty response from auto-prompt provider")
        if len(text) > 500:
            text = text[:500].rstrip() + "…"
        activity.set_result({"prompt": text})
        apply_node_patch(node_id, data_patch={"prompt": text})
        return text


_POLISH_SYSTEM_TEMPLATE = (
    "You are an expert 2026 Google Flow / Veo 3.1 / Omni Flash prompt director "
    "(integrating Realman live-action realism and Plein causal staging). Rewrite "
    "the user's rough draft into clean English cinematic prose ready for Flow.\n\n"
    "STRICT RULES:\n"
    "1. Mode focus: {mode_focus}\n"
    "2. Preserve existing plot beats, spoken lines verbatim (if any Dialogue: is "
    "present, keep it once inside the speaking beat and allow 0.5-1.0s silent "
    "closing reaction), and preserve any positional ref labels like `ref_image_1`.\n"
    "3. Lock screen sides (`frame-left`, `frame-right`) and hands (`left hand`, "
    "`right hand`, `empty hands`). Do NOT repeat clothes or furniture that are "
    "already supplied by a start frame reference.\n"
    "4. Physical causality (`force -> contact -> reaction -> settle`) and subtle "
    "Realman pores/skin micro-detail (no plastic beauty-filter shine).\n"
    "5. NO forbidden OBS tokens: zero Kelvin numbers (`3200K`/`5600K`), zero hex "
    "colors, zero `[bracket]` headers, zero em-dashes `—`, zero `$` signs, zero "
    "editorial jargon notes.\n"
    "6. End positively with `{clean_suffix}`. Output ONLY the polished prompt."
)


async def polish_prompt(
    raw_text: str,
    *,
    mode: str = "video",
    ref_briefs: Optional[list[str]] = None,
    duration_s: Optional[int] = None,
    camera: Optional[str] = None,
) -> tuple[str, bool]:
    """Rewrite a rough Chinese or English canvas composer draft into clean Flow 2026 prose.

    Falls back gracefully to deterministic ``sanitize_flow_prompt`` cleanup when no
    LLM provider is configured or reachable, so bottom-composer polishing never blocks.
    Returns ``(polished_prompt, used_llm)``.
    """
    draft = (raw_text or "").strip()
    if not draft and ref_briefs:
        draft = "; ".join(b.strip() for b in ref_briefs if isinstance(b, str) and b.strip())
    if not draft:
        raise PromptSynthError("empty raw_text")

    mode_norm = (mode or "video").strip().lower()
    if mode_norm == "image":
        mode_focus = "Single live-action cinema still (45-95 words), 35mm/50mm lens, clear staging and spatial lighting."
        clean_suffix = "NO TEXT IN THE IMAGE. NO SUBTITLES."
    elif mode_norm == "first_last":
        dur = duration_s if duration_s in (4, 6, 8, 10) else 8
        mode_focus = (
            f"Same-camera {dur}s Start->End transition clip: describe the exact smooth "
            "middle progression bridging frame 0 to the end frame without teleporting actors."
        )
        clean_suffix = "NO SUBTITLES."
    elif mode_norm == "omni":
        dur = duration_s if duration_s in (4, 6, 8, 10) else 8
        mode_focus = (
            f"Omni Flash multi-reference {dur}s clip: assign each reference role cleanly, "
            "time-code beats (0-3s / 3-6s / 6-8s), ONE single cinema camera move, diegetic SFX."
        )
        clean_suffix = "NO SUBTITLES."
    else:
        mode_focus = (
            "Veo / i2v 8s motion clip from frame 0: ONE primary action, ONE camera move, "
            "natural breathing and reaction settle."
        )
        clean_suffix = "NO SUBTITLES."

    cam_note = ""
    cam_key = (camera or "").strip().lower()
    if cam_key and cam_key in _CAMERA_INSTRUCTIONS:
        cam_note = f"\nRequested camera move constraint: {_CAMERA_INSTRUCTIONS[cam_key].strip()}"

    ref_section = ""
    if ref_briefs:
        cleaned_briefs = [
            f"- ref_image_{i + 1}: {b.strip()}"
            for i, b in enumerate(ref_briefs)
            if isinstance(b, str) and b.strip()
        ]
        if cleaned_briefs:
            ref_section = "\n\nAttached visual references:\n" + "\n".join(cleaned_briefs)

    user_msg = f"Raw director draft:\n{draft}{ref_section}{cam_note}"
    system_prompt = _POLISH_SYSTEM_TEMPLATE.format(
        mode_focus=mode_focus,
        clean_suffix=clean_suffix,
    )

    try:
        rewritten = await run_llm(
            "auto_prompt", user_msg, system_prompt=system_prompt, timeout=60.0
        )
        cleaned = sanitize_flow_prompt((rewritten or "").strip().strip('"').strip("'"))
        if cleaned:
            if len(cleaned) > 1400:
                cleaned = cleaned[:1400].rstrip()
            return cleaned, True
    except LLMError as exc:
        logger.info("polish_prompt LLM fallback to deterministic sanitizer: %s", exc)

    fallback = sanitize_flow_prompt(draft)
    if fallback and clean_suffix not in fallback.upper():
        sep = " " if fallback.endswith((".", "!", "?")) else ". "
        fallback = f"{fallback}{sep}{clean_suffix}"
    return fallback, False
