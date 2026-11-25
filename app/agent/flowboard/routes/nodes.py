import base64
from datetime import datetime, timezone
import logging
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, Body, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import select

from flowboard.db import get_session
from flowboard.db.models import Asset, Board, BoardFlowProject, Edge, Node, Request
from flowboard.services import media as media_service
from flowboard.services.dry_run_media import resolve_ffmpeg
from flowboard.services.flow_client import flow_client
from flowboard.services.flow_project import effective_project_id
from flowboard.services.flow_sdk import get_flow_sdk, is_valid_project_id
from flowboard.short_id import generate_unique_short_id
from flowboard.timestamps import utc_now_iso

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/nodes", tags=["nodes"])

NodeType = Literal[
    "character",
    "image",
    "video",
    "prompt",
    "note",
    "merge",
    "visual_asset",
    # Storyboard = thin image-node wrapper. Backend treats it the same as
    # `image` for storage / dispatch — see frontend/src/lib/storyboardPrompt.ts
    # for the template that drives gen_image.
    "Storyboard",
]
NodeStatus = Literal["idle", "queued", "running", "done", "error"]

_COORD_MIN = -1_000_000.0
_COORD_MAX = 1_000_000.0
_SIZE_MAX = 100_000.0


class NodeCreate(BaseModel):
    board_id: int
    type: NodeType
    x: float = Field(default=0.0, ge=_COORD_MIN, le=_COORD_MAX)
    y: float = Field(default=0.0, ge=_COORD_MIN, le=_COORD_MAX)
    w: float = Field(default=240.0, gt=0, le=_SIZE_MAX)
    h: float = Field(default=160.0, gt=0, le=_SIZE_MAX)
    data: dict = {}
    status: NodeStatus = "idle"


class NodeUpdate(BaseModel):
    x: Optional[float] = Field(default=None, ge=_COORD_MIN, le=_COORD_MAX)
    y: Optional[float] = Field(default=None, ge=_COORD_MIN, le=_COORD_MAX)
    w: Optional[float] = Field(default=None, gt=0, le=_SIZE_MAX)
    h: Optional[float] = Field(default=None, gt=0, le=_SIZE_MAX)
    data: Optional[dict] = None
    status: Optional[NodeStatus] = None


@router.post("")
def create_node(body: NodeCreate):
    with get_session() as s:
        if not s.get(Board, body.board_id):
            raise HTTPException(404, "board not found")
        short_id = generate_unique_short_id(s, body.board_id)
        node = Node(
            board_id=body.board_id,
            short_id=short_id,
            type=body.type,
            x=body.x,
            y=body.y,
            w=body.w,
            h=body.h,
            data=body.data,
            status=body.status,
        )
        s.add(node)
        s.commit()
        s.refresh(node)
        return node


@router.patch("/{node_id}")
def update_node(node_id: int, body: NodeUpdate):
    """Partial update.

    The `data` field is **shallow-merged** into the existing JSON
    column rather than wholesale-replaced — earlier behavior dropped
    any sibling field the caller forgot to list, which silently erased
    `aspectRatio`, `aiBrief`, and other state every time the frontend
    sent a partial update. Merge is the natural REST PATCH semantic
    and prevents that whole class of regression.

    Merge depth is **one level** — patch keys at the top level of
    `data` are merged with existing keys, but if a key's value is
    itself a dict, the new dict REPLACES the old one (no recursive
    merge). All current FlowboardNodeData fields are scalars / arrays,
    so this matches the schema. If a future field needs nested-merge
    semantics, switch to a recursive walker here and update this
    docstring.

    Sentinel: a value of `null` in the data patch deletes the key. So
    callers that want to clear `aiBrief` after a regen pass
    `{aiBrief: null}` (still merge-safe — no risk of accidentally
    nuking unrelated fields). Missing keys are preserved.

    Non-`data` fields (`x`, `y`, `w`, `h`, `status`) keep the original
    setattr-replace semantic — no merge applied.
    """
    with get_session() as s:
        node = s.get(Node, node_id)
        if not node:
            raise HTTPException(404, "node not found")
        patch = body.model_dump(exclude_unset=True)
        for k, v in patch.items():
            if k == "data" and isinstance(v, dict):
                merged = dict(node.data or {})
                for dk, dv in v.items():
                    if dv is None:
                        merged.pop(dk, None)
                    else:
                        merged[dk] = dv
                node.data = merged
            else:
                setattr(node, k, v)
        s.add(node)
        s.commit()
        s.refresh(node)
        return node


