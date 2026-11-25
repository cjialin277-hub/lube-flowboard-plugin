"""Auto-prompt route.

`POST /api/prompt/auto { node_id }` returns a Claude-composed prompt built
from the immediate-upstream context (character / visual_asset / image
nodes' aiBriefs). Frontend calls this when the user clicks Generate
without typing a prompt.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from flowboard.services import prompt_synth

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/prompt", tags=["prompt"])


class AutoPromptBody(BaseModel):
    node_id: int
    # Optional video camera mode: defaults to dynamic cinematic scheduling
    # (Dolly-in / Tracking / Rack Focus) when omitted or 'dynamic'; pass
    # 'static' only when explicitly locking the tripod frame.
    camera: Optional[str] = None


class AutoPromptResponse(BaseModel):
    node_id: int
    prompt: str


@router.post("/auto", response_model=AutoPromptResponse)
async def auto_prompt(body: AutoPromptBody) -> AutoPromptResponse:
    try:
        text = await prompt_synth.auto_prompt(body.node_id, camera=body.camera)
    except prompt_synth.PromptSynthError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return AutoPromptResponse(node_id=body.node_id, prompt=text)


class AutoPromptBatchBody(BaseModel):
    node_id: int
    count: int
    camera: Optional[str] = None


class AutoPromptBatchResponse(BaseModel):
    node_id: int
    prompts: list[str]


@router.post("/auto-batch", response_model=AutoPromptBatchResponse)
async def auto_prompt_batch(body: AutoPromptBatchBody) -> AutoPromptBatchResponse:
    """Return N cinematically distinct shot-coverage prompts (varying
    shot scale, blocking, and camera angle) for an N-variant generation."""
    if body.count < 1 or body.count > 8:
        raise HTTPException(status_code=400, detail="count must be 1..8")
    try:
        prompts = await prompt_synth.auto_prompt_batch(
            body.node_id, body.count, camera=body.camera
        )
    except prompt_synth.PromptSynthError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return AutoPromptBatchResponse(node_id=body.node_id, prompts=prompts)


class PolishPromptBody(BaseModel):
    raw_text: str = ""
    mode: str = "video"
    ref_briefs: Optional[list[str]] = None
    duration_s: Optional[int] = None
    camera: Optional[str] = None


class PolishPromptResponse(BaseModel):
    prompt: str
    used_llm: bool


@router.post("/polish", response_model=PolishPromptResponse)
async def polish_prompt_route(body: PolishPromptBody) -> PolishPromptResponse:
    """Rewrite or sanitize a composer draft into clean 2026 Google Flow prose."""
    try:
        prompt, used_llm = await prompt_synth.polish_prompt(
            body.raw_text,
            mode=body.mode,
            ref_briefs=body.ref_briefs,
            duration_s=body.duration_s,
            camera=body.camera,
        )
    except prompt_synth.PromptSynthError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return PolishPromptResponse(prompt=prompt, used_llm=used_llm)
