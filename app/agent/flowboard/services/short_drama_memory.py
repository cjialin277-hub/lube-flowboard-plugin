"""Cornerstone Stories Short-Drama Memory & Hourglass KB Bridge for Lube Flowboard.

Connects the local canvas directly to:
1. `~/Cornerstone_Master_Vault/05_CHARACTER_WHITE_ASSETS/`
   (Optional local white-background studio portraits & 3-views).
2. `~/cornerstone-stories/RSI_PRINCIPLES.md` & `rsi_harness2_rrsi_engine.py`
   (Optional local RSI strategy guards).
3. `~/Documents/DeepSeek 剧本 Two/沙漏知识库_KB/`
   (4-Layer Hourglass KB pinned blocks: BLK-SCR-001, BLK-SCR-002, BLK-SCR-004,
   BLK-SCR-005, BLK-LNG-005 True TV-Drama Feel 6 Golden Rules, BLK-FLT-001).
"""
from __future__ import annotations

import base64
import json
import logging
import uuid
from pathlib import Path
from typing import Any, Optional

from sqlmodel import select

from flowboard.db import get_session
from flowboard.db.models import Asset, Board, Node
from flowboard.services import media as media_service
from flowboard.services.flow_project import effective_project_id
from flowboard.services.flow_sdk import get_flow_sdk, is_valid_project_id
from flowboard.short_id import generate_unique_short_id

logger = logging.getLogger(__name__)

_VAULT_CANDIDATES: tuple[Path, ...] = (
    Path.home() / "Cornerstone_Master_Vault" / "05_CHARACTER_WHITE_ASSETS",
    Path("/Volumes/T9/Cornerstone_Master_Vault/05_CHARACTER_WHITE_ASSETS"),
)

_KB_ROOT = Path.home() / "Documents" / "DeepSeek 剧本 Two" / "沙漏知识库_KB"
_RSI_DATA_DIR = Path.home() / "cornerstone-stories" / "data"

_COLE_FAMILY_CAST: list[dict[str, Any]] = [
    {
        "role": "Eleanor",
        "title_zh": "Eleanor · 74岁银发母亲（主角 PROTAGONIST）",
        "title_en": "Eleanor · 74yo Silver-Haired Mother",
        "slot": "<PROTAGONIST>",
        "rel_face": "Eleanor/Eleanor_face_white.jpg",
        "rel_3view": "Eleanor/Eleanor_3view_white.jpg",
        "identity_lock": (
            "sixty-eight-year-old silver-haired Caucasian woman with a faint small mole "
            "on upper left cheekbone, warm observant hazel-grey eyes, and neat coiled low silver bun"
        ),
        "default_wardrobe": "wearing a soft sage-green cashmere cardigan over an ivory silk blouse",
    },
    {
        "role": "Claire",
        "title_zh": "Claire · 48岁精明儿媳（越界对手 ANTAGONIST）",
        "title_en": "Claire · 48yo Daughter-in-Law",
        "slot": "<ANTAGONIST>",
        "rel_face": "Claire/Claire_face_white.jpg",
        "rel_3view": "Claire/Claire_3view_white.jpg",
        "identity_lock": (
            "forty-four-year-old blonde-bobbed Caucasian woman with sharp composed eyes, "
            "defined cheekbones, and understated small gold hoop earrings"
        ),
        "default_wardrobe": "wearing a tailored camel blazer over a crisp white silk camisole",
    },
    {
        "role": "Greg",
        "title_zh": "Greg · 52岁偏心儿子（摇摆中间人 WEAK_MIDDLE）",
        "title_en": "Greg · 52yo Conflicted Son",
        "slot": "<WEAK_MIDDLE>",
        "rel_face": "Greg/Greg_face_white.jpg",
        "rel_3view": "Greg/Greg_3view_white.jpg",
        "identity_lock": (
            "forty-eight-year-old broad-shouldered clean-shaven Caucasian man with short "
            "salt-and-pepper brushed-back hair and furrowed hesitant brow"
        ),
        "default_wardrobe": "wearing a charcoal quarter-zip knit sweater over a light blue collared shirt",
    },
    {
        "role": "Dana",
        "title_zh": "Dana · 46岁清醒护妈女儿（第15-35s提前护妈 ALLY）",
        "title_en": "Dana · 46yo Protective Daughter",
        "slot": "<ALLY>",
        "rel_face": "Dana/Dana_face_white.jpg",
        "rel_3view": "Dana/Dana_3view_white.jpg",
        "identity_lock": (
            "forty-five-year-old Caucasian woman with dark-brown hair tied in a neat low ponytail "
            "and steady observant dark eyes"
        ),
        "default_wardrobe": "wearing a deep navy linen shirt with rolled sleeves",
    },
]

