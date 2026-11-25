"""Tests for Lube Canvas v2.5 upgrades:
1. First+Last transition video (RPC `nprQif`, dry_run + mock Flow)
2. Tail-frame extraction (`POST /api/nodes/{id}/extract-tail-frame`)
3. Master assembly & Jianying draft export (`POST /api/boards/{id}/assemble-master`)
5. Hourglass SEQ-xxx director templates (`GET /api/director-templates`, `POST /api/boards/{id}/apply-director-template`)
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

from flowboard.request_types import MEDIA_PRODUCING_TYPES
from flowboard.services import flow_batch as fb
from flowboard.services.flow_sdk import FlowSDK
from flowboard.services import media as media_service
from flowboard.worker.processor import (
    _DEFAULT_HANDLERS,
    _handle_gen_image,
    _handle_gen_video,
    _handle_gen_video_first_last,
    _node_completion_patch,
)
from flowboard.db.models import Request
from tests.batch_harness import (
    BatchRecorder,
    batch_envelope,
    decode_freq,
    operation_payload,
)


def test_first_last_type_registered():
    assert "gen_video_first_last" in MEDIA_PRODUCING_TYPES
    assert "gen_video_first_last" in _DEFAULT_HANDLERS
    patch = _node_completion_patch(
        Request(type="gen_video_first_last", params={"media_provider": "flow", "duration_s": 8}),
        {"media_ids": ["vid-123"]},
    )
    assert patch["videoQuality"] == "first_last"
    assert patch["firstLastMode"] is True


@pytest.mark.asyncio
async def test_flow_sdk_gen_video_first_last_builds_nprQif_envelope():
    rec = BatchRecorder(
        responses={
            fb.RPC_GEN_VIDEO_FIRST_LAST: [
                batch_envelope(fb.RPC_GEN_VIDEO_FIRST_LAST, operation_payload("op-fl-123")),
            ]
        }
    )
    sdk = FlowSDK(client=rec)  # type: ignore[arg-type]
    pid = "11111111-1111-1111-1111-111111111111"
    start_id = "22222222-2222-2222-2222-222222222222"
    end_id = "33333333-3333-3333-3333-333333333333"

    out = await sdk.gen_video_first_last(
        prompt="Shadow shifts cleanly into golden sunlight",
        project_id=pid,
        start_media_id=start_id,
        end_media_id=end_id,
        duration_s=8,
        aspect_ratio="VIDEO_ASPECT_RATIO_PORTRAIT",
        paygate_tier="PAYGATE_TIER_TWO",
    )
    assert out.get("error") is None
    assert out["operation_names"] == ["op-fl-123"]
    assert len(rec.calls) == 1
    call = rec.calls[0]
    assert call["rpcid"] == fb.RPC_GEN_VIDEO_FIRST_LAST
    assert call["captcha_action"] == fb.CAPTCHA_VIDEO
    payload = decode_freq(call["freq"])
    req_item = payload[0][0]
    assert req_item[1] == "omni_flash_i2v_8s_first_last"
    assert req_item[4][1] == start_id
    assert req_item[5][1] == end_id


@pytest.mark.asyncio
async def test_dry_run_first_last_and_tail_frame_and_assemble_master(client, tmp_path):
    # 1. Generate 2 dry-run images (Start + End)
    img_res, img_err = await _handle_gen_image(
        {
            "prompt": "Moody overcast desk close-up",
            "media_provider": "dry_run",
            "aspect_ratio": "IMAGE_ASPECT_RATIO_LANDSCAPE",
            "variant_count": 2,
        }
    )
    assert img_err is None
    start_mid, end_mid = img_res["media_ids"]

    # 2. First + Last dry-run transition MP4
    fl_res, fl_err = await _handle_gen_video_first_last(
        {
            "prompt": "Shadow dissolves into golden sunlight",
            "media_provider": "dry_run",
            "start_media_id": start_mid,
            "end_media_id": end_mid,
            "duration_s": 4,
            "aspect_ratio": "VIDEO_ASPECT_RATIO_LANDSCAPE",
        }
    )
    assert fl_err is None
    fl_vid_mid = fl_res["media_ids"][0]
    fl_path = media_service.cached_path(fl_vid_mid)
    assert fl_path is not None and b"ftyp" in fl_path.read_bytes()[:32]

    # 3. Generate a 2nd regular dry-run video clip
    v2_res, v2_err = await _handle_gen_video(
        {
            "prompt": "Slow push toward sunlit table",
            "media_provider": "dry_run",
            "start_media_id": end_mid,
            "aspect_ratio": "VIDEO_ASPECT_RATIO_LANDSCAPE",
        }
    )
    assert v2_err is None
    v2_mid = v2_res["media_ids"][0]

    # 4. Create board with 2 finished video nodes
    b = client.post("/api/boards", json={"name": "Upgrade Test Board"}).json()
    bid = b["id"]
    n1 = client.post(
        "/api/nodes",
        json={
            "board_id": bid,
            "type": "video",
            "x": 800,
            "y": 0,
            "status": "done",
            "data": {
                "title": "S01 首尾帧过渡",
                "mediaId": fl_vid_mid,
                "mediaIds": [fl_vid_mid],
                "aspectRatio": "VIDEO_ASPECT_RATIO_LANDSCAPE",
            },
        },
    ).json()
    client.post(
        "/api/nodes",
        json={
            "board_id": bid,
            "type": "video",
            "x": 800,
            "y": 240,
            "status": "done",
            "data": {
                "title": "S02 收尾推镜",
                "mediaId": v2_mid,
                "mediaIds": [v2_mid],
                "aspectRatio": "VIDEO_ASPECT_RATIO_LANDSCAPE",
            },
        },
    )

    # 5. Upgrade 2: Extract tail frame from n1
    tail_resp = client.post(
        f"/api/nodes/{n1['id']}/extract-tail-frame",
        json={"variant_idx": 0, "upload_to_flow": False},
    )
    assert tail_resp.status_code == 200, tail_resp.text
    tail_data = tail_resp.json()
    assert tail_data["flow_uploaded"] is False
    assert tail_data["node"]["x"] == n1["x"] + 360.0
    assert tail_data["node"]["type"] == "image"
    assert tail_data["node"]["status"] == "done"
    assert tail_data["edge"]["source_id"] == n1["id"]
    assert tail_data["edge"]["target_id"] == tail_data["node"]["id"]
    tail_file = media_service.cached_path(tail_data["media_id"])
    assert tail_file is not None and tail_file.read_bytes()[:2] == b"\xff\xd8"

    # 6. Upgrade 3: Assemble master video + Jianying draft (without touching real Jianying dir)
    asm_resp = client.post(
        f"/api/boards/{bid}/assemble-master",
        json={"export_jianying": True, "copy_to_jianying_dir": False},
    )
    assert asm_resp.status_code == 200, asm_resp.text
    asm = asm_resp.json()
    assert asm["clip_count"] == 2
    assert asm["duration_s"] >= 7.0
    assert asm["width"] == 1920 and asm["height"] == 1080
    assert asm["thumbnail_media_id"] is not None
    assert Path(asm["master_file_path"]).is_file()
    draft_dir = Path(asm["jianying_draft_path"])
    assert (draft_dir / "draft_content.json").is_file()
    assert (draft_dir / "draft_meta_info.json").is_file()
    draft_json = json.loads((draft_dir / "draft_content.json").read_text(encoding="utf-8"))
    assert draft_json["config"]["subtitle_enabled"] is False
    assert draft_json["config"]["voice_gain_db"] == 4.0
    assert len(draft_json["tracks"][0]["segments"]) == 2
    assert draft_json["tracks"][0]["segments"][0]["speed"] == 1.0

    board_after = client.get(f"/api/boards/{bid}").json()
    master_nodes = [x for x in board_after["nodes"] if x["data"].get("isMasterNode") is True]
    assert len(master_nodes) == 1
    assert master_nodes[0]["data"]["mediaId"] == asm["master_media_id"]
    assert master_nodes[0]["data"]["thumbnailMediaId"] == asm["thumbnail_media_id"]


@pytest.mark.asyncio
async def test_extract_tail_frame_uploads_to_flow_when_connected(client, monkeypatch):
    i_res, i_err = await _handle_gen_image(
        {
            "prompt": "Portrait frame",
            "media_provider": "dry_run",
            "aspect_ratio": "IMAGE_ASPECT_RATIO_PORTRAIT",
            "variant_count": 1,
        }
    )
    assert i_err is None
    v_res, v_err = await _handle_gen_video(
        {
            "prompt": "Calm close-up",
            "media_provider": "dry_run",
            "start_media_id": i_res["media_ids"][0],
            "aspect_ratio": "VIDEO_ASPECT_RATIO_PORTRAIT",
        }
    )
    assert v_err is None
    vmid = v_res["media_ids"][0]

    b = client.post("/api/boards", json={"name": "Flow Upload Tail"}).json()
    n = client.post(
        "/api/nodes",
        json={
            "board_id": b["id"],
            "type": "video",
            "x": 100,
            "y": 50,
            "status": "done",
            "data": {"title": "Clip 1", "mediaId": vmid, "aspectRatio": "VIDEO_ASPECT_RATIO_PORTRAIT"},
        },
    ).json()

    from flowboard.services import flow_client as fc_mod
    from flowboard.routes import nodes as nodes_route

    class _FakeSDK:
        async def upload_image(self, image_base64, mime_type, project_id, file_name="upload.png"):
            return {"media_id": str(uuid.UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"))}

    monkeypatch.setattr(fc_mod.flow_client, "_ws", object())
    monkeypatch.setattr(nodes_route, "effective_project_id", lambda: "11111111-1111-1111-1111-111111111111")
    monkeypatch.setattr(nodes_route, "get_flow_sdk", lambda: _FakeSDK())

    resp = client.post(f"/api/nodes/{n['id']}/extract-tail-frame", json={"upload_to_flow": True})
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["flow_uploaded"] is True
    assert payload["media_id"] == "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    assert payload["node"]["data"]["aspectRatio"] == "IMAGE_ASPECT_RATIO_PORTRAIT"


def test_director_templates_list_and_apply_seq0019(client, monkeypatch):
    # Test both built-in fallback and local DB if available
    res_list = client.get("/api/director-templates")
    assert res_list.status_code == 200
    data = res_list.json()
    assert data["count"] >= 3
    seq_ids = {it["seq_id"] for it in data["items"]}
    assert "SEQ-0019" in seq_ids

    b = client.post("/api/boards", json={"name": "Template Board"}).json()
    bid = b["id"]

    # Force built-in fallback path explicitly in one check to verify offline portability
    monkeypatch.setenv("FLOWBOARD_HOURGLASS_DB", "/nonexistent/path/memory.db")
    apply_resp = client.post(
        f"/api/boards/{bid}/apply-director-template",
        json={"seq_id": "SEQ-0019", "clear_existing": True},
    )
    assert apply_resp.status_code == 200, apply_resp.text
    applied = apply_resp.json()
    assert applied["seq_id"] == "SEQ-0019"
    assert applied["step_count"] == 7

    board = client.get(f"/api/boards/{bid}").json()
    fl_videos = [n for n in board["nodes"] if n["type"] == "video" and n["data"].get("firstLastMode") is True]
    assert len(fl_videos) == 1
    fl_vid_id = fl_videos[0]["id"]
    incoming_to_fl = [e for e in board["edges"] if e["target_id"] == fl_vid_id]
    assert len(incoming_to_fl) == 2

    master_nodes = [n for n in board["nodes"] if n["data"].get("isMasterNode") is True]
    assert len(master_nodes) == 1


def test_cancel_node_requests_and_delete_cancels_active(client):
    from flowboard.db import get_session
    from flowboard.db.models import Request

    b = client.post("/api/boards", json={"name": "Cancel Node Board"}).json()
    bid = b["id"]
    n_idle = client.post(
        "/api/nodes",
        json={"board_id": bid, "type": "video", "x": 100, "y": 100, "status": "running", "data": {"title": "Clip A"}},
    ).json()
    n_done = client.post(
        "/api/nodes",
        json={
            "board_id": bid,
            "type": "image",
            "x": 200,
            "y": 100,
            "status": "running",
            "data": {"title": "Frame B", "mediaId": "11111111-1111-1111-1111-111111111111"},
        },
    ).json()

    with get_session() as s:
        r1 = Request(node_id=n_idle["id"], type="gen_video", params={}, status="running")
        r2 = Request(node_id=n_done["id"], type="gen_image", params={}, status="queued")
        s.add_all([r1, r2])
        s.commit()
        s.refresh(r1)
        s.refresh(r2)
        r1_id, r2_id = r1.id, r2.id

    res1 = client.post(f"/api/nodes/{n_idle['id']}/cancel")
    assert res1.status_code == 200, res1.text
    b1 = res1.json()
    assert b1["node_status"] == "idle"
    assert r1_id in b1["canceled_request_ids"]

    # Idempotent repeat cancel returns 200 empty list
    res1_again = client.post(f"/api/nodes/{n_idle['id']}/cancel")
    assert res1_again.status_code == 200
    assert res1_again.json()["canceled_request_ids"] == []

    # Canceling a node with media resets to 'done', then deleting it succeeds cleanly.
    res2 = client.post(f"/api/nodes/{n_done['id']}/cancel")
    assert res2.status_code == 200
    assert res2.json()["node_status"] == "done"
    assert r2_id in res2.json()["canceled_request_ids"]

    del_res = client.delete(f"/api/nodes/{n_done['id']}")
    assert del_res.status_code == 200
    with get_session() as s:
        req2 = s.get(Request, r2_id)
        assert req2 is not None
        assert req2.status == "canceled"
        assert req2.node_id is None


def test_upload_local_only_works_without_flow(client, tmp_path):
    # Minimal 1x1 PNG bytes
    png_bytes = (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x09\x00\x00\x00\x10"
        b"\x08\x06\x00\x00\x00\x00\x00\x00\x00"
    )
    resp = client.post(
        "/api/upload",
        data={"project_id": "", "local_only": "true"},
        files={"file": ("portrait.png", png_bytes, "image/png")},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["media_id"]
    assert data["aspect_ratio"] == "IMAGE_ASPECT_RATIO_PORTRAIT"
    assert media_service.cached_path(data["media_id"]) is not None


def test_sanitize_flow_prompt_and_polish_endpoint(client, monkeypatch):
    from flowboard.services import prompt_synth
    from flowboard.services.llm.base import LLMError

    dirty = "[Kitchen] Warm 3200K lamp — she counts $14,000 in #123456 silence。机位理由：特写。"
    clean = prompt_synth.sanitize_flow_prompt(dirty)
    assert "3200K" not in clean
    assert "warm tungsten light" in clean
    assert "[Kitchen]" not in clean
    assert "—" not in clean
    assert "$" not in clean
    assert "#123456" not in clean
    assert "机位理由" not in clean

    async def fail_llm(*args, **kwargs):
        raise LLMError("no provider configured")

    monkeypatch.setattr(prompt_synth, "run_llm", fail_llm)
    res = client.post(
        "/api/prompt/polish",
        json={"raw_text": "[Scene 1] Mom checks $80 bill under 5600K window—calm gaze", "mode": "video"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["used_llm"] is False
    assert "5600K" not in body["prompt"]
    assert "$" not in body["prompt"]
    assert "—" not in body["prompt"]
    assert "NO SUBTITLES." in body["prompt"]


@pytest.mark.asyncio
async def test_auto_prompt_supports_named_camera_moves(client, monkeypatch):
    from flowboard.db import get_session
    from flowboard.db.models import Board, Edge, Node
    from flowboard.services import prompt_synth

    with get_session() as s:
        b = Board(name="cam-test")
        s.add(b)
        s.commit()
        s.refresh(b)
        src = Node(
            board_id=b.id,
            short_id="cams",
            type="image",
            x=0,
            y=0,
            w=240,
            h=180,
            data={"title": "Source", "aiBrief": "mother standing frame-left facing right", "mediaId": "uuuuuuuu-0000-0000-0000-000000000001"},
            status="done",
        )
        vid = Node(board_id=b.id, short_id="camv", type="video", x=0, y=0, w=240, h=180, data={"title": "Vid"}, status="idle")
        s.add_all([src, vid])
        s.commit()
        s.refresh(src)
        s.refresh(vid)
        s.add(Edge(board_id=b.id, source_id=src.id, target_id=vid.id))
        s.commit()
        vid_id = vid.id

    captured = {}

    async def stub_run(feature, prompt, *, system_prompt=None, timeout=0):
        captured["system_prompt"] = system_prompt
        return "Slow dolly push-in as she lowers her hand gently."

    monkeypatch.setattr(prompt_synth, "run_llm", stub_run)
    await prompt_synth.auto_prompt(vid_id, camera="ots")
    sp = captured["system_prompt"] or ""
    assert "M11 OVER-THE-SHOULDER OTS" in sp
    await prompt_synth.auto_prompt(vid_id, camera="dolly_in")
    assert "M01 DOLLY-IN" in (captured["system_prompt"] or "")
