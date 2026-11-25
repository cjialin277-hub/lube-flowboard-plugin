from __future__ import annotations

import pytest

from flowboard.services import media as media_service
from flowboard.worker.processor import (
    _handle_edit_image,
    _handle_gen_image,
    _handle_gen_video,
    _handle_gen_video_omni,
    _media_provider_of,
)


def test_media_provider_accepts_dry_run():
    assert _media_provider_of({"media_provider": "dry_run"}) == "dry_run"
    assert _media_provider_of({"media_provider": " DRY_RUN "}) == "dry_run"


@pytest.mark.asyncio
async def test_dry_run_pipeline_image_and_video():
    img_res, img_err = await _handle_gen_image(
        {
            "prompt": "Wide establishing shot of a rain-lit courtyard",
            "media_provider": "dry_run",
            "aspect_ratio": "IMAGE_ASPECT_RATIO_LANDSCAPE",
            "variant_count": 2,
            "prompts": [
                "Wide establishing shot of a rain-lit courtyard at dusk",
                "Over-the-shoulder medium shot across the stone table",
            ],
        }
    )
    assert img_err is None
    assert img_res["provider"] == "dry_run"
    mids = img_res["media_ids"]
    assert len(mids) == 2
    for mid in mids:
        p = media_service.cached_path(mid)
        assert p is not None and p.is_file()
        assert p.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"

    # Edit image on variant 0
    edit_res, edit_err = await _handle_edit_image(
        {
            "prompt": "Add warm lantern rim lighting",
            "media_provider": "dry_run",
            "source_media_id": mids[0],
            "aspect_ratio": "IMAGE_ASPECT_RATIO_LANDSCAPE",
        }
    )
    assert edit_err is None
    assert len(edit_res["media_ids"]) == 1

    # Video i2v from variant 0
    vid_res, vid_err = await _handle_gen_video(
        {
            "prompt": "0-3s: Slow dolly-in toward the protagonist. 3-6s: Subtle head turn.",
            "media_provider": "dry_run",
            "start_media_id": mids[0],
            "aspect_ratio": "VIDEO_ASPECT_RATIO_LANDSCAPE",
        }
    )
    assert vid_err is None
    assert vid_res["provider"] == "dry_run"
    vid_id = vid_res["media_ids"][0]
    vp = media_service.cached_path(vid_id)
    assert vp is not None and vp.is_file()
    assert b"ftyp" in vp.read_bytes()[:32]

    # Omni video r2v
    omni_res, omni_err = await _handle_gen_video_omni(
        {
            "prompt": "0-4s: Tracking shot across courtyard.",
            "media_provider": "dry_run",
            "ref_media_ids": [mids[0], mids[1]],
            "duration_s": 4,
            "aspect_ratio": "VIDEO_ASPECT_RATIO_PORTRAIT",
        }
    )
    assert omni_err is None
    assert len(omni_res["media_ids"]) == 1
