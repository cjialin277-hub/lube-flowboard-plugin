#!/usr/bin/env python3
"""Local stdio MCP bridge for Flowboard (:8434) with credit-quote & dry_run gates."""
from __future__ import annotations

import hashlib
import json
import os
from typing import Any, Literal, Optional

import httpx
from mcp.server.mcpserver import MCPServer

API_BASE = os.environ.get("FLOWBOARD_API_BASE", "http://127.0.0.1:8434").rstrip("/")
FORCE_DRY_RUN = os.environ.get("FLOWBOARD_MCP_FORCE_DRY_RUN", "0").strip().lower() in (
    "1",
    "true",
    "yes",
)

OMNI_CREDITS_BY_DURATION = {4: 12, 6: 18, 8: 24, 10: 30}
VEO_CREDITS_BY_QUALITY = {"lite": 5, "fast": 10}

mcp = MCPServer(
    name="flowboard",
    instructions=(
        "本地影视画布工作台（localhost:5173 / FastAPI :8434）MCP 桥接。"
        "所有扣积分的视频生成与 Midjourney 直连网关出图均带硬性两段式报价闸门："
        "首次调用（confirm_spend=False）仅返回报价与 quote_token，获用户明确确认后再带 confirm_spend=True 与原样 quote_token 放行。"
    ),
)


def _client(timeout: float = 60.0) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=API_BASE,
        trust_env=False,
        timeout=httpx.Timeout(timeout, connect=5.0),
    )


async def _api(
    method: str,
    path: str,
    *,
    json_body: Optional[dict[str, Any]] = None,
    params: Optional[dict[str, Any]] = None,
    timeout: float = 60.0,
) -> dict[str, Any]:
    try:
        async with _client(timeout=timeout) as client:
            resp = await client.request(method, path, json=json_body, params=params)
        try:
            data = resp.json()
        except Exception:
            data = {"raw": resp.text}
        if resp.status_code >= 400:
            return {"ok": False, "status_code": resp.status_code, "error": data}
        return data if isinstance(data, dict) else {"ok": True, "items": data}
    except httpx.ConnectError:
        return {
            "ok": False,
            "error": f"无法连接画布后端 {API_BASE}，请先检查 ~/flowboard/flowboard_ctl.sh status",
        }
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def _make_quote_token(payload: dict[str, Any]) -> str:
    canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:8]


async def _resolve_project_id(
    project_id: Optional[str], board_id: Optional[int] = None
) -> Optional[str]:
    if isinstance(project_id, str) and project_id.strip():
        return project_id.strip()
    if board_id is not None:
        bound = await _api("GET", f"/api/boards/{board_id}/project")
        pid = bound.get("flow_project_id")
        if isinstance(pid, str) and pid.strip():
            return pid.strip()
    pinned = await _api("GET", "/api/flow/projects/pinned")
    pid = pinned.get("flow_project_id")
    return pid.strip() if isinstance(pid, str) and pid.strip() else None


@mcp.tool()
async def flowboard_health() -> dict[str, Any]:
    """检查本地画布引擎 (:8434)、Chrome 扩展桥 (:8355) 在线状态及默认 Flow 项目 ID（0 积分）。"""
    health = await _api("GET", "/api/health")
    pinned = await _api("GET", "/api/flow/projects/pinned")
    mj = await _api("GET", "/api/flow/projects/midjourney")
    return {
        "api_base": API_BASE,
        "force_dry_run": FORCE_DRY_RUN,
        "health": health,
        "pinned_flow_project": pinned,
        "midjourney": mj,
    }


@mcp.tool()
async def flowboard_manage_board(
    action: Literal["list", "get", "create"] = "list",
    board_id: Optional[int] = None,
    name: Optional[str] = None,
) -> dict[str, Any]:
    """列出画布、读取单张画布全部节点与连线、或新建空白画布（0 积分）。"""
    if action == "list":
        return await _api("GET", "/api/boards")
    if action == "get":
        if board_id is None:
            return {"ok": False, "error": "action='get' 必须传入 board_id"}
        return await _api("GET", f"/api/boards/{board_id}")
    if not name or not name.strip():
        return {"ok": False, "error": "action='create' 必须传入非空 name"}
    return await _api("POST", "/api/boards", json_body={"name": name.strip()})


@mcp.tool()
async def flowboard_mount_cast(
    board_id: int,
    roles: Optional[list[str]] = None,
    upload_to_flow: bool = True,
) -> dict[str, Any]:
    """一键在画布挂载 Cole 家族白底角色锚点并同步至 Flow 项目（0 积分）。"""
    body: dict[str, Any] = {"upload_to_flow": upload_to_flow}
    if roles is not None:
        body["roles"] = roles
    return await _api(
        "POST",
        f"/api/boards/{board_id}/mount-short-drama-cast",
        json_body=body,
        timeout=180.0,
    )