@router.delete("/{node_id}")
def delete_node(node_id: int):
    """Delete a node + cascade.

    Edges are owned by the graph — delete them outright.
    Request + Asset rows are *historical* (activity feed, media cache)
    and have a nullable `node_id` FK. Detach them (set node_id=NULL)
    rather than delete, so:
      - the activity feed still shows the historical generation entries
      - saved References pointing at this node's media keep working
        (Asset row survives, and `/media/{id}` still resolves to the
        cached file on disk).

    Skipping this detach step caused a FOREIGN KEY constraint failure
    that aborted the whole transaction — the user saw the node vanish
    locally (optimistic via applyNodeChanges) but reload restored it
    because the backend never actually deleted it.
    """
    with get_session() as s:
        node = s.get(Node, node_id)
        if not node:
            raise HTTPException(404, "node not found")
        # Detach historical children FIRST so the FK constraint is satisfied.
        orphan_requests = s.exec(
            select(Request).where(Request.node_id == node_id)
        ).all()
        for r in orphan_requests:
            r.node_id = None
            s.add(r)
        orphan_assets = s.exec(
            select(Asset).where(Asset.node_id == node_id)
        ).all()
        for a in orphan_assets:
            a.node_id = None
            s.add(a)
        # Edges go with the node.
        edges = s.exec(
            select(Edge).where((Edge.source_id == node_id) | (Edge.target_id == node_id))
        ).all()
        for e in edges:
            s.delete(e)
        s.delete(node)
        s.commit()
        return {
            "ok": True,
            "deleted_edges": [e.id for e in edges],
            "detached_requests": len(orphan_requests),
            "detached_assets": len(orphan_assets),
        }


def _node_has_usable_media(data: Optional[dict]) -> bool:
    if not isinstance(data, dict):
        return False
    mid = data.get("mediaId")
    if isinstance(mid, str) and mid.strip():
        return True
    mids = data.get("mediaIds")
    if isinstance(mids, list) and any(isinstance(m, str) and m.strip() for m in mids):
        return True
    return False


@router.post("/{node_id}/cancel")
def cancel_node_requests(node_id: int):
    """Cancel all queued/running requests for a node and reset its status cleanly.

    Idempotent: returns 200 with an empty ``canceled_request_ids`` list if no
    active request remains (instead of failing with 409) so misclick undo buttons
    stay calm and reliable.
    """
    with get_session() as s:
        node = s.get(Node, node_id)
        if not node:
            raise HTTPException(404, "node not found")
        active_reqs = s.exec(
            select(Request).where(
                Request.node_id == node_id,
                Request.status.in_(("queued", "running")),  # type: ignore[attr-defined]
            )
        ).all()
        now_utc = datetime.now(timezone.utc)
        canceled_ids: list[int] = []
        for req in active_reqs:
            req.status = "canceled"
            req.error = "canceled"
            req.finished_at = now_utc
            s.add(req)
            if req.id is not None:
                canceled_ids.append(req.id)

        if node.status in ("queued", "running"):
            node.status = "done" if _node_has_usable_media(node.data) else "idle"
            s.add(node)
        s.commit()
        s.refresh(node)
        return {
            "ok": True,
            "node_id": node_id,
            "canceled_request_ids": canceled_ids,
            "node_status": node.status,
        }


class ExtractTailFrameBody(BaseModel):
    variant_idx: int = Field(default=0, ge=0, le=10)
    upload_to_flow: bool = True


def _extract_last_frame_jpg(ffmpeg_bin: str, mp4_path: Path, out_jpg: Path) -> bool:
    """Extract the last frame from mp4_path to out_jpg, falling back for ultra-short clips."""
    for extra in (["-sseof", "-0.1"], []):
        cmd = [
            ffmpeg_bin,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            *extra,
            "-i",
            str(mp4_path),
            "-frames:v",
            "1",
            "-q:v",
            "2",
            str(out_jpg),
        ]
        proc = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=False)
        if proc.returncode == 0 and out_jpg.is_file() and out_jpg.stat().st_size > 0:
            return True
    return False


