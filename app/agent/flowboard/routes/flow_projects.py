"""One-way sync: ensure each Flowboard board has a live Flow project.

This is a LOCAL → FLOW direction sync. We do NOT import Flow's project
list into Flowboard's UI. The flow:

  GET  /api/flow/projects  → per-board sync status (does this board's
                              flow_project_id still exist on Flow?)
  POST /api/flow/projects/sync-up → for every board whose flow_project_id
                                     is missing on Flow (or no binding
                                     at all), CREATE a new Flow project
                                     and update BoardFlowProject so the
                                     dashboard's projects exist on Flow's
                                     side too. Idempotent: boards that
                                     already exist on Flow are left
                                     untouched.

The Flow project list used to be fetched internally (via the labs.google
TRPC search endpoint) just to diff against local binds.

SINCE THE SEPTEMBER 2026 MIGRATION BOTH HALVES OF THAT ARE GONE. Flow has no
batchexecute RPC for listing a user's projects, and none for creating one, so:

  * ``GET`` still reports every board's binding, but ``exists_on_flow`` is
    ``null`` (unknown) rather than ``false`` — claiming a project is missing
    when we simply cannot look is worse than admitting we cannot look.
  * ``POST /sync-up`` refuses with 501. It could technically "succeed" by
    binding every board to the one pinned Flow project, but that would record
    a shared workspace as if each board owned it.

Generation does not depend on any of this: a board with no binding falls back
to the pinned project. See flow_sdk.search_user_projects.

Which project that is used to be settable only in ``.env``. It is now settable
at runtime through ``GET``/``PUT /api/flow/projects/pinned`` and resolved
everywhere via ``flow_project.effective_project_id`` — the routes below
included, because a status endpoint that reported the env value while
generation used an override would be worse than not reporting one at all.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from flowboard.db import get_session
from flowboard.db.models import Board, BoardFlowProject
from flowboard.services.flow_project import (
    effective_project_id,
    project_setting,
    set_override,
)
from flowboard.services.flow_sdk import get_flow_sdk, is_valid_project_id

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/flow/projects", tags=["flow-projects"])


async def _remote_project_ids(tool: str) -> tuple[set[str], Optional[str]]:
    """Try to pull the user's Flow project id set.

    Returns ``(ids, unavailable_reason)``. On the current transport the reason
    is always set, because Flow exposes no project-listing RPC — but this is
    written as a probe rather than a hardcoded refusal so that capturing one
    later is a change in ``flow_sdk``, not here.
    """
    result = await get_flow_sdk().list_user_projects_all(tool=tool)
    if result.get("error"):
        return set(), str(result["error"])
    projects = result.get("projects") or []
    ids = {
        p["project_id"] for p in projects
        if isinstance(p, dict) and p.get("project_id")
    }
    return ids, None


@router.get("")
async def get_sync_status(tool: str = "PINHOLE"):
    """Per-board sync status. Does NOT expose the Flow project list —
    this is a one-way sync (local → Flow), so the frontend only needs
    to know which boards are still synced.

    Response:
        {
          "board_status": [
            {board_id, board_name, flow_project_id, exists_on_flow},
            ...
          ],
          "flow_listing": {"available": bool, "reason": str|null,
                           "pinned_project_id": str|null}
        }

    ``exists_on_flow`` is ``null`` when Flow's project list could not be read
    — which is every time on the current transport. The bindings themselves
    are still real and worth showing, so this degrades rather than 502s.
    """
    remote_ids, unavailable = await _remote_project_ids(tool)
    with get_session() as s:
        boards = s.query(Board).order_by(Board.created_at.desc()).all()
        binds = {
            b.board_id: b.flow_project_id
            for b in s.query(BoardFlowProject).all()
        }
        board_status = []
        for b in boards:
            pid: Optional[str] = binds.get(b.id)
            if unavailable:
                exists = None
            elif pid:
                exists = pid in remote_ids
            else:
                exists = False
            board_status.append({
                "board_id": b.id,
                "board_name": b.name,
                "flow_project_id": pid,
                "exists_on_flow": exists,
            })
    return {
        "board_status": board_status,
        "flow_listing": {
            "available": unavailable is None,
            "reason": unavailable,
            "pinned_project_id": effective_project_id() or None,
        },
    }


class PinnedProjectUpdate(BaseModel):
    """Body of ``PUT /pinned``. An explicit ``null`` (or ``""``) clears it.

    The field is REQUIRED on purpose. With a default, an omitted field and an
    explicit ``null`` were indistinguishable, so ``PUT {}`` — a truncated or
    mangled body, or a client that forgot the payload — silently destroyed the
    override and rebound every board. Clearing the pin is a destructive act and
    has to be asked for by name; omission is now a 422.
    """
    flow_project_id: Optional[str] = Field(..., max_length=512)


@router.get("/pinned")
def get_pinned_project():
    """The Flow project everything generates into, and where it came from.

    Deliberately on ``/pinned`` under the existing plural prefix rather than a
    new top-level ``/api/flow/project``: one character between two live routes
    is a trap, and this genuinely is a property of the project collection.

    Response: ``{"flow_project_id": str|null, "source": "override"|"env"|"none",
    "env_project_id": str|null}``.
    """
    return project_setting()


@router.put("/pinned")
def set_pinned_project(body: PinnedProjectUpdate):
    """Pin a Flow project at runtime, or clear the pin back to ``.env``.

    Answers the same shape as ``GET`` plus ``rebound_boards`` — how many
    boards were moved off the previous effective project onto this one. That
    count is not decoration: boards persist their own binding, so a change
    here that did not move them would leave them generating into the old
    project. See ``flow_project._rebind_boards`` for which rows move.

    A malformed id is a 400 whose ``detail`` says how to find the right value,
    and nothing is written.
    """
    try:
        rebound = set_override(body.flow_project_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {**project_setting(), "rebound_boards": rebound}


class MidjourneyConfigUpdate(BaseModel):
    api_base: Optional[str] = Field(default=None, max_length=512)
    api_key: Optional[str] = Field(default=None, max_length=512)
    version: Optional[str] = Field(default=None, max_length=16)


@router.get("/midjourney")
def get_midjourney_config():
    """Return effective Midjourney gateway configuration."""
    from flowboard.services.midjourney_media import get_mj_settings

    cfg = get_mj_settings()
    cfg.pop("_raw_key", None)
    return cfg


@router.put("/midjourney")
def update_midjourney_config(body: MidjourneyConfigUpdate):
    """Update Midjourney gateway API base / key / version at runtime."""
    from flowboard.services.midjourney_media import set_mj_settings

    return set_mj_settings(
        api_base=body.api_base,
        api_key=body.api_key,
        version=body.version,
    )


@router.get("/multimodal-status")
async def get_multimodal_status():
    """Live tri-engine status for Google Flow, Midjourney (web + gateway), and Meta Muse."""
    from flowboard.services import muse2api, worker_presence
    from flowboard.services.flow_client import flow_client
    from flowboard.services.midjourney_media import get_mj_settings

    tabs_data: dict = {}
    if flow_client.connected:
        res = await flow_client.ext_call("get_multimodal_tabs", {}, timeout=8.0)
        if isinstance(res, dict) and isinstance(res.get("data"), dict):
            tabs_data = res["data"]

    mj_cfg = get_mj_settings()
    mj_cfg.pop("_raw_key", None)
    mj_tab = tabs_data.get("midjourney") or {}
    muse_tab = tabs_data.get("muse") or {}
    flow_tab = tabs_data.get("flow") or {}
    muse_gw_ready = await muse2api.is_ready() if muse2api.is_configured() else False
    muse_worker_ok = worker_presence.any_recent("muse")

    # Cross-profile fallback: if Midjourney or Muse is open in another Chrome profile window
    if not mj_tab.get("connected"):
        from flowboard.services.midjourney_media import probe_macos_chrome_mj_tab

        macos_mj = await asyncio.to_thread(probe_macos_chrome_mj_tab)
        if macos_mj.get("connected"):
            mj_tab = macos_mj

    if not muse_tab.get("connected"):
        from flowboard.services.midjourney_media import probe_macos_chrome_muse_tab

        macos_muse = await asyncio.to_thread(probe_macos_chrome_muse_tab)
        if macos_muse.get("connected"):
            muse_tab = macos_muse

    return {
        "extension_connected": flow_client.connected,
        "flow": {
            "pinned_project_id": effective_project_id() or None,
            "tab_connected": bool(flow_tab.get("connected")),
            "tab_url": flow_tab.get("url") or "",
            "tab_count": flow_tab.get("tabCount") or 0,
        },
        "midjourney": {
            **mj_cfg,
            "tab_connected": bool(mj_tab.get("connected")),
            "tab_url": mj_tab.get("url") or "",
            "folder": mj_tab.get("folder") or "",
            "has_input_bar": bool(mj_tab.get("hasInputBar")),
            "visible_image_count": int(mj_tab.get("visibleImageCount") or 0),
        },
        "muse": {
            "tab_connected": bool(muse_tab.get("connected")),
            "tab_url": muse_tab.get("url") or "",
            "tab_ready": bool(muse_tab.get("ready")),
            "login_required": bool(muse_tab.get("loginRequired")),
            "muse2api_configured": muse2api.is_configured(),
            "muse2api_ready": muse_gw_ready,
            "pax_worker_online": muse_worker_ok,
            "copilot_fallback_active": flow_client.connected,
        },
    }


class OpenMultimodalTabBody(BaseModel):
    target: str = Field(..., description="midjourney | muse")
    url: Optional[str] = None
    focus: bool = True


@router.post("/multimodal-open-tab")
async def open_multimodal_tab(body: OpenMultimodalTabBody):
    """Ask the Chrome extension to open or focus a Midjourney or Meta Muse tab."""
    from flowboard.services.flow_client import flow_client

    if not flow_client.connected:
        raise HTTPException(status_code=503, detail="Chrome extension is not connected")
    res = await flow_client.ext_call(
        "open_external_tab",
        {"target": body.target, "url": body.url, "focus": body.focus},
        timeout=10.0,
    )
    if not isinstance(res, dict) or res.get("error"):
        raise HTTPException(
            status_code=502,
            detail=(res.get("error") if isinstance(res, dict) else "open_tab_failed"),
        )
    return res.get("data") or {"ok": True}


@router.get("/midjourney/browser-assets")
async def get_midjourney_browser_assets(limit: int = 40):
    """List images currently visible in the user's open www.midjourney.com tab."""
    from flowboard.services.midjourney_media import list_browser_mj_assets

    return await list_browser_mj_assets(limit=limit)