@mcp.tool()
async def flowboard_upsert_node(
    board_id: Optional[int] = None,
    node_id: Optional[int] = None,
    type: Optional[
        Literal[
            "character",
            "image",
            "video",
            "prompt",
            "note",
            "merge",
            "visual_asset",
            "Storyboard",
        ]
    ] = None,
    x: Optional[float] = None,
    y: Optional[float] = None,
    w: Optional[float] = None,
    h: Optional[float] = None,
    data: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """新建节点（传 board_id + type）或浅合并更新已有节点（传 node_id）（0 积分）。"""
    if node_id is not None:
        patch: dict[str, Any] = {}
        for k, v in (("x", x), ("y", y), ("w", w), ("h", h), ("data", data)):
            if v is not None:
                patch[k] = v
        if not patch:
            return {"ok": False, "error": "更新节点至少提供一个字段（x/y/w/h/data）"}
        return await _api("PATCH", f"/api/nodes/{node_id}", json_body=patch)

    if board_id is None or type is None:
        return {"ok": False, "error": "新建节点必须同时传入 board_id 和 type"}
    body: dict[str, Any] = {
        "board_id": board_id,
        "type": type,
        "x": 0.0 if x is None else x,
        "y": 0.0 if y is None else y,
        "w": 240.0 if w is None else w,
        "h": 160.0 if h is None else h,
        "data": data or {},
    }
    return await _api("POST", "/api/nodes", json_body=body)


@mcp.tool()
async def flowboard_connect_edge(
    action: Literal["create", "delete"] = "create",
    board_id: Optional[int] = None,
    source_id: Optional[int] = None,
    target_id: Optional[int] = None,
    kind: Literal["ref", "hint"] = "ref",
    source_variant_idx: Optional[int] = None,
    edge_id: Optional[int] = None,
) -> dict[str, Any]:
    """在画布创建节点连线（支持锁定多宫格变体索引 source_variant_idx）或删除连线（0 积分）。"""
    if action == "delete":
        if edge_id is None:
            return {"ok": False, "error": "action='delete' 必须传入 edge_id"}
        return await _api("DELETE", f"/api/edges/{edge_id}")
    if board_id is None or source_id is None or target_id is None:
        return {"ok": False, "error": "action='create' 必须传入 board_id、source_id、target_id"}
    body: dict[str, Any] = {
        "board_id": board_id,
        "source_id": source_id,
        "target_id": target_id,
        "kind": kind,
    }
    if source_variant_idx is not None:
        body["source_variant_idx"] = source_variant_idx
    return await _api("POST", "/api/edges", json_body=body)


@mcp.tool()
async def flowboard_generate_image(
    node_id: int,
    prompt: str,
    aspect_ratio: Literal[
        "IMAGE_ASPECT_RATIO_PORTRAIT",
        "IMAGE_ASPECT_RATIO_LANDSCAPE",
        "IMAGE_ASPECT_RATIO_SQUARE",
    ] = "IMAGE_ASPECT_RATIO_PORTRAIT",
    media_provider: Literal["flow", "midjourney", "dry_run"] = "flow",
    image_model: Literal["NANO_BANANA_PRO", "MIDJOURNEY_V7"] = "NANO_BANANA_PRO",
    ref_media_ids: Optional[list[str]] = None,
    variant_count: int = 1,
    prompts: Optional[list[str]] = None,
    project_id: Optional[str] = None,
    board_id: Optional[int] = None,
    dry_run: bool = False,
    confirm_spend: bool = False,
    quote_token: Optional[str] = None,
) -> dict[str, Any]:
    """提交分镜/角色静帧生成。Flow NANO_BANANA_PRO 为 0 积分；MJ 直连付费网关触发先报价确认闸门。"""
    if str(image_model).upper() == "NANO_BANANA_2":
        return {"ok": False, "error": "NANO_BANANA_2 已退役，请使用 NANO_BANANA_PRO"}
    if ref_media_ids and len(ref_media_ids) > 4:
        return {"ok": False, "error": f"ref_media_ids 数量为 {len(ref_media_ids)}，超过单镜 4 张防污染上限"}
    if variant_count < 1 or variant_count > 4:
        return {"ok": False, "error": "variant_count 必须在 1～4 之间"}

    effective_dry = dry_run or FORCE_DRY_RUN or media_provider == "dry_run"
    eff_provider = "dry_run" if effective_dry else media_provider

    # Midjourney 直连付费网关走强制报价确认闸门；hybrid_flow 走 Flow Ultra GEM_PIX_2 (0 积分)
    if not effective_dry and (eff_provider == "midjourney" or image_model == "MIDJOURNEY_V7"):
        mj_cfg = await _api("GET", "/api/flow/projects/midjourney")
        if mj_cfg.get("mode") == "gateway":
            quote_key = {
                "op": "gen_image_mj_gateway",
                "node_id": node_id,
                "image_model": image_model,
                "aspect_ratio": aspect_ratio,
                "variant_count": variant_count,
                "prompt_sha8": hashlib.sha256(prompt.strip().encode("utf-8")).hexdigest()[:8],
            }
            expected_token = _make_quote_token(quote_key)
            if not confirm_spend or quote_token != expected_token:
                return {
                    "ok": False,
                    "status": "quote_required",
                    "billing_channel": "midjourney_gateway",
                    "variant_count": variant_count,
                    "quote_token": expected_token,
                    "summary": f"即将通过 Midjourney 直连网关生成 {variant_count} 组 V7 静帧（消耗外部 MJ 额度）",
                    "next_step": "请先向用户确认额度消耗，获得同意后携带 confirm_spend=True 与上述 quote_token 重新调用；或设 dry_run=True 进行 0 积分演练。",
                }

    params: dict[str, Any] = {
        "prompt": prompt.strip(),
        "aspect_ratio": aspect_ratio,
        "media_provider": eff_provider,
        "image_model": image_model,
        "variant_count": variant_count,
    }
    if ref_media_ids:
        params["ref_media_ids"] = ref_media_ids
    if prompts:
        params["prompts"] = prompts
    if not effective_dry:
        pid = await _resolve_project_id(project_id, board_id)
        if not pid:
            return {"ok": False, "error": "未找到有效 Flow project_id，请检查 /api/flow/projects/pinned"}
        params["project_id"] = pid

    res = await _api(
        "POST",
        "/api/requests",
        json_body={"node_id": node_id, "type": "gen_image", "params": params},
    )
    return {"effective_dry_run": effective_dry, "request": res}


@mcp.tool()
async def flowboard_generate_video(
    node_id: int,
    prompt: str,
    mode: Literal["gen_video", "gen_video_omni", "gen_video_first_last"] = "gen_video",
    aspect_ratio: Literal[
        "VIDEO_ASPECT_RATIO_PORTRAIT",
        "VIDEO_ASPECT_RATIO_LANDSCAPE",
    ] = "VIDEO_ASPECT_RATIO_PORTRAIT",
    start_media_id: Optional[str] = None,
    end_media_id: Optional[str] = None,
    ref_media_ids: Optional[list[str]] = None,
    video_quality: Literal["lite", "fast"] = "lite",
    duration_s: Literal[4, 6, 8, 10] = 8,
    resolution: Literal["720p", "360p"] = "720p",
    project_id: Optional[str] = None,
    board_id: Optional[int] = None,
    dry_run: bool = False,
    confirm_spend: bool = False,
    quote_token: Optional[str] = None,
) -> dict[str, Any]:
    """提交视频生成（Veo 3.1 / Omni Flash / 首尾帧）。消耗积分操作强制走先报价确认闸门；dry_run=True 为 0 积分演练。"""
    if ref_media_ids and len(ref_media_ids) > 4:
        return {"ok": False, "error": f"ref_media_ids 数量为 {len(ref_media_ids)}，超过单镜 4 张上限"}

    if mode == "gen_video" and not (start_media_id and start_media_id.strip()):
        return {"ok": False, "error": "mode='gen_video' 必须传入 start_media_id"}
    if mode == "gen_video_omni" and not (ref_media_ids or (start_media_id and start_media_id.strip())):
        return {"ok": False, "error": "mode='gen_video_omni' 必须传入 ref_media_ids 或 start_media_id"}
    if mode == "gen_video_first_last" and (
        not (start_media_id and start_media_id.strip())
        or not (end_media_id and end_media_id.strip())
    ):
        return {"ok": False, "error": "mode='gen_video_first_last' 必须同时传入 start_media_id 与 end_media_id"}

    effective_dry = dry_run or FORCE_DRY_RUN
    if mode == "gen_video":
        estimated_credits = 0 if effective_dry else VEO_CREDITS_BY_QUALITY[video_quality]
        model_desc = f"Veo 3.1 ({video_quality}, 8s)"
    elif mode == "gen_video_omni":
        estimated_credits = 0 if effective_dry else OMNI_CREDITS_BY_DURATION[duration_s]
        model_desc = f"Omni Flash (abra_r2v_{duration_s}s)"
    else:
        estimated_credits = 0 if effective_dry else OMNI_CREDITS_BY_DURATION[duration_s]
        model_desc = f"首尾帧过渡 ({duration_s}s, {resolution})"

    if not effective_dry:
        quote_key = {
            "op": mode,
            "node_id": node_id,
            "aspect_ratio": aspect_ratio,
            "video_quality": video_quality if mode == "gen_video" else None,
            "duration_s": 8 if mode == "gen_video" else duration_s,
            "resolution": resolution if mode == "gen_video_first_last" else None,
            "start_media_id": start_media_id,
            "end_media_id": end_media_id,
            "ref_media_ids": ref_media_ids or [],
            "prompt_sha8": hashlib.sha256(prompt.strip().encode("utf-8")).hexdigest()[:8],
        }
        expected_token = _make_quote_token(quote_key)
        if not confirm_spend or quote_token != expected_token:
            active_warning = None
            if board_id is not None:
                active = await _api(
                    "GET",
                    f"/api/boards/{board_id}/requests",
                    params={"active": "true", "kinds": "worker"},
                )
                in_flight = [
                    r for r in (active.get("items") or []) if str(r.get("type", "")).startswith("gen_video")
                ]
                if in_flight:
                    active_warning = f"当前画布已有 {len(in_flight)} 条视频任务运行中，建议遵守单镜顺序投递防风控。"
            return {
                "ok": False,
                "status": "quote_required",
                "mode": mode,
                "model": model_desc,
                "estimated_credits": estimated_credits,
                "quote_token": expected_token,
                "active_video_warning": active_warning,
                "summary": f"本次 {model_desc} 预计消耗 {estimated_credits} 积分（node_id={node_id}，画幅={aspect_ratio}）",
                "next_step": "请先向用户展示上述报价，获得明确同意后再以相同参数 + confirm_spend=True + quote_token 重新调用；或设 dry_run=True 执行 0 积分演练。",
            }

    params: dict[str, Any] = {
        "prompt": prompt.strip(),
        "aspect_ratio": aspect_ratio,
        "media_provider": "dry_run" if effective_dry else "flow",
    }
    if mode == "gen_video":
        params["start_media_id"] = start_media_id.strip()  # type: ignore[union-attr]
        params["video_quality"] = video_quality
    elif mode == "gen_video_omni":
        params["ref_media_ids"] = ref_media_ids or [start_media_id.strip()]  # type: ignore[union-attr]
        params["duration_s"] = duration_s
    else:
        params["start_media_id"] = start_media_id.strip()  # type: ignore[union-attr]
        params["end_media_id"] = end_media_id.strip()  # type: ignore[union-attr]
        params["duration_s"] = duration_s
        params["resolution"] = resolution

    if not effective_dry:
        pid = await _resolve_project_id(project_id, board_id)
        if not pid:
            return {"ok": False, "error": "未找到有效 Flow project_id，请检查 /api/flow/projects/pinned"}
        params["project_id"] = pid

    res = await _api(
        "POST",
        "/api/requests",
        json_body={"node_id": node_id, "type": mode, "params": params},
    )
    return {
        "effective_dry_run": effective_dry,
        "estimated_credits": estimated_credits,
        "model": model_desc,
        "request": res,
    }


@mcp.tool()
async def flowboard_poll_request(
    request_id: Optional[int] = None,
    board_id: Optional[int] = None,
    cancel: bool = False,
) -> dict[str, Any]:
    """查询单条请求进度/结果、查看整板进行中任务，或取消卡住的任务（0 积分）。"""
    if request_id is not None:
        if cancel:
            return await _api("POST", f"/api/requests/{request_id}/cancel")
        return await _api("GET", f"/api/requests/{request_id}")
    if board_id is not None:
        return await _api(
            "GET",
            f"/api/boards/{board_id}/requests",
            params={"active": "true", "kinds": "worker"},
        )
    return {"ok": False, "error": "请至少传入 request_id 或 board_id"}


@mcp.tool()
async def flowboard_extract_tail_frame(
    node_id: int,
    variant_idx: int = 0,
    upload_to_flow: bool = True,
) -> dict[str, Any]:
    """用本地 ffmpeg 抽取视频节点的真实尾帧，并在右侧自动生成衔接图片节点（0 积分）。"""
    return await _api(
        "POST",
        f"/api/nodes/{node_id}/extract-tail-frame",
        json_body={"variant_idx": variant_idx, "upload_to_flow": upload_to_flow},
        timeout=120.0,
    )


@mcp.tool()
async def flowboard_assemble_master(
    board_id: int,
    export_jianying: bool = True,
    copy_to_jianying_dir: bool = True,
    bgm_path: Optional[str] = None,
) -> dict[str, Any]:
    """按 1.0x 原生帧率汇总画布成片（+4dB 人声、BGM 闪避、0 死帧）并导出剪映草稿（0 积分）。"""
    body: dict[str, Any] = {
        "export_jianying": export_jianying,
        "copy_to_jianying_dir": copy_to_jianying_dir,
    }
    if bgm_path:
        body["bgm_path"] = bgm_path
    return await _api(
        "POST",
        f"/api/boards/{board_id}/assemble-master",
        json_body=body,
        timeout=300.0,
    )


if __name__ == "__main__":
    mcp.run(transport="stdio")