_PINNED_MEMORY_BLOCKS: list[dict[str, Any]] = [
    {
        "block_id": "BLK-SCR-001",
        "category": "shorts-script",
        "title": "0.0s 双人动态冲突事件钩子（陌生人拉新第一铁律）",
        "summary": "C01(0.0s)首帧必须直接呈现第二人闯入、双人肢体/道具争夺或正在进行的越界动作，首句≤18词零门槛点明家庭身份关系与冲突，严禁单人站立自述。",
    },
    {
        "block_id": "BLK-SCR-002",
        "category": "shorts-script",
        "title": "四人家庭内部真实尊严母题（Eleanor / Claire / Greg / Dana）",
        "summary": "100%聚焦美国家庭婆媳与母子日常尊严刺痛点（阳光花房、老宅琴房、家宴餐桌、传家信物），停用外人反派与悬浮手写罚单。",
    },
    {
        "block_id": "BLK-SCR-004",
        "category": "shorts-script",
        "title": "高潮前置（In Medias Res）与第 15–35 秒尊严盟友提前护妈",
        "summary": "对标百万播放短剧：开场直接切入物件争夺高潮；护妈女儿 Dana 在第 15–35 秒提前介入稳住场面或点出破绽，不拖到最后10秒空降。",
    },
    {
        "block_id": "BLK-LNG-005",
        "category": "long-drama",
        "title": "美剧级「真剧感（True TV-Drama Feel）」6 大黄金铁律",
        "summary": "① 边干活边说话真实动线；② 对话强制 180° 带前景虚化肩膀过肩正反打(OTS)；③ 无台词视觉动作悬念桥；④ 字迹100%清晰可读的英雄物证微距；⑤ 句尾保留 0.50–1.00s 呼吸眼神留白。",
    },
    {
        "block_id": "BLK-FLT-001",
        "category": "visual-camera-matrix",
        "title": "美式家庭琥珀暖金胶片调色（FLT-WARM-KODAK-2383 · 3200K）",
        "summary": "35mm f/4 三层纵深对峙全景 + 85mm f/2 浅景深微表情特写，纯白底角色锚点融合 0 积分空场母版，原片 1.0x 直导剪映 +4dB 人声与全程 BGM 自动闪避。",
    },
    {
        "block_id": "BLK-FLW-011",
        "category": "flow-production",
        "title": "从剧本到 AI 叙事短片：五阶段可复用画布制作 SOP（段 vs 镜 + 8维状态接力 + P/C/S/D资产冻结）",
        "summary": "阶段1定范围算积分 → 阶段2拆导演镜头脚本（区分视频段Segment与段内镜头Shot，锁8维状态与开始/结束状态，不强绑首尾帧防僵硬）→ 阶段3反推最少必要资产(P01/C01/S01/D01_V*)并冻结 → 阶段4高风险片段先试拍 → 阶段5粗剪与三层最小单位返修。",
    },
    {
        "block_id": "BLK-FLW-012",
        "category": "flow-production",
        "title": "画布 Agent 严禁改写主体提示词契约与画布四区空间管理法则",
        "summary": "Agent 仅做任务分发器而非二次编剧：严禁删减、缩写、概括、润色、合并或打乱已确认的主体提示词、分镜顺序与台词，只允许前置挂载 P/C/S/D 资产引用与全局画幅画质约束；画布按左资产区/中上试拍返修区/中批量生成区/右成片素材库分区。",
    },
    {
        "block_id": "BLK-FLW-013",
        "category": "flow-production",
        "title": "大师导演风格镜片强制激活 + 先画平面走位图再摆机位 + 人物关系与防蒸发锁",
        "summary": "开拍前只选1位大师风格镜片(如hitchcock/fincher/spielberg)，先绘房间平面站位图锁定出入口与180°屏幕侧，禁止多人混喊Mom或对空房说话，且静止锁机占比<=40%、机位高度>=2种。",
    },
    {
        "block_id": "BLK-FLW-014",
        "category": "flow-production",
        "title": "物理因果链 + 四关0积分门禁 + 参考图洁净与防动作抢跑（@leo_xiaolei融合）",
        "summary": "前三关(角色0分先性格插画后四视图/5行分镜含观众此时懂了什么/连环定帧与切点双帧验收)全过并先报积分上限批复后方准gen_video；核心道具<=2件，OUT==next IN状态账本，新出场必铺垫且在场人禁重复进门，败阵不微笑，参考图用空场锚底不塞虚化或未入场脸图，锁end_state+禁止项，单动作<=2角度，先统一响度再拼片。",
    },
]