@router.post("/{node_id}/extract-tail-frame")
async def extract_tail_frame(
    node_id: int,
    body: Optional[ExtractTailFrameBody] = Body(default=None),
):
    """Extract the final frame of a video node and spawn a linked image node to its right."""
    opts = body or ExtractTailFrameBody()
    with get_session() as s:
        node = s.get(Node, node_id)
        if not node:
            raise HTTPException(404, "node not found")
        if node.type != "video":
            raise HTTPException(400, "extract-tail-frame only supports video nodes")
        ndata = dict(node.data or {})
        raw_ids = ndata.get("mediaIds")
        video_mid: Optional[str] = None
        if isinstance(raw_ids, list) and opts.variant_idx < len(raw_ids):
            cand = raw_ids[opts.variant_idx]
            if isinstance(cand, str) and cand.strip():
                video_mid = cand.strip()
        if not video_mid and isinstance(ndata.get("mediaId"), str) and ndata["mediaId"].strip():
            video_mid = ndata["mediaId"].strip()
        if not video_mid:
            raise HTTPException(400, "video node has no rendered mediaId")
        board_id = node.board_id
        node_short = node.short_id
        node_x = node.x
        node_y = node.y
        orig_title = str(ndata.get("title") or "Video").strip()
        orig_aspect = str(ndata.get("aspectRatio") or "VIDEO_ASPECT_RATIO_LANDSCAPE")
        bfp = s.exec(select(BoardFlowProject).where(BoardFlowProject.board_id == board_id)).first()
        board_pid = bfp.flow_project_id if bfp and is_valid_project_id(bfp.flow_project_id) else ""

    mp4_path = media_service.cached_path(video_mid)
    if mp4_path is None:
        fetched = await media_service.fetch_and_cache(video_mid)
        if fetched is not None:
            mp4_path = fetched[2]
    if mp4_path is None or not mp4_path.is_file():
        raise HTTPException(404, f"cached video file not found for mediaId {video_mid}")

    ffmpeg_bin = resolve_ffmpeg()
    if not ffmpeg_bin:
        raise HTTPException(500, "ffmpeg is not installed on the agent host")

    with tempfile.TemporaryDirectory(prefix="fb_tail_") as tmp:
        out_jpg = Path(tmp) / "tail.jpg"
        ok = _extract_last_frame_jpg(ffmpeg_bin, mp4_path, out_jpg)
        if not ok:
            raise HTTPException(500, "ffmpeg failed to extract tail frame from video")
        jpg_bytes = out_jpg.read_bytes()

    target_pid = board_pid or (effective_project_id() or "")
    flow_uploaded = False
    tail_media_id = str(uuid.uuid4())
    if opts.upload_to_flow and flow_client.connected and target_pid and is_valid_project_id(target_pid):
        try:
            b64 = base64.b64encode(jpg_bytes).decode("ascii")
            up = await get_flow_sdk().upload_image(
                b64, "image/jpeg", target_pid, file_name=f"tail_{node_short}.jpg"
            )
            if isinstance(up, dict) and isinstance(up.get("media_id"), str) and up["media_id"]:
                tail_media_id = up["media_id"]
                flow_uploaded = True
        except Exception as exc:  # noqa: BLE001
            logger.warning("extract-tail-frame Flow upload failed, falling back to local id: %s", exc)

    if not media_service.ingest_inline_bytes(tail_media_id, jpg_bytes, kind="image", mime="image/jpeg"):
        raise HTTPException(500, "failed to cache extracted tail frame")

    img_aspect = (
        "IMAGE_ASPECT_RATIO_PORTRAIT"
        if "PORTRAIT" in orig_aspect.upper()
        else "IMAGE_ASPECT_RATIO_LANDSCAPE"
    )
    now_iso = utc_now_iso()

    with get_session() as s:
        new_short = generate_unique_short_id(s, board_id)
        new_node = Node(
            board_id=board_id,
            short_id=new_short,
            type="image",
            x=node_x + 360.0,
            y=node_y,
            w=270.0,
            h=185.0,
            status="done",
            data={
                "title": f"↳ 尾帧接力 · {orig_title}",
                "mediaId": tail_media_id,
                "mediaIds": [tail_media_id],
                "variantCount": 1,
                "aspectRatio": img_aspect,
                "renderedAt": now_iso,
                "derivedFromNodeId": node_id,
            },
        )
        s.add(new_node)
        s.commit()
        s.refresh(new_node)

        new_edge = Edge(
            board_id=board_id,
            source_id=node_id,
            target_id=new_node.id,
            kind="ref",
        )
        s.add(new_edge)
        s.commit()
        s.refresh(new_node)
        s.refresh(new_edge)

        return {
            "node": new_node.model_dump(mode="json"),
            "edge": new_edge.model_dump(mode="json"),
            "media_id": tail_media_id,
            "flow_uploaded": flow_uploaded,
        }
