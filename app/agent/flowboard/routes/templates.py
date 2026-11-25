"""Director storyboard templates & Cornerstone Short-Drama Memory API."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Body, HTTPException
from pydantic import BaseModel

from flowboard.services.director_templates import (
    apply_director_template,
    list_director_templates,
)
from flowboard.services.short_drama_memory import (
    _load_director_lenses_summary,
    get_short_drama_memory_snapshot,
    mount_cole_family_cast_to_board,
)

router = APIRouter(tags=["director-templates"])


class ApplyTemplateBody(BaseModel):
    seq_id: str
    aspect_ratio: Optional[str] = None
    clear_existing: bool = False


class MountCastBody(BaseModel):
    upload_to_flow: bool = True
    roles: Optional[list[str]] = None


@router.get("/api/director-templates")
def get_director_templates():
    items = list_director_templates()
    return {"items": items, "count": len(items)}


@router.get("/api/director-lenses")
def get_director_lenses():
    items = _load_director_lenses_summary(featured_only=False)
    return {"items": items, "count": len(items)}


@router.get("/api/short-drama-memory")
def get_short_drama_memory():
    return get_short_drama_memory_snapshot()


@router.post("/api/boards/{board_id}/mount-short-drama-cast")
async def post_mount_short_drama_cast(
    board_id: int,
    body: MountCastBody = Body(default=MountCastBody()),
):
    try:
        return await mount_cole_family_cast_to_board(
            board_id,
            upload_to_flow=body.upload_to_flow,
            roles=body.roles,
        )
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.post("/api/boards/{board_id}/apply-director-template")
def post_apply_director_template(
    board_id: int,
    body: ApplyTemplateBody = Body(...),
):
    try:
        return apply_director_template(
            board_id,
            body.seq_id,
            aspect_override=body.aspect_ratio,
            clear_existing=body.clear_existing,
        )
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