_ACTIVE_PRINCIPLES: list[dict[str, Any]] = [
    {"id": "P01", "name": "C01 0.0s 双人动态物理冲突开场", "status": "生效·必守", "effect": "+0.41z (p=0.004)"},
    {"id": "P02", "name": "原片 1.0x 直导剪映（废除 tpad 静帧）", "status": "生效·必守", "effect": "+0.40z (p=0.003)"},
    {"id": "P07", "name": "C01 首句台词 ≤ 18 词（零门槛点明关系）", "status": "生效·必守", "effect": "40/42 达标"},
    {"id": "P10", "name": "切镜留白中位数 ≥ 0.45s（含 40-80ms 词尾护栏）", "status": "生效·必守", "effect": "+0.68z (p=0.000)"},
    {"id": "P11", "name": "仓促切镜（<0.35s）占比 ≤ 20%", "status": "生效·必守", "effect": "+0.59z (p=0.000)"},
    {"id": "P14", "name": "全片 0 克隆死帧、0 重复半词", "status": "生效·必守", "effect": "+0.50z"},
]

_BANNED_PRINCIPLES: list[dict[str, Any]] = [
    {"id": "P08", "name": "禁止 C01 第一句台词包含具体金额数字", "status": "已淘汰·禁用", "effect": "-0.46z (p=0.027)"},
    {"id": "P13", "name": "禁止硬限成片时长 ≤ 90s 而砍掉呼吸留白", "status": "已淘汰·禁用", "effect": "-0.64z (p=0.000)"},
]


def _resolve_vault_dir() -> Optional[Path]:
    for cand in _VAULT_CANDIDATES:
        if cand.is_dir():
            return cand
    return None


def ensure_local_white_asset_cached(rel_path: str, role: str) -> Optional[str]:
    """Ensure a pure-white character asset file is cached in `MEDIA_CACHE_DIR` & `Asset` table.

    Returns its deterministic `uuid_media_id` so `/media/<id>` serves it immediately.
    """
    vault = _resolve_vault_dir()
    if vault is None:
        return None
    src = vault / rel_path
    if not src.is_file():
        return None

    media_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"cornerstone.white.asset.{rel_path}"))
    dst = media_service.MEDIA_CACHE_DIR / f"{media_id}.jpg"
    try:
        if not dst.is_file() or dst.stat().st_size != src.stat().st_size:
            dst.write_bytes(src.read_bytes())
    except OSError as exc:
        logger.warning("Failed to cache white asset %s: %s", src, exc)
        return None

    with get_session() as s:
        row = s.exec(select(Asset).where(Asset.uuid_media_id == media_id)).first()
        if row is None:
            row = Asset(
                uuid_media_id=media_id,
                kind="image",
                local_path=str(dst),
                mime="image/jpeg",
            )
            s.add(row)
            s.commit()
        elif not row.local_path:
            row.local_path = str(dst)
            row.mime = "image/jpeg"
            s.add(row)
            s.commit()
    return media_id


