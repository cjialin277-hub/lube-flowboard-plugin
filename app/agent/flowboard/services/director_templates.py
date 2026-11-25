"""Hourglass (`SEQ-xxx`) director storyboard template catalog & 4-column board builder.

Reads verified camera sequences from the local Hourglass SQLite vault
(`cornerstone_memory.db`, read-only URI mode) with a built-in fallback
catalog so tests and clean machines work even without external SSDs.
"""
from __future__ import annotations

import logging
import os
import sqlite3
from pathlib import Path
from typing import Any, Optional

from sqlmodel import delete as sql_delete, select

from flowboard.db import get_session
from flowboard.db.models import Asset, Board, Edge, Node, Request
from flowboard.short_id import generate_unique_short_id

logger = logging.getLogger(__name__)

_DEFAULT_DB_CANDIDATES: tuple[Path, ...] = (
    Path.home() / "Cornerstone_Master_Vault" / "02_CAMERA_GRAMMAR_NAS_SQLITE" / "cornerstone_memory.db",
    Path("/Volumes/T9/Cornerstone_Master_Vault/02_CAMERA_GRAMMAR_NAS_SQLITE/cornerstone_memory.db"),
)

_BUILTIN_SEQUENCES: list[dict[str, Any]] = [
    {
        "seq_id": "SEQ-0019",
        "name": "画布级 7 镜全转场精控标准组（尾帧直连 + 首尾帧光影渐变 + 退场空镜）",
        "layer1_genre": "test_60s",
        "layer2_beat_pattern": "tail_chain_and_first_last_vfx",
        "description": "1 次涵盖尾帧直连、道具过门、同机位首尾帧光影渐变(FRAMES_START_END)、视线切人与退场无人物空镜。",
        "aspect_ratio": "9:16",
        "step_count": 7,
        "score_total": 98,
        "status": "locked",
        "steps": [
            {
                "step_idx": 1,
                "shot_role": "HOOK",
                "shot_size": "MS",
                "camera_movement": "static_locked",
                "duration_range_sec": "8.0-9.0",
                "mandatory_bridge": "TAIL_DIRECT_CHAIN -> 2.mp4",
                "dialogue_rule": "0-3s 推进动作开场 + 冲突短台词",
                "prompt_template": "Camera locked eye-level 35mm medium two-shot. 0-3s: <ANTAGONIST> pushes the envelope across the table toward <PROTAGONIST>. 3-7s: <PROTAGONIST> glances down quietly. Dialogue: sharp confrontation.",
                "veo_shot_mode": "FRAMES_START_ONLY",
            },
            {
                "step_idx": 2,
                "shot_role": "ACTION",
                "shot_size": "MCU",
                "camera_movement": "static_locked",
                "duration_range_sec": "8.0-9.0",
                "mandatory_bridge": "PROP_INSERT_BRIDGE -> 3.mp4",
                "dialogue_rule": "尾帧接力保持坐姿连续",
                "prompt_template": "Camera stays locked same framing with <PROTAGONIST> screen-left resting hand near the sealed envelope, eyes lowering deliberately toward the tabletop prop.",
                "veo_shot_mode": "FRAMES_START_ONLY",
            },
            {
                "step_idx": 3,
                "shot_role": "TRANSITION_BRIDGE",
                "shot_size": "INSERT",
                "camera_movement": "static_locked",
                "duration_range_sec": "7.5-8.5",
                "mandatory_bridge": "SAME_AXIS_MATCH -> 4.mp4",
                "dialogue_rule": "无台词纯动作细节桥接",
                "prompt_template": "Camera locked 85mm macro angled down over tabletop: five steady fingers lift the flap of the envelope cleanly.",
                "veo_shot_mode": "FRAMES_START_ONLY",
            },
            {
                "step_idx": 4,
                "shot_role": "REVEAL",
                "shot_size": "CU",
                "camera_movement": "static_locked",
                "duration_range_sec": "7.5-8.5",
                "mandatory_bridge": "EYELINE_MATCH_TO_PERSON -> 5.mp4",
                "dialogue_rule": "同机位首尾帧光影渐变",
                "prompt_template": "Static locked close-up centered on <PROP_ANCHOR> with identical framing as cool overcast shadow smoothly transforms into warm golden reveal sunlight.",
                "veo_shot_mode": "FRAMES_START_END",
            },
            {
                "step_idx": 5,
                "shot_role": "REACTION",
                "shot_size": "MCU",
                "camera_movement": "static_locked",
                "duration_range_sec": "8.0-9.0",
                "mandatory_bridge": "EYELINE_MATCH_TO_PERSON -> 6.mp4",
                "dialogue_rule": "反打惊慌微表情",
                "prompt_template": "Locked 85mm close-up on <ANTAGONIST> reacting as color drains from face, breath catching silently.",
                "veo_shot_mode": "FRAMES_START_ONLY",
            },
            {
                "step_idx": 6,
                "shot_role": "CLOSING",
                "shot_size": "WS",
                "camera_movement": "pull_back",
                "duration_range_sec": "8.0-9.0",
                "mandatory_bridge": "CUT_TO_EMPTY_SHOT -> 7.mp4",
                "dialogue_rule": "反派起身离席退场",
                "prompt_template": "Camera begins on matched two-shot as <ANTAGONIST> pushes chair back and exits frame cleanly, leaving <PROTAGONIST> composed.",
                "veo_shot_mode": "FRAMES_START_ONLY",
            },
            {
                "step_idx": 7,
                "shot_role": "EMPTY_BREATHE_OUTRO",
                "shot_size": "WS",
                "camera_movement": "static_locked",
                "duration_range_sec": "7.5-8.5",
                "mandatory_bridge": "end(FINALE_HOLD)",
                "dialogue_rule": "无人物纯空镜呼吸收尾",
                "prompt_template": "Locked static empty room wide shot after exit, afternoon sunbeam drifting softly across the quiet table.",
                "veo_shot_mode": "FRAMES_START_ONLY",
            },
        ],
    },
    {
        "seq_id": "SEQ-0017",
        "name": "玄幻狼人经典变身：羞辱挑衅 → 同机位首尾帧觉醒异变 → 压迫收尾",
        "layer1_genre": "fantasy_werewolf",
        "layer2_beat_pattern": "humiliation_to_vfx_awakening",
        "description": "6 镜玄幻/奇幻短片模板：含第 4 镜同机位首尾帧异变特效，适合兽化、觉醒、魔法变装。",
        "aspect_ratio": "9:16",
        "step_count": 6,
        "score_total": 96,
        "status": "locked",
        "steps": [
            {
                "step_idx": 1,
                "shot_role": "HOOK",
                "shot_size": "MS",
                "camera_movement": "dolly_in",
                "duration_range_sec": "2.5-3.5",
                "mandatory_bridge": "切至被夺落的族徽极特写",
                "dialogue_rule": "0.0s 双人冲突羞辱开场",
                "prompt_template": "Dynamic 35mm push-in: <ANTAGONIST> sneers and knocks the silver crest from <PROTAGONIST>'s hand onto the stone floor.",
                "veo_shot_mode": "FRAMES_START_ONLY",
            },
            {
                "step_idx": 2,
                "shot_role": "TRANSITION_BRIDGE",
                "shot_size": "INSERT",
                "camera_movement": "static_locked",
                "duration_range_sec": "1.5-2.0",
                "mandatory_bridge": "反打主角压抑低头特写",
                "dialogue_rule": "纯声效无台词",
                "prompt_template": "Macro insert of silver crest ringing on dark stone while ember sparks flicker faintly around the rim.",
                "veo_shot_mode": "FRAMES_START_ONLY",
            },
            {
                "step_idx": 3,
                "shot_role": "CONFRONT",
                "shot_size": "MCU",
                "camera_movement": "static_locked",
                "duration_range_sec": "2.5-3.5",
                "mandatory_bridge": "切至同机位首尾帧觉醒特效",
                "dialogue_rule": "压抑喘息与低沉台词",
                "prompt_template": "<PROTAGONIST> lowers gaze then slowly lifts eyes in quiet resolve as ambient storm light intensifies.",
                "veo_shot_mode": "FRAMES_START_ONLY",
            },
            {
                "step_idx": 4,
                "shot_role": "REVEAL",
                "shot_size": "CU",
                "camera_movement": "dolly_in",
                "duration_range_sec": "3.0-4.0",
                "mandatory_bridge": "同镜头延续接压迫起身",
                "dialogue_rule": "同机位首尾帧瞳孔/战甲觉醒异变",
                "prompt_template": "Same-camera close-up transformation on <PROTAGONIST>: swirling golden runes ignite around eyes and armor plates seamlessly from start to end frame.",
                "veo_shot_mode": "FRAMES_START_END",
            },
            {
                "step_idx": 5,
                "shot_role": "REACTION",
                "shot_size": "MCU",
                "camera_movement": "static_locked",
                "duration_range_sec": "2.0-3.0",
                "mandatory_bridge": "转至反派踉跄后退中景",
                "dialogue_rule": "短促震惊反应",
                "prompt_template": "<ANTAGONIST> stumbles back a half-step in shock, eyes wide reflecting golden aura glow.",
                "veo_shot_mode": "FRAMES_START_ONLY",
            },
            {
                "step_idx": 6,
                "shot_role": "CLOSING",
                "shot_size": "WS",
                "camera_movement": "pull_back",
                "duration_range_sec": "3.0-4.0",
                "mandatory_bridge": "end",
                "dialogue_rule": "一句话定生死悬念收尾",
                "prompt_template": "Camera pulls smoothly back revealing <PROTAGONIST> standing tall in full radiant crest as storm clouds part.",
                "veo_shot_mode": "FRAMES_START_ONLY",
            },
        ],
    },
    {
        "seq_id": "SEQ-0020",
        "name": "美剧级「真剧感」50s 高潮冷开场 + SIX MONTHS EARLIER 倒叙动线",
        "layer1_genre": "family_dignity",
        "layer2_beat_pattern": "cold_open_teaser_flashback",
        "description": "16:9 横屏真剧感主力模板：来车登门冷开场 + 过肩虚化正反打(OTS) + 倒叙玄关日常动线。",
        "aspect_ratio": "16:9",
        "step_count": 6,
        "score_total": 100,
        "status": "locked",
        "steps": [
            {
                "step_idx": 1,
                "shot_role": "HOOK_ACTIVITY_ECU",
                "shot_size": "ECU",
                "camera_movement": "static_locked",
                "duration_range_sec": "2.5-3.4s",
                "mandatory_bridge": "听到引擎声停手切院落广角",
                "dialogue_rule": "动手干活中切入引擎声",
                "prompt_template": "16:9 ECU of <PROTAGONIST>'s hands trimming garden roses, pausing abruptly at distant car gravel crunch.",
                "veo_shot_mode": "V2_PROP_INSERT",
            },
            {
                "step_idx": 2,
                "shot_role": "ARRIVAL_WS",
                "shot_size": "WS",
                "camera_movement": "slow_pan",
                "duration_range_sec": "3.5-5.5s",
                "mandatory_bridge": "车门推开同动势切主角起身",
                "dialogue_rule": "环境定场不干吵",
                "prompt_template": "Wide architectural driveway shot as dark sedan stops and <ANTAGONIST> steps out carrying leather briefcase.",
                "veo_shot_mode": "V1_MASTER_DEPTH",
            },
            {
                "step_idx": 3,
                "shot_role": "PORCH_OTS_GREET",
                "shot_size": "MCU",
                "camera_movement": "over_shoulder",
                "duration_range_sec": "3.0-4.5s",
                "mandatory_bridge": "转身让门切室内客厅",
                "dialogue_rule": "180°带前景虚化肩膀OTS",
                "prompt_template": "Over-the-shoulder MCU with blurred foreground shoulder on frame edge; <PROTAGONIST> greets <ANTAGONIST> with calm restraint.",
                "veo_shot_mode": "V1_MONO_CU",
            },
            {
                "step_idx": 4,
                "shot_role": "BRIEFCASE_LATCH_ECU",
                "shot_size": "ECU",
                "camera_movement": "static_locked",
                "duration_range_sec": "1.8-2.5s",
                "mandatory_bridge": "锁扣咔哒声切对向沙发",
                "dialogue_rule": "英雄道具微距",
                "prompt_template": "Macro ECU of fingers clicking brass briefcase latches open on the living room coffee table.",
                "veo_shot_mode": "V2_PROP_INSERT",
            },
            {
                "step_idx": 5,
                "shot_role": "CONFRONT_OTS_A",
                "shot_size": "MS",
                "camera_movement": "over_shoulder",
                "duration_range_sec": "4.0-5.5s",
                "mandatory_bridge": "话音落点留0.7s眼神切反打",
                "dialogue_rule": "冷静反问留白",
                "prompt_template": "180-axis over-the-shoulder medium shot on <PROTAGONIST> seated calmly, holding steady eyeline before delivering quiet counter-question.",
                "veo_shot_mode": "V1_EVENT_2SHOT",
            },
            {
                "step_idx": 6,
                "shot_role": "STING_CU_TIMECARD",
                "shot_size": "CU",
                "camera_movement": "dolly_in",
                "duration_range_sec": "2.2-2.8s",
                "mandatory_bridge": "硬切夜晚住宅外景时间倒叙",
                "dialogue_rule": "留0.8s凝视悬念",
                "prompt_template": "Slow dolly-in close-up on <PROTAGONIST>'s composed gaze holding intense subtext before smash cut.",
                "veo_shot_mode": "V1_MONO_CU",
            },
        ],
    },
]