class ImportMjBrowserAssetBody(BaseModel):
    full_url: str
    thumb_url: Optional[str] = ""
    job_id: Optional[str] = ""
    variant_idx: int = 0
    title: Optional[str] = None
    aspect_ratio: Optional[str] = "IMAGE_ASPECT_RATIO_LANDSCAPE"


@router.post("/midjourney/import-browser-asset")
async def import_midjourney_browser_asset(body: ImportMjBrowserAssetBody):
    """Download a full-resolution JPEG from cdn.midjourney.com inside the user's
    signed-in Midjourney tab and ingest it into Flowboard's local media cache.
    """
    from flowboard.services.midjourney_media import import_browser_mj_asset

    try:
        mid, mime, size = await import_browser_mj_asset(
            full_url=body.full_url,
            thumb_url=body.thumb_url or "",
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return {
        "media_id": mid,
        "url": f"/media/{mid}",
        "mime": mime,
        "size": size,
        "job_id": body.job_id or "",
        "variant_idx": body.variant_idx,
        "title": body.title or f"MJ #{body.job_id[:8] if body.job_id else mid[:8]} v{body.variant_idx + 1}",
        "aspect_ratio": body.aspect_ratio or "IMAGE_ASPECT_RATIO_LANDSCAPE",
    }


@router.post("/sync-up")
async def sync_up(tool: str = "PINHOLE"):
    """Push every orphan board up to Flow. For each board where the
    bound flow_project_id is missing from Flow's remote list (or no
    binding exists at all), create a new Flow project and replace the
    BoardFlowProject row.

    Idempotent: boards already in sync are skipped. Returns a per-board
    action log so the UI can summarise ("synced N boards").

    Answers 501 while Flow exposes no way to create a project. It is important
    that this refuses instead of degrading: ``create_project`` now hands back
    the single pinned project, so "succeeding" here would write that same uuid
    into every board's binding and record a shared Flow workspace as if each
    board owned one.
    """
    remote_ids, unavailable = await _remote_project_ids(tool)
    if unavailable:
        raise HTTPException(
            status_code=501,
            detail={
                "message": (
                    "Flow no longer exposes project creation or listing, so "
                    "boards cannot be pushed up individually."
                ),
                "reason": unavailable,
                "fix": (
                    "Create one project in the Flow UI and pin its uuid — in "
                    "Settings, or as FLOWBOARD_FLOW_PROJECT_ID. Boards with no "
                    "binding use it automatically, so generation keeps working."
                ),
                "pinned_project_id": effective_project_id() or None,
            },
        )

    # Snapshot the boards that need work. Read-only pass to avoid
    # holding the session during the TRPC round-trips below.
    with get_session() as s:
        boards = s.query(Board).all()
        binds = {
            b.board_id: b.flow_project_id
            for b in s.query(BoardFlowProject).all()
        }
        to_sync = [
            (b.id, b.name, binds.get(b.id))
            for b in boards
            if binds.get(b.id) is None or binds.get(b.id) not in remote_ids
        ]

    actions: list[dict] = []
    sdk = get_flow_sdk()

    for board_id, board_name, old_pid in to_sync:
        resp = await sdk.create_project(title=board_name or "Untitled")
        if resp.get("error"):
            actions.append({
                "board_id": board_id,
                "board_name": board_name,
                "old_flow_project_id": old_pid,
                "new_flow_project_id": None,
                "status": "failed",
                "error": str(resp["error"])[:200],
            })
            continue
        new_pid = resp.get("project_id")
        if not isinstance(new_pid, str) or not is_valid_project_id(new_pid):
            actions.append({
                "board_id": board_id,
                "board_name": board_name,
                "old_flow_project_id": old_pid,
                "new_flow_project_id": None,
                "status": "failed",
                "error": "invalid project_id from Flow",
            })
            continue

        with get_session() as s:
            row = s.get(BoardFlowProject, board_id)
            if row is None:
                row = BoardFlowProject(
                    board_id=board_id, flow_project_id=new_pid
                )
            else:
                row.flow_project_id = new_pid
            s.add(row)
            s.commit()
        logger.info(
            "sync-up: board %s %s → new flow_project %s",
            board_id,
            f"(was {old_pid})" if old_pid else "(no prior bind)",
            new_pid,
        )
        actions.append({
            "board_id": board_id,
            "board_name": board_name,
            "old_flow_project_id": old_pid,
            "new_flow_project_id": new_pid,
            "status": "rebound" if old_pid else "created",
            "error": None,
        })

    return {
        "synced": [a for a in actions if a["status"] in ("created", "rebound")],
        "failed": [a for a in actions if a["status"] == "failed"],
        "total_boards": len(to_sync) + (
            # boards that were already synced
            len([1 for b in (binds.values()) if isinstance(b, str) and b in remote_ids])
        ),
    }
