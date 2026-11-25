"""One-click board master assembly & Jianying Pro / CapCut draft exporter.

Collects all completed raw video shot nodes on a board in story order,
normalises each shot at native 1.0x frame rate (no static-frame tpad clones,
no slow-motion), boosts speech by +4 dB with limiter, mixes instrumental BGM
from 0.0s with sidechain ducking, emits zero subtitles, writes a Jianying Pro
draft folder, and updates/creates the rightmost Master Video node on the board.
"""
from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from sqlmodel import select

from flowboard import config
from flowboard.db import get_session
from flowboard.db.models import Board, Edge, Node
from flowboard.services import media as media_service
from flowboard.services.dry_run_media import resolve_ffmpeg
from flowboard.short_id import generate_unique_short_id
from flowboard.timestamps import utc_now_iso

logger = logging.getLogger(__name__)

_DEFAULT_BGM_CANDIDATES: tuple[Path, ...] = (
    Path.home() / "Desktop" / "短剧" / "BGM_FlowMusic" / "Classic_BGM.mp3",
    Path.home() / "studio-workspace" / "scripts" / "audio_assets" / "BGM.mp3",
    Path.home() / "flowboard" / "sample_FireCatKnight_EP01" / "FireCatKnight_EP01_BGM_epic_fairy_tale.mp3",
    Path.home() / "Documents" / "情感视频" / "BGM.mp3",
)

_DEFAULT_JIANYING_ROOT = (
    Path.home() / "Movies" / "JianyingPro" / "User Data" / "Projects" / "com.lveditor.draft"
)