def resolve_hourglass_db_path() -> Optional[Path]:
    env_p = os.environ.get("FLOWBOARD_HOURGLASS_DB", "").strip()
    if env_p:
        p = Path(env_p).expanduser()
        if p.is_file():
            return p
    for cand in _DEFAULT_DB_CANDIDATES:
        if cand.is_file():
            return cand
    return None


def _is_first_last_step(step: dict[str, Any]) -> bool:
    mode = str(step.get("veo_shot_mode") or "").upper()
    bridge = str(step.get("mandatory_bridge") or "").upper()
    return mode == "FRAMES_START_END" or "VFX_START_END" in bridge


def list_director_templates() -> list[dict[str, Any]]:
    """Return all director sequences from Hourglass DB (or built-in fallback)."""
    db_path = resolve_hourglass_db_path()
    if db_path is None:
        return [
            {
                **seq,
                "source": "builtin",
                "has_first_last": any(_is_first_last_step(st) for st in seq["steps"]),
            }
            for seq in _BUILTIN_SEQUENCES
        ]

    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        seq_rows = conn.execute(
            """
            SELECT seq_id, layer1_genre, layer2_beat_pattern, name, description,
                   aspect_ratio, step_count, score_total, status, locked
            FROM camera_sequences
            ORDER BY score_total DESC, seq_id ASC
            """
        ).fetchall()
        step_rows = conn.execute(
            """
            SELECT seq_id, step_idx, shot_role, shot_size, camera_movement,
                   duration_range_sec, mandatory_bridge, dialogue_rule,
                   prompt_template, veo_shot_mode, jianying_track
            FROM camera_sequence_steps
            ORDER BY seq_id ASC, step_idx ASC
            """
        ).fetchall()
    finally:
        conn.close()

    steps_by_seq: dict[str, list[dict[str, Any]]] = {}
    for r in step_rows:
        d = dict(r)
        steps_by_seq.setdefault(d["seq_id"], []).append(d)

    out: list[dict[str, Any]] = []
    for sr in seq_rows:
        sd = dict(sr)
        steps = steps_by_seq.get(sd["seq_id"], [])
        sd["steps"] = steps
        sd["step_count"] = len(steps) or int(sd.get("step_count") or 0)
        sd["has_first_last"] = any(_is_first_last_step(st) for st in steps)
        sd["source"] = "hourglass_db"
        out.append(sd)

    if not out:
        return [
            {
                **seq,
                "source": "builtin",
                "has_first_last": any(_is_first_last_step(st) for st in seq["steps"]),
            }
            for seq in _BUILTIN_SEQUENCES
        ]
    return out