def _load_director_lenses_summary(featured_only: bool = False) -> list[dict[str, Any]]:
    """Dynamically load master director style lenses from `cinematic-director`."""
    try:
        import importlib.util

        gate_p = (
            Path.home()
            / ".gemini"
            / "config"
            / "skills"
            / "lube-cornerstone-studio"
            / "scripts"
            / "director_blocking_gate.py"
        )
        if not gate_p.is_file():
            return []
        spec = importlib.util.spec_from_file_location("director_blocking_gate", str(gate_p))
        if spec is None or spec.loader is None:
            return []
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        lenses = mod.list_director_lenses()
        if featured_only:
            featured = ("hitchcock", "fincher", "spielberg", "park_chan_wook", "wong_kar_wai")
            by_id = {x["style_id"]: x for x in lenses}
            return [by_id[fid] for fid in featured if fid in by_id]
        return lenses
    except Exception as exc:
        logger.warning("Failed to load director lenses: %s", exc)
        return []


def get_short_drama_memory_snapshot() -> dict[str, Any]:
    """Return full Cornerstone Short-Drama Memory snapshot for the canvas UI."""
    vault = _resolve_vault_dir()
    cast_items: list[dict[str, Any]] = []
    for item in _COLE_FAMILY_CAST:
        face_media_id = ensure_local_white_asset_cached(item["rel_face"], item["role"])
        view3_media_id = ensure_local_white_asset_cached(item["rel_3view"], item["role"])
        cast_items.append(
            {
                "role": item["role"],
                "title_zh": item["title_zh"],
                "title_en": item["title_en"],
                "slot": item["slot"],
                "identity_lock": item["identity_lock"],
                "default_wardrobe": item["default_wardrobe"],
                "face_media_id": face_media_id,
                "three_view_media_id": view3_media_id,
                "face_path": str(vault / item["rel_face"]) if vault else item["rel_face"],
            }
        )

    forbidden_keywords = ["deed"]
    try:
        ledger_p = _RSI_DATA_DIR / "case_library.json"
        if ledger_p.is_file():
            data = json.loads(ledger_p.read_text(encoding="utf-8"))
            if isinstance(data, dict) and data.get("forbidden_recent_keywords"):
                forbidden_keywords = list(data["forbidden_recent_keywords"])
    except Exception:
        pass

    return {
        "ok": True,
        "engine_version": "4.0-harness2-rrsi-canvas-master",
        "channel_name": "Cornerstone Stories (@cornerstonestories-e3g)",
        "vault_dir": str(vault) if vault else None,
        "kb_dir": str(_KB_ROOT) if _KB_ROOT.is_dir() else None,
        "active_principles": _ACTIVE_PRINCIPLES,
        "banned_principles": _BANNED_PRINCIPLES,
        "forbidden_recent_keywords": forbidden_keywords,
        "pinned_blocks": _PINNED_MEMORY_BLOCKS,
        "director_lenses": _load_director_lenses_summary(featured_only=True),
        "cast": cast_items,
        "recommended_1min_template": {
            "seq_id": "SEQ-0008",
            "name": "Cornerstone 1分钟 8镜黄金模板（0.0s双人冲突+Dana第16s护妈+180°过肩OTS+可读物证微距）",
            "shots": 8,
            "duration_sec": 64,
        },
    }


async def upload_white_asset_to_flow_or_local(
    rel_path: str,
    role: str,
    project_id: Optional[str],
    upload_to_flow: bool = True,
) -> Optional[str]:
    """Upload pure-white character portrait to Google Flow project so it can be used in `ref_media_ids`.

    Falls back cleanly to local cached UUID if Flow upload is skipped or offline.
    """
    vault = _resolve_vault_dir()
    if vault is None:
        return None
    src = vault / rel_path
    if not src.is_file():
        return None
    raw = src.read_bytes()

    if upload_to_flow and project_id and is_valid_project_id(project_id):
        try:
            image_b64 = base64.b64encode(raw).decode("ascii")
            resp = await get_flow_sdk().upload_image(
                image_base64=image_b64,
                mime_type="image/jpeg",
                project_id=project_id,
                file_name=src.name,
            )
            flow_mid = resp.get("media_id")
            if isinstance(flow_mid, str) and media_service.is_valid_media_id(flow_mid):
                dst = media_service.MEDIA_CACHE_DIR / f"{flow_mid}.jpg"
                dst.write_bytes(raw)
                with get_session() as s:
                    row = s.exec(select(Asset).where(Asset.uuid_media_id == flow_mid)).first()
                    if row is None:
                        row = Asset(
                            uuid_media_id=flow_mid,
                            kind="image",
                            local_path=str(dst),
                            mime="image/jpeg",
                        )
                    else:
                        row.local_path = str(dst)
                        row.mime = "image/jpeg"
                    s.add(row)
                    s.commit()
                logger.info("Uploaded white asset %s to Flow project %s -> media_id=%s", role, project_id, flow_mid)
                return flow_mid
        except Exception as exc:
            logger.warning("Flow upload for white asset %s failed (%s), falling back to local cache", role, exc)

    return ensure_local_white_asset_cached(rel_path, role)