def _probe_media_ffmpeg(ffmpeg_bin: str, path: Path) -> tuple[float, bool]:
    """Read (duration_sec, has_audio) via `ffmpeg -i` stderr without ffprobe."""
    proc = subprocess.run(
        [ffmpeg_bin, "-hide_banner", "-i", str(path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    info = proc.stderr or ""
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", info)
    dur = (
        int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
        if m
        else 8.0
    )
    return max(0.2, dur), ("Audio:" in info)


def _resolve_bgm(explicit_bgm: Optional[str]) -> Optional[Path]:
    if explicit_bgm:
        cand = Path(explicit_bgm).expanduser()
        if cand.is_file():
            return cand
    for cand in _DEFAULT_BGM_CANDIDATES:
        if cand.is_file():
            return cand
    return None


def _is_master_node(node: Node, incoming_edges: dict[int, list[Edge]], nodes_by_id: dict[int, Node]) -> bool:
    ndata = node.data or {}
    if ndata.get("isMasterNode") is True:
        return True
    title = str(ndata.get("title") or "")
    inc = incoming_edges.get(node.id, [])
    if inc and all((nodes_by_id.get(e.source_id) and nodes_by_id[e.source_id].type == "video") for e in inc):
        return True
    return ("总成片" in title or "Master" in title) and bool(inc)


def _build_jianying_draft(
    *,
    draft_dir: Path,
    draft_name: str,
    width: int,
    height: int,
    clips: list[dict[str, Any]],
    bgm_path: Optional[Path],
    total_dur_s: float,
) -> dict[str, Any]:
    """Write a standard Jianying Pro / CapCut draft folder (1.0x raw clips, +4dB, 0 subtitles)."""
    draft_dir.mkdir(parents=True, exist_ok=True)
    draft_id = str(uuid.uuid4()).upper()
    total_us = int(round(total_dur_s * 1_000_000))
    voice_linear_gain = 1.5849  # +4.0 dB

    video_materials: list[dict[str, Any]] = []
    video_segments: list[dict[str, Any]] = []
    cursor_us = 0

    for idx, clip in enumerate(clips):
        dur_us = int(round(clip["duration_s"] * 1_000_000))
        mat_id = str(uuid.uuid4()).upper()
        seg_id = str(uuid.uuid4()).upper()
        raw_path = str(clip["raw_path"])
        video_materials.append(
            {
                "id": mat_id,
                "path": raw_path,
                "material_name": Path(raw_path).name,
                "type": "video",
                "duration": dur_us,
                "width": width,
                "height": height,
                "has_audio": clip["has_audio"],
            }
        )
        video_segments.append(
            {
                "id": seg_id,
                "material_id": mat_id,
                "render_index": idx,
                "speed": 1.0,
                "volume": voice_linear_gain,
                "source_timerange": {"start": 0, "duration": dur_us},
                "target_timerange": {"start": cursor_us, "duration": dur_us},
                "extra_material_refs": [],
            }
        )
        cursor_us += dur_us

    audio_materials: list[dict[str, Any]] = []
    tracks: list[dict[str, Any]] = [
        {
            "id": str(uuid.uuid4()).upper(),
            "type": "video",
            "attribute": 0,
            "flag": 0,
            "segments": video_segments,
        }
    ]

    if bgm_path is not None and bgm_path.is_file():
        bgm_mat_id = str(uuid.uuid4()).upper()
        bgm_seg_id = str(uuid.uuid4()).upper()
        audio_materials.append(
            {
                "id": bgm_mat_id,
                "path": str(bgm_path),
                "name": bgm_path.name,
                "type": "music",
                "duration": total_us,
            }
        )
        tracks.append(
            {
                "id": str(uuid.uuid4()).upper(),
                "type": "audio",
                "attribute": 0,
                "flag": 0,
                "segments": [
                    {
                        "id": bgm_seg_id,
                        "material_id": bgm_mat_id,
                        "speed": 1.0,
                        "volume": 0.35,
                        "source_timerange": {"start": 0, "duration": total_us},
                        "target_timerange": {"start": 0, "duration": total_us},
                        "extra_material_refs": [],
                    }
                ],
            }
        )

    content = {
        "id": draft_id,
        "name": draft_name,
        "version": 360000,
        "duration": total_us,
        "fps": 24.0,
        "canvas_config": {
            "width": width,
            "height": height,
            "ratio": "9:16" if height > width else "16:9",
        },
        "materials": {
            "videos": video_materials,
            "audios": audio_materials,
            "texts": [],
            "speeds": [],
        },
        "tracks": tracks,
        "config": {
            "subtitle_enabled": False,
            "voice_gain_db": 4.0,
            "bgm_ducking": True,
        },
    }

    now_ts = int(datetime.now(timezone.utc).timestamp() * 1_000_000)
    meta = {
        "draft_id": draft_id,
        "draft_name": draft_name,
        "draft_fold_path": str(draft_dir),
        "tm_draft_create": now_ts,
        "tm_draft_modified": now_ts,
        "tm_duration": total_us,
        "draft_removable_storage_device": "",
    }

    (draft_dir / "draft_content.json").write_text(
        json.dumps(content, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (draft_dir / "draft_info.json").write_text(
        json.dumps(content, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (draft_dir / "draft_meta_info.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return content


def assemble_board_master(
    board_id: int,
    *,
    export_jianying: bool = True,
    copy_to_jianying_dir: bool = True,
    jianying_draft_root: Optional[Path] = None,
    bgm_path: Optional[str] = None,
) -> dict[str, Any]:
    """Assemble all completed video shots on a board into a 24fps zero-subtitle master MP4."""
    ffmpeg_bin = resolve_ffmpeg()
    if not ffmpeg_bin:
        raise RuntimeError("ffmpeg is not installed on the agent host")

    with get_session() as s:
        board = s.get(Board, board_id)
        if not board:
            raise LookupError("board not found")
        board_name = board.name
        nodes = s.exec(select(Node).where(Node.board_id == board_id)).all()
        edges = s.exec(select(Edge).where(Edge.board_id == board_id)).all()

    nodes_by_id = {n.id: n for n in nodes if n.id is not None}
    incoming_edges: dict[int, list[Edge]] = {}
    for e in edges:
        incoming_edges.setdefault(e.target_id, []).append(e)

    existing_master: Optional[Node] = None
    shot_candidates: list[Node] = []
    for n in nodes:
        if n.type != "video":
            continue
        if _is_master_node(n, incoming_edges, nodes_by_id):
            existing_master = n
            continue
        if n.status != "done":
            continue
        ndata = n.data or {}
        mid = ndata.get("mediaId")
        if not (isinstance(mid, str) and mid.strip()):
            raw_ids = ndata.get("mediaIds") or []
            mid = next((m for m in raw_ids if isinstance(m, str) and m.strip()), None)
        if not mid:
            continue
        p = media_service.cached_path(mid)
        if p is not None and p.is_file():
            shot_candidates.append(n)

    if not shot_candidates:
        raise ValueError("画布上暂无已完成且本地有缓存的视频分镜，无法合成总成片")

    # Sort top-to-bottom by canvas rows (~80px row band), then left-to-right.
    shot_candidates.sort(key=lambda n: (round(n.y / 80.0), n.x, n.id or 0))

    first_aspect = str((shot_candidates[0].data or {}).get("aspectRatio") or "")
    is_portrait = "PORTRAIT" in first_aspect.upper()
    out_w, out_h = (1080, 1920) if is_portrait else (1920, 1080)
    vid_aspect = "VIDEO_ASPECT_RATIO_PORTRAIT" if is_portrait else "VIDEO_ASPECT_RATIO_LANDSCAPE"

    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    export_dir = config.STORAGE_DIR / "exports" / f"board_{board_id}_{ts}"
    export_dir.mkdir(parents=True, exist_ok=True)
    master_out_path = export_dir / "成片_无字幕版.mp4"

    resolved_bgm = _resolve_bgm(bgm_path)
    clip_records: list[dict[str, Any]] = []

    with tempfile.TemporaryDirectory(prefix="fb_assemble_") as tmp:
        tmp_dir = Path(tmp)
        concat_list = tmp_dir / "concat.txt"
        concat_lines: list[str] = []

        clip_idx = 0
        for sn in shot_candidates:
            ndata = sn.data or {}
            raw_ids = [
                str(m).strip()
                for m in (ndata.get("mediaIds") or [])
                if isinstance(m, str) and str(m).strip()
            ]
            if not raw_ids:
                single_mid = str(ndata.get("mediaId") or "").strip()
                if single_mid:
                    raw_ids = [single_mid]
            # Deduplicate while preserving order within a multi-shot video card
            seen_in_node: set[str] = set()
            node_mids: list[str] = []
            for m in raw_ids:
                if m not in seen_in_node and media_service.cached_path(m) is not None:
                    seen_in_node.add(m)
                    node_mids.append(m)

            for mid in node_mids:
                clip_idx += 1
                src_path = media_service.cached_path(mid)
                assert src_path is not None
                dur_s, has_audio = _probe_media_ffmpeg(ffmpeg_bin, src_path)
                norm_path = tmp_dir / f"norm_{clip_idx:03d}.mp4"

                vf = (
                    f"scale={out_w}:{out_h}:force_original_aspect_ratio=decrease,"
                    f"pad={out_w}:{out_h}:(ow-iw)/2:(oh-ih)/2,fps=24,format=yuv420p"
                )
                if has_audio:
                    cmd = [
                        ffmpeg_bin, "-y", "-hide_banner", "-loglevel", "error",
                        "-i", str(src_path),
                        "-vf", vf,
                        "-af", "aresample=44100,aformat=channel_layouts=stereo",
                        "-c:v", "libx264", "-preset", "fast", "-crf", "18",
                        "-c:a", "aac", "-b:a", "192k",
                        str(norm_path),
                    ]
                else:
                    cmd = [
                        ffmpeg_bin, "-y", "-hide_banner", "-loglevel", "error",
                        "-i", str(src_path),
                        "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
                        "-shortest",
                        "-vf", vf,
                        "-c:v", "libx264", "-preset", "fast", "-crf", "18",
                        "-c:a", "aac", "-b:a", "192k",
                        str(norm_path),
                    ]
                proc = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=False)
                if proc.returncode != 0 or not norm_path.is_file():
                    err_tail = (proc.stderr or b"").decode("utf-8", "replace")[-300:]
                    raise RuntimeError(f"ffmpeg normalise failed on clip #{clip_idx}: {err_tail}")

                norm_dur_s, _ = _probe_media_ffmpeg(ffmpeg_bin, norm_path)
                concat_lines.append(f"file '{str(norm_path).replace(chr(39), chr(39) + chr(92) + chr(39))}'")
                clip_records.append(
                    {
                        "node_id": sn.id,
                        "short_id": sn.short_id,
                        "raw_path": src_path,
                        "duration_s": norm_dur_s,
                        "has_audio": has_audio,
                    }
                )

        concat_list.write_text("\n".join(concat_lines) + "\n", encoding="utf-8")
        voice_concat = tmp_dir / "voice_concat.mp4"
        proc_cat = subprocess.run(
            [
                ffmpeg_bin, "-y", "-hide_banner", "-loglevel", "error",
                "-f", "concat", "-safe", "0", "-i", str(concat_list),
                "-c", "copy",
                str(voice_concat),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            check=False,
        )
        if proc_cat.returncode != 0 or not voice_concat.is_file():
            err_tail = (proc_cat.stderr or b"").decode("utf-8", "replace")[-300:]
            raise RuntimeError(f"ffmpeg concat failed: {err_tail}")

        total_dur_s, _ = _probe_media_ffmpeg(ffmpeg_bin, voice_concat)

        if resolved_bgm is not None:
            fade_d = min(1.5, max(0.3, total_dur_s * 0.15))
            fade_start = max(0.0, total_dur_s - fade_d)
            fc = (
                f"[0:a]volume=4dB,alimiter=limit=0.89,asplit=2[voice_main][voice_sc];"
                f"[1:a]aresample=44100,aformat=channel_layouts=stereo,"
                f"atrim=0:{total_dur_s:.3f},asetpts=PTS-STARTPTS,"
                f"volume=0.35,afade=t=out:st={fade_start:.3f}:d={fade_d:.3f}[bgm];"
                f"[bgm][voice_sc]sidechaincompress=threshold=0.04:ratio=4:attack=30:release=350[bgm_duck];"
                f"[voice_main][bgm_duck]amix=inputs=2:duration=first:dropout_transition=2:normalize=0,"
                f"alimiter=limit=0.92[aout]"
            )
            mix_cmd = [
                ffmpeg_bin, "-y", "-hide_banner", "-loglevel", "error",
                "-i", str(voice_concat),
                "-stream_loop", "-1", "-i", str(resolved_bgm),
                "-filter_complex", fc,
                "-map", "0:v", "-map", "[aout]",
                "-c:v", "copy",
                "-c:a", "aac", "-b:a", "192k",
                "-shortest", "-movflags", "+faststart",
                str(master_out_path),
            ]
        else:
            mix_cmd = [
                ffmpeg_bin, "-y", "-hide_banner", "-loglevel", "error",
                "-i", str(voice_concat),
                "-c:v", "copy",
                "-af", "volume=4dB,alimiter=limit=0.89",
                "-c:a", "aac", "-b:a", "192k",
                "-movflags", "+faststart",
                str(master_out_path),
            ]

        proc_mix = subprocess.run(mix_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=False)
        if proc_mix.returncode != 0 or not master_out_path.is_file():
            err_tail = (proc_mix.stderr or b"").decode("utf-8", "replace")[-300:]
            raise RuntimeError(f"ffmpeg mix failed: {err_tail}")

        # Extract a clean cover frame around 50% of the master video so the
        # master card always has an instant high-res thumbnail on canvas load.
        thumb_jpg = tmp_dir / "master_cover.jpg"
        seek_s = max(0.1, min(total_dur_s * 0.5, max(0.1, total_dur_s - 0.2)))
        thumb_bytes: Optional[bytes] = None
        proc_thumb = subprocess.run(
            [
                ffmpeg_bin, "-y", "-hide_banner", "-loglevel", "error",
                "-ss", f"{seek_s:.2f}", "-i", str(master_out_path),
                "-frames:v", "1", "-q:v", "2",
                str(thumb_jpg),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            check=False,
        )
        if proc_thumb.returncode == 0 and thumb_jpg.is_file() and thumb_jpg.stat().st_size > 0:
            thumb_bytes = thumb_jpg.read_bytes()

    master_mid = str(uuid.uuid4())
    if not media_service.ingest_inline_bytes(
        master_mid, master_out_path.read_bytes(), kind="video", mime="video/mp4"
    ):
        raise RuntimeError("failed to ingest master video into media cache")

    thumb_mid: Optional[str] = None
    if thumb_bytes:
        cand_thumb = str(uuid.uuid4())
        if media_service.ingest_inline_bytes(
            cand_thumb, thumb_bytes, kind="image", mime="image/jpeg"
        ):
            thumb_mid = cand_thumb

    jianying_draft_dir: Optional[Path] = None
    jianying_installed_path: Optional[Path] = None
    if export_jianying:
        safe_name = re.sub(r'[\\/:*?"<>|\s]+', "_", board_name).strip("_") or f"Board_{board_id}"
        draft_folder_name = f"Flowboard_{safe_name}_{ts}"
        jianying_draft_dir = export_dir / "jianying_draft" / draft_folder_name
        _build_jianying_draft(
            draft_dir=jianying_draft_dir,
            draft_name=draft_folder_name,
            width=out_w,
            height=out_h,
            clips=clip_records,
            bgm_path=resolved_bgm,
            total_dur_s=total_dur_s,
        )
        root_dir = jianying_draft_root if jianying_draft_root is not None else _DEFAULT_JIANYING_ROOT
        if copy_to_jianying_dir and root_dir.is_dir():
            dest = root_dir / draft_folder_name
            shutil.copytree(jianying_draft_dir, dest, dirs_exist_ok=True)
            jianying_installed_path = dest

    now_iso = utc_now_iso()
    avg_y = sum(n.y for n in shot_candidates) / len(shot_candidates)
    max_x = max(n.x for n in shot_candidates)
    master_title = f"🎬 完整短片总成片（{len(clip_records)}镜 · {total_dur_s:.1f}s 无字幕）"

    with get_session() as s:
        if existing_master is not None:
            master = s.get(Node, existing_master.id)
            assert master is not None
            merged = dict(master.data or {})
            merged.update(
                {
                    "title": master_title,
                    "mediaId": master_mid,
                    "mediaIds": [master_mid],
                    "variantCount": 1,
                    "aspectRatio": vid_aspect,
                    "renderedAt": now_iso,
                    "isMasterNode": True,
                    "mediaProvider": "master_assemble",
                    "error": None,
                }
            )
            if thumb_mid:
                merged["thumbnailMediaId"] = thumb_mid
            merged.pop("error", None)
            master.data = merged
            master.status = "done"
            s.add(master)
            s.commit()
            s.refresh(master)
        else:
            master = Node(
                board_id=board_id,
                short_id=generate_unique_short_id(s, board_id),
                type="video",
                x=max_x + 440.0,
                y=round(avg_y, 1),
                w=320.0,
                h=225.0,
                status="done",
                data={
                    "title": master_title,
                    "prompt": board_name,
                    "mediaId": master_mid,
                    "mediaIds": [master_mid],
                    "variantCount": 1,
                    "aspectRatio": vid_aspect,
                    "renderedAt": now_iso,
                    "isMasterNode": True,
                    "mediaProvider": "master_assemble",
                    **({"thumbnailMediaId": thumb_mid} if thumb_mid else {}),
                },
            )
            s.add(master)
            s.commit()
            s.refresh(master)

        existing_sources = {
            e.source_id
            for e in s.exec(
                select(Edge).where(
                    (Edge.board_id == board_id) & (Edge.target_id == master.id)
                )
            ).all()
        }
        for sn in shot_candidates:
            if sn.id is not None and sn.id not in existing_sources:
                s.add(
                    Edge(
                        board_id=board_id,
                        source_id=sn.id,
                        target_id=master.id,
                        kind="ref",
                    )
                )
        s.commit()
        s.refresh(master)
        master_id = master.id

    return {
        "board_id": board_id,
        "master_node_id": master_id,
        "master_media_id": master_mid,
        "thumbnail_media_id": thumb_mid,
        "clip_count": len(clip_records),
        "duration_s": round(total_dur_s, 2),
        "width": out_w,
        "height": out_h,
        "bgm_used": str(resolved_bgm) if resolved_bgm else None,
        "master_file_path": str(master_out_path),
        "jianying_draft_path": str(jianying_draft_dir) if jianying_draft_dir else None,
        "jianying_installed_path": str(jianying_installed_path) if jianying_installed_path else None,
    }