def _find_template(seq_id: str) -> dict[str, Any]:
    target = seq_id.strip().upper()
    for tpl in list_director_templates():
        if str(tpl.get("seq_id", "")).upper() == target:
            return tpl
    # Also check built-in list if DB omitted a demo seq
    for tpl in _BUILTIN_SEQUENCES:
        if tpl["seq_id"].upper() == target:
            return {
                **tpl,
                "source": "builtin",
                "has_first_last": any(_is_first_last_step(st) for st in tpl["steps"]),
            }
    raise LookupError(f"director template {seq_id!r} not found")


def _resolve_aspects(seq_aspect: str, aspect_override: Optional[str]) -> tuple[str, str]:
    raw = (aspect_override or seq_aspect or "9:16").strip().lower()
    if raw in ("16:9", "landscape", "image_aspect_ratio_landscape", "video_aspect_ratio_landscape"):
        return "IMAGE_ASPECT_RATIO_LANDSCAPE", "VIDEO_ASPECT_RATIO_LANDSCAPE"
    return "IMAGE_ASPECT_RATIO_PORTRAIT", "VIDEO_ASPECT_RATIO_PORTRAIT"


def apply_director_template(
    board_id: int,
    seq_id: str,
    *,
    aspect_override: Optional[str] = None,
    clear_existing: bool = False,
) -> dict[str, Any]:
    """Scaffold a 4-column node layout on `board_id` from a `SEQ-xxx` template."""
    tpl = _find_template(seq_id)
    steps: list[dict[str, Any]] = list(tpl.get("steps") or [])
    if not steps:
        raise ValueError(f"director template {seq_id!r} has no steps")

    img_aspect, vid_aspect = _resolve_aspects(str(tpl.get("aspect_ratio") or "9:16"), aspect_override)

    with get_session() as s:
        board = s.get(Board, board_id)
        if not board:
            raise LookupError("board not found")

        existing_nodes = s.exec(select(Node).where(Node.board_id == board_id)).all()
        if clear_existing and existing_nodes:
            nids = [n.id for n in existing_nodes if n.id is not None]
            if nids:
                for r in s.exec(select(Request).where(Request.node_id.in_(nids))).all():
                    r.node_id = None
                    s.add(r)
                for a in s.exec(select(Asset).where(Asset.node_id.in_(nids))).all():
                    a.node_id = None
                    s.add(a)
            s.exec(sql_delete(Edge).where(Edge.board_id == board_id))
            s.exec(sql_delete(Node).where(Node.board_id == board_id))
            s.commit()
            y_offset = 0.0
        elif existing_nodes:
            y_offset = max(n.y + n.h for n in existing_nodes) + 140.0
        else:
            y_offset = 0.0

        def _mk_node(
            ntype: str,
            x: float,
            y: float,
            w: float,
            h: float,
            data: dict[str, Any],
        ) -> Node:
            node = Node(
                board_id=board_id,
                short_id=generate_unique_short_id(s, board_id),
                type=ntype,
                x=round(x, 1),
                y=round(y, 1),
                w=w,
                h=h,
                status="idle",
                data=data,
            )
            s.add(node)
            s.flush()
            return node

        # Column 1 (x=0): Pre-mount Cole Family pure-white portraits when available
        from flowboard.services.short_drama_memory import ensure_local_white_asset_cached

        eleanor_mid = ensure_local_white_asset_cached("Eleanor/Eleanor_face_white.jpg", "Eleanor")
        claire_mid = ensure_local_white_asset_cached("Claire/Claire_face_white.jpg", "Claire")

        protagonist = _mk_node(
            "character",
            0.0,
            y_offset,
            260.0,
            190.0,
            {
                "title": f"◎ 主角锚点 · Eleanor (74岁银发母亲 · {tpl['seq_id']})",
                "prompt": "Pure #FFFFFF white studio portrait of Eleanor: sixty-eight-year-old silver-haired Caucasian woman with a faint small mole on upper left cheekbone, warm observant hazel-grey eyes, and neat coiled low silver bun.",
                "aiBrief": "Eleanor (<PROTAGONIST>) · 纯白底锁脸锚点",
                "aspectRatio": "IMAGE_ASPECT_RATIO_SQUARE",
                "seqId": tpl["seq_id"],
                **({"mediaId": eleanor_mid} if eleanor_mid else {}),
            },
        )
        if eleanor_mid:
            protagonist.status = "done"
            s.add(protagonist)

        antagonist = _mk_node(
            "character",
            0.0,
            y_offset + 250.0,
            260.0,
            190.0,
            {
                "title": f"◎ 对手锚点 · Claire (48岁儿媳 · {tpl['seq_id']})",
                "prompt": "Pure #FFFFFF white studio portrait of Claire: forty-four-year-old blonde-bobbed Caucasian woman with sharp composed eyes, defined cheekbones, and understated small gold hoop earrings.",
                "aiBrief": "Claire (<ANTAGONIST>) · 纯白底锁脸锚点",
                "aspectRatio": "IMAGE_ASPECT_RATIO_SQUARE",
                "seqId": tpl["seq_id"],
                **({"mediaId": claire_mid} if claire_mid else {}),
            },
        )
        if claire_mid:
            antagonist.status = "done"
            s.add(antagonist)

        scene_prop = _mk_node(
            "visual_asset",
            0.0,
            y_offset + 520.0,
            260.0,
            190.0,
            {
                "title": f"◇ 空场/核心物证底图 · {tpl['seq_id']}",
                "prompt": "Empty story-world environment and key hero prop plate, realistic interior lighting depth, clean composition with no characters.",
                "aspectRatio": img_aspect,
                "seqId": tpl["seq_id"],
            },
        )
        director_prompt = _mk_node(
            "prompt",
            0.0,
            y_offset + 780.0,
            260.0,
            160.0,
            {
                "title": f"✦ 导演风格指令 · {tpl['seq_id']}",
                "prompt": "FLT-WARM-KODAK-2383 暖金胶片光影 | P01 0.0s双人冲突开场 | 180°带前景虚化肩膀过肩正反打(OTS) | 边干活边说话 | P10句尾留白≥0.45s",
                "seqId": tpl["seq_id"],
            },
        )

        created_edges = 0
        created_nodes = 4

        def _mk_edge(src_id: int, dst_id: int) -> None:
            nonlocal created_edges
            s.add(Edge(board_id=board_id, source_id=src_id, target_id=dst_id, kind="ref"))
            created_edges += 1

        # Columns 2 & 3: Keyframes (x=420, optional End frame at x=715) -> Video shots (x=1040)
        video_nodes: list[Node] = []
        row_step = 320.0
        for idx, st in enumerate(steps):
            row_y = y_offset + idx * row_step
            step_num = int(st.get("step_idx") or (idx + 1))
            role = str(st.get("shot_role") or "SHOT")
            size = str(st.get("shot_size") or "MS")
            cam = str(st.get("camera_movement") or "static_locked")
            dur_lbl = str(st.get("duration_range_sec") or "8s")
            bridge = str(st.get("mandatory_bridge") or "")
            pt = str(st.get("prompt_template") or "").strip()
            is_fl = _is_first_last_step(st)

            start_img = _mk_node(
                "image",
                420.0,
                row_y,
                265.0,
                185.0,
                {
                    "title": f"S{step_num:02d} {size} · {'起幅(Start)' if is_fl else role}",
                    "prompt": f"[{role} · {size}] {pt}",
                    "aspectRatio": img_aspect,
                    "variantCount": 1,
                    "seqId": tpl["seq_id"],
                },
            )
            created_nodes += 1

            # Wire relevant Column-1 anchors
            pt_upper = pt.upper()
            wired_any = False
            if "<PROTAGONIST>" in pt_upper or "PROTAGONIST" in pt_upper:
                _mk_edge(protagonist.id, start_img.id)  # type: ignore[arg-type]
                wired_any = True
            if "<ANTAGONIST>" in pt_upper or "ANTAGONIST" in pt_upper:
                _mk_edge(antagonist.id, start_img.id)  # type: ignore[arg-type]
                wired_any = True
            if not wired_any:
                _mk_edge(protagonist.id, start_img.id)  # type: ignore[arg-type]
            _mk_edge(scene_prop.id, start_img.id)  # type: ignore[arg-type]

            end_img: Optional[Node] = None
            if is_fl:
                end_img = _mk_node(
                    "image",
                    715.0,
                    row_y,
                    265.0,
                    185.0,
                    {
                        "title": f"S{step_num:02d} {size} · 落幅(End)",
                        "prompt": f"[{role} · END FRAME · IDENTICAL CAMERA] {pt}",
                        "aspectRatio": img_aspect,
                        "variantCount": 1,
                        "seqId": tpl["seq_id"],
                    },
                )
                created_nodes += 1
                _mk_edge(protagonist.id, end_img.id)  # type: ignore[arg-type]
                _mk_edge(scene_prop.id, end_img.id)  # type: ignore[arg-type]

            v_prompt_parts = [f"[{size} | {cam} | {dur_lbl}]", pt]
            if bridge and bridge.lower() != "end":
                v_prompt_parts.append(f"Transition: {bridge}.")
            vid_node = _mk_node(
                "video",
                1040.0,
                row_y,
                285.0,
                185.0,
                {
                    "title": f"S{step_num:02d} {size}·{cam} ({dur_lbl}){' ⇄首尾帧' if is_fl else ''}",
                    "prompt": " ".join(p for p in v_prompt_parts if p),
                    "aspectRatio": vid_aspect,
                    "variantCount": 1,
                    "seqId": tpl["seq_id"],
                    **({"firstLastMode": True} if is_fl else {}),
                },
            )
            created_nodes += 1
            _mk_edge(start_img.id, vid_node.id)  # type: ignore[arg-type]
            if end_img is not None:
                _mk_edge(end_img.id, vid_node.id)  # type: ignore[arg-type]
            video_nodes.append(vid_node)

        # Column 4 (x=1440): Master Assembly node
        master_y = y_offset + max(0.0, (len(video_nodes) - 1) * row_step * 0.5)
        master_node = _mk_node(
            "video",
            1440.0,
            master_y,
            320.0,
            225.0,
            {
                "title": f"🎬 {tpl['seq_id']} 总成片（待合成）",
                "prompt": f"{tpl['seq_id']} · {tpl['name']}",
                "aspectRatio": vid_aspect,
                "variantCount": 1,
                "isMasterNode": True,
                "seqId": tpl["seq_id"],
            },
        )
        created_nodes += 1
        for vn in video_nodes:
            _mk_edge(vn.id, master_node.id)  # type: ignore[arg-type]

        s.commit()
        master_id = master_node.id

    return {
        "board_id": board_id,
        "seq_id": tpl["seq_id"],
        "name": tpl["name"],
        "aspect_ratio": "16:9" if "LANDSCAPE" in vid_aspect else "9:16",
        "created_nodes": created_nodes,
        "created_edges": created_edges,
        "master_node_id": master_id,
        "step_count": len(steps),
    }