async def mount_cole_family_cast_to_board(
    board_id: int,
    *,
    upload_to_flow: bool = True,
    roles: Optional[list[str]] = None,
) -> dict[str, Any]:
    """Mount Cole Family pure-white character anchor nodes into Column 1 (`x=0`) of `board_id`."""
    project_id = effective_project_id()
    wanted_roles = {r.strip().lower() for r in (roles or []) if r.strip()}

    selected_cast = [
        c for c in _COLE_FAMILY_CAST
        if not wanted_roles or c["role"].lower() in wanted_roles
    ]

    mounted: list[dict[str, Any]] = []
    with get_session() as s:
        board = s.get(Board, board_id)
        if not board:
            raise LookupError("board not found")
        existing_nodes = s.exec(select(Node).where(Node.board_id == board_id)).all()

    # Upload/resolve media_ids first outside DB lock
    resolved_media: dict[str, Optional[str]] = {}
    for c in selected_cast:
        mid = await upload_white_asset_to_flow_or_local(
            c["rel_face"],
            c["role"],
            project_id,
            upload_to_flow=upload_to_flow,
        )
        resolved_media[c["role"]] = mid

    with get_session() as s:
        existing_nodes = s.exec(select(Node).where(Node.board_id == board_id)).all()
        base_y = 0.0
        for idx, c in enumerate(selected_cast):
            role_name = c["role"]
            mid = resolved_media.get(role_name)
            prompt_str = (
                f"Pure #FFFFFF white studio portrait of {role_name}: {c['identity_lock']}, "
                f"{c['default_wardrobe']}. High facial clarity, neutral studio lighting."
            )

            # Check if an existing character node on this board already represents this role
            target_node: Optional[Node] = None
            for n in existing_nodes:
                if n.type == "character":
                    title_str = str((n.data or {}).get("title") or "")
                    if role_name.lower() in title_str.lower() or (
                        idx == 0 and "主角锚点" in title_str
                    ) or (
                        idx == 1 and "对手锚点" in title_str
                    ):
                        target_node = n
                        break

            node_data = {
                "title": f"◎ {c['title_zh']}",
                "prompt": prompt_str,
                "aiBrief": f"{role_name} ({c['slot']}) · 纯白底锁脸锚点: {c['identity_lock']}",
                "aspectRatio": "IMAGE_ASPECT_RATIO_SQUARE",
                "roleName": role_name,
                "roleSlot": c["slot"],
                "identityLock": c["identity_lock"],
                **({"mediaId": mid} if mid else {}),
            }

            if target_node is not None:
                merged = dict(target_node.data or {})
                merged.update(node_data)
                target_node.data = merged
                target_node.status = "done" if mid else target_node.status
                s.add(target_node)
                s.flush()
                node_obj = target_node
            else:
                node_obj = Node(
                    board_id=board_id,
                    short_id=generate_unique_short_id(s, board_id),
                    type="character",
                    x=0.0,
                    y=round(base_y + idx * 235.0, 1),
                    w=260.0,
                    h=195.0,
                    status="done" if mid else "idle",
                    data=node_data,
                )
                s.add(node_obj)
                s.flush()

            mounted.append(
                {
                    "node_id": node_obj.id,
                    "short_id": node_obj.short_id,
                    "role": role_name,
                    "title": node_data["title"],
                    "media_id": mid,
                    "identity_lock": c["identity_lock"],
                }
            )
        s.commit()

    return {
        "ok": True,
        "board_id": board_id,
        "project_id": project_id,
        "mounted_count": len(mounted),
        "characters": mounted,
    }
