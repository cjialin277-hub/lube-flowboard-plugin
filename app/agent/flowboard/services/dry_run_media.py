"""Local zero-credit Dry-Run media renderer (`media_provider = "dry_run"`).

Generates real, valid PNG storyboard slates and H.264 MP4 motion-preview clips
locally (via `ffmpeg`, with a zero-dependency pure-Python PNG fallback) and
plants them into `storage/media/` via `media_service.ingest_inline_bytes`.

Every downstream Flowboard subsystem — `GET /media/{id}`, node thumbnails,
multi-variant grids, edge variant pinning (`v1`/`v2`), `ResultViewer`,
cross-board `References` library, and `agy` auto-prompt synthesis — works
identically to a live Google Flow run while burning 0 credits and touching
zero external RPC/captcha endpoints.
"""
from __future__ import annotations

import asyncio
import logging
import shutil
import struct
import tempfile
import textwrap
import uuid
import zlib
from pathlib import Path
from typing import Optional

from flowboard.services import media as media_service

logger = logging.getLogger(__name__)

_EXTRA_BINS = (
    Path.home() / ".local" / "bin",
    Path("/opt/homebrew/bin"),
    Path("/usr/local/bin"),
)

_FONT_CANDIDATES = (
    Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
    Path("/System/Library/Fonts/Supplemental/Arial.ttf"),
    Path("/System/Library/Fonts/Helvetica.ttc"),
)

# Distinct cinematic palettes per variant slot so multi-variant batches are
# immediately distinguishable at thumbnail size on the canvas.
_VARIANT_PALETTES: tuple[tuple[str, str, str], ...] = (
    ("0x0f2027", "0x2c5364", "SHOT A · ESTABLISHING / WIDE"),
    ("0x1f1c2c", "0x5c4b7d", "SHOT B · OVER-THE-SHOULDER / MEDIUM"),
    ("0x23191e", "0x6b2d3c", "SHOT C · EMOTIONAL CLOSE-UP"),
    ("0x132a24", "0x2e6f5e", "SHOT D · DRAMATIC LOW-ANGLE"),
)


def resolve_ffmpeg() -> Optional[str]:
    found = shutil.which("ffmpeg")
    if found:
        return found
    for folder in _EXTRA_BINS:
        cand = folder / "ffmpeg"
        if cand.is_file():
            return str(cand)
    return None


def _pick_font() -> Optional[str]:
    for p in _FONT_CANDIDATES:
        if p.is_file():
            return str(p)
    return None


def _dims_for_aspect(aspect: Optional[str], *, is_video: bool = False) -> tuple[int, int, str]:
    upper = (aspect or "").upper()
    if "PORTRAIT" in upper or "VERTICAL" in upper:
        return (720, 1280, "9:16")
    if not is_video and "SQUARE" in upper:
        return (960, 960, "1:1")
    return (1280, 720, "16:9")


def _pure_python_png(width: int, height: int, rgb_top: tuple[int, int, int], rgb_bot: tuple[int, int, int]) -> bytes:
    """Zero-dependency valid RGB PNG gradient fallback when ffmpeg is absent."""
    rows = bytearray()
    denom = max(height - 1, 1)
    for y in range(height):
        t = y / denom
        r = int(rgb_top[0] * (1.0 - t) + rgb_bot[0] * t)
        g = int(rgb_top[1] * (1.0 - t) + rgb_bot[1] * t)
        b = int(rgb_top[2] * (1.0 - t) + rgb_bot[2] * t)
        rows.append(0)  # filter type 0
        rows.extend(bytes((r, g, b)) * width)

    def _chunk(tag: bytes, payload: bytes) -> bytes:
        crc = zlib.crc32(tag + payload) & 0xFFFFFFFF
        return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    idat = zlib.compress(bytes(rows), level=6)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", ihdr)
        + _chunk(b"IDAT", idat)
        + _chunk(b"IEND", b"")
    )


def _format_slate_text(
    *,
    variant_idx: int,
    variant_total: int,
    aspect_label: str,
    prompt: str,
    ref_count: int,
    shot_tag: str,
) -> str:
    clean = " ".join((prompt or "").split())
    wrapped = textwrap.wrap(clean, width=48)[:5]
    prompt_block = "\n".join(wrapped) if wrapped else "(empty prompt)"
    return (
        f"DRY RUN PREVIEW  |  VARIANT {variant_idx + 1}/{variant_total}  |  {aspect_label}  |  0 CREDITS\n"
        f"{shot_tag}   [Refs: {ref_count}]\n"
        f"--------------------------------------------------------\n"
        f"{prompt_block}"
    )


async def _render_dry_run_png(
    *,
    prompt: str,
    aspect_ratio: Optional[str],
    variant_idx: int,
    variant_total: int,
    ref_paths: list[Path],
) -> bytes:
    width, height, aspect_label = _dims_for_aspect(aspect_ratio, is_video=False)
    c0, c1, shot_tag = _VARIANT_PALETTES[variant_idx % len(_VARIANT_PALETTES)]
    ffmpeg_bin = resolve_ffmpeg()
    font_path = _pick_font()

    if not ffmpeg_bin:
        return _pure_python_png(width, height, (24, 36, 52), (68, 92, 118))

    with tempfile.TemporaryDirectory(prefix="fb_dryrun_img_") as tmp:
        tmp_dir = Path(tmp)
        out_png = tmp_dir / "out.png"
        txt_file = tmp_dir / "slate.txt"
        txt_file.write_text(
            _format_slate_text(
                variant_idx=variant_idx,
                variant_total=variant_total,
                aspect_label=aspect_label,
                prompt=prompt,
                ref_count=len(ref_paths),
                shot_tag=shot_tag,
            ),
            encoding="utf-8",
        )

        # Build filtergraph: gradient backdrop + framing crosshair + text slate
        # + optional reference PIP in bottom-right corner.
        base_vf: list[str] = [
            f"drawbox=x=32:y=32:w={width - 64}:h={height - 64}:color=white@0.22:t=2",
            f"drawbox=x=32:y=32:w={width - 64}:h=220:color=black@0.52:t=fill",
            f"drawbox=x={width // 2 - 24}:y={height // 2}:w=48:h=2:color=white@0.30:t=fill",
            f"drawbox=x={width // 2}:y={height // 2 - 24}:w=2:h=48:color=white@0.30:t=fill",
        ]
        if font_path:
            esc_font = font_path.replace("\\", "\\\\").replace(":", "\\:")
            esc_txt = str(txt_file).replace("\\", "\\\\").replace(":", "\\:")
            base_vf.append(
                f"drawtext=fontfile='{esc_font}':textfile='{esc_txt}':expansion=none:"
                f"fontcolor=white:fontsize=21:line_spacing=9:x=54:y=52"
            )

        cmd: list[str] = [
            ffmpeg_bin,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"gradients=s={width}x{height}:c0={c0}:c1={c1}:x0=0:y0=0:x1={width}:y1={height}:d=0.04:r=25",
        ]

        valid_ref = next((p for p in ref_paths if p.is_file()), None)
        if valid_ref is not None:
            pip_w = max(140, width // 5)
            cmd.extend(["-i", str(valid_ref)])
            chain_0 = ",".join(base_vf)
            filter_complex = (
                f"[0:v]{chain_0}[bg];"
                f"[1:v]scale={pip_w}:-1,pad=iw+6:ih+6:3:3:color=white@0.75[pip];"
                f"[bg][pip]overlay=W-w-48:H-h-48[vout]"
            )
            cmd.extend(["-filter_complex", filter_complex, "-map", "[vout]"])
        else:
            cmd.extend(["-vf", ",".join(base_vf)])

        cmd.extend(["-frames:v", "1", str(out_png)])

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _out, err = await proc.communicate()
        if proc.returncode == 0 and out_png.is_file():
            return out_png.read_bytes()
        logger.warning(
            "dry_run: ffmpeg png failed (rc=%s): %s; using pure-python fallback",
            proc.returncode,
            err.decode("utf-8", errors="replace")[:240],
        )
        return _pure_python_png(width, height, (24, 36, 52), (68, 92, 118))


async def _render_dry_run_mp4(
    *,
    prompt: str,
    aspect_ratio: Optional[str],
    start_path: Optional[Path],
    duration_s: int = 4,
    slot_idx: int = 0,
) -> tuple[Optional[bytes], Optional[str]]:
    width, height, aspect_label = _dims_for_aspect(aspect_ratio, is_video=True)
    ffmpeg_bin = resolve_ffmpeg()
    if not ffmpeg_bin:
        return None, "dry_run_ffmpeg_not_found"

    fps = 24
    dur = max(2, min(int(duration_s or 4), 10))
    total_frames = dur * fps
    font_path = _pick_font()

    with tempfile.TemporaryDirectory(prefix="fb_dryrun_vid_") as tmp:
        tmp_dir = Path(tmp)
        out_mp4 = tmp_dir / "out.mp4"
        hud_file = tmp_dir / "hud.txt"
        short_prompt = " ".join((prompt or "").split())[:72]
        hud_file.write_text(
            f"DRY RUN VIDEO #{slot_idx + 1} ({aspect_label} · {dur}s · 0 CREDITS) — DOLLY-IN MOTION\n"
            f"{short_prompt}",
            encoding="utf-8",
        )

        hud_draw = [f"drawbox=x=0:y=0:w={width}:h=82:color=black@0.58:t=fill"]
        if font_path:
            esc_font = font_path.replace("\\", "\\\\").replace(":", "\\:")
            esc_txt = str(hud_file).replace("\\", "\\\\").replace(":", "\\:")
            hud_draw.append(
                f"drawtext=fontfile='{esc_font}':textfile='{esc_txt}':expansion=none:"
                f"fontcolor=0x6ee7b7:fontsize=18:line_spacing=6:x=24:y=18"
            )

        if start_path is not None and start_path.is_file():
            # Smooth cinematic Dolly-In push on the actual upstream storyboard frame!
            vf = ",".join([
                f"scale={width * 2}:{height * 2}:force_original_aspect_ratio=increase",
                f"crop={width * 2}:{height * 2}",
                (
                    f"zoompan=z='min(zoom+0.0016,1.16)':"
                    f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':"
                    f"d={total_frames}:s={width}x{height}:fps={fps}"
                ),
                *hud_draw,
                "format=yuv420p",
            ])
            video_inputs = ["-loop", "1", "-i", str(start_path)]
        else:
            vf = ",".join([*hud_draw, "format=yuv420p"])
            video_inputs = [
                "-f",
                "lavfi",
                "-i",
                f"testsrc2=size={width}x{height}:rate={fps}:duration={dur}",
            ]

        cmd = [
            ffmpeg_bin,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            *video_inputs,
            "-f",
            "lavfi",
            "-i",
            "anullsrc=channel_layout=stereo:sample_rate=44100",
            "-t",
            str(dur),
            "-vf",
            vf,
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "23",
            "-c:a",
            "aac",
            "-b:a",
            "96k",
            "-shortest",
            "-movflags",
            "+faststart",
            str(out_mp4),
        ]

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _out, err = await proc.communicate()
        if proc.returncode == 0 and out_mp4.is_file():
            return out_mp4.read_bytes(), None
        err_msg = err.decode("utf-8", errors="replace").strip()[:240]
        logger.error("dry_run: ffmpeg mp4 failed (rc=%s): %s", proc.returncode, err_msg)
        return None, f"dry_run_video_failed: {err_msg}"


async def _render_dry_run_first_last_mp4(
    *,
    prompt: str,
    aspect_ratio: Optional[str],
    start_path: Optional[Path],
    end_path: Optional[Path],
    duration_s: int = 8,
) -> tuple[Optional[bytes], Optional[str]]:
    """Render a smooth Start -> End frame transition preview MP4 via xfade."""
    if not (start_path and start_path.is_file() and end_path and end_path.is_file()):
        return await _render_dry_run_mp4(
            prompt=prompt,
            aspect_ratio=aspect_ratio,
            start_path=start_path or end_path,
            duration_s=duration_s,
            slot_idx=0,
        )

    width, height, aspect_label = _dims_for_aspect(aspect_ratio, is_video=True)
    ffmpeg_bin = resolve_ffmpeg()
    if not ffmpeg_bin:
        return None, "dry_run_ffmpeg_not_found"

    fps = 24
    dur = max(4, min(int(duration_s or 8), 10))
    half_dur = dur / 2.0
    fade_dur = min(1.5, max(0.8, dur * 0.25))
    fade_offset = max(0.5, half_dur - fade_dur / 2.0)
    clip1_dur = fade_offset + fade_dur
    clip2_dur = max(1.0, dur - fade_offset)
    font_path = _pick_font()

    with tempfile.TemporaryDirectory(prefix="fb_dryrun_fl_") as tmp:
        tmp_dir = Path(tmp)
        out_mp4 = tmp_dir / "out.mp4"
        hud_file = tmp_dir / "hud.txt"
        short_prompt = " ".join((prompt or "").split())[:72]
        hud_file.write_text(
            f"FIRST -> LAST TRANSITION ({aspect_label} · {dur}s · 0c DRY RUN)\n"
            f"{short_prompt}",
            encoding="utf-8",
        )

        hud_chain = f"drawbox=x=0:y=0:w={width}:h=82:color=black@0.58:t=fill"
        if font_path:
            esc_font = font_path.replace("\\", "\\\\").replace(":", "\\:")
            esc_txt = str(hud_file).replace("\\", "\\\\").replace(":", "\\:")
            hud_chain += (
                f",drawtext=fontfile='{esc_font}':textfile='{esc_txt}':expansion=none:"
                f"fontcolor=0x6ee7b7:fontsize=18:line_spacing=6:x=24:y=18"
            )

        scale_crop = (
            f"scale={width}:{height}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height},setsar=1,fps={fps},format=yuv420p"
        )
        fc = (
            f"[0:v]{scale_crop}[v0];"
            f"[1:v]{scale_crop}[v1];"
            f"[v0][v1]xfade=transition=fade:duration={fade_dur:.2f}:offset={fade_offset:.2f},"
            f"{hud_chain},format=yuv420p[vout]"
        )

        cmd = [
            ffmpeg_bin,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-loop",
            "1",
            "-t",
            f"{clip1_dur:.2f}",
            "-i",
            str(start_path),
            "-loop",
            "1",
            "-t",
            f"{clip2_dur:.2f}",
            "-i",
            str(end_path),
            "-f",
            "lavfi",
            "-i",
            "anullsrc=channel_layout=stereo:sample_rate=44100",
            "-filter_complex",
            fc,
            "-map",
            "[vout]",
            "-map",
            "2:a",
            "-t",
            str(dur),
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "23",
            "-c:a",
            "aac",
            "-b:a",
            "96k",
            "-shortest",
            "-movflags",
            "+faststart",
            str(out_mp4),
        ]

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _out, err = await proc.communicate()
        if proc.returncode == 0 and out_mp4.is_file():
            return out_mp4.read_bytes(), None
        err_msg = err.decode("utf-8", errors="replace").strip()[:240]
        logger.error("dry_run: first-last ffmpeg mp4 failed (rc=%s): %s", proc.returncode, err_msg)
        return None, f"dry_run_first_last_failed: {err_msg}"


def _cached_paths_for_ids(media_ids: Optional[list[str]]) -> list[Path]:
    paths: list[Path] = []
    for mid in media_ids or []:
        if not isinstance(mid, str) or not mid:
            continue
        p = media_service.cached_path(mid)
        if p is not None and p.is_file():
            paths.append(p)
    return paths


async def run_dry_run_media(
    *,
    kind: str,
    prompt: str,
    aspect_ratio: Optional[str] = None,
    source_media_ids: Optional[list[str]] = None,
    reference_media_ids: Optional[list[str]] = None,
    variant_count: int = 1,
    per_variant_prompts: Optional[list[str]] = None,
    duration_s: int = 4,
) -> tuple[dict, Optional[str]]:
    """Render local synthetic image(s) or video(s) and ingest into media cache."""
    is_video = kind in ("video", "video_refs", "video_first_last")

    if not is_video:
        count = max(1, min(int(variant_count or 1), 4))
        ref_paths = _cached_paths_for_ids(
            (source_media_ids or []) + (reference_media_ids or [])
        )
        prompts = [
            p.strip()
            for p in (per_variant_prompts or [])
            if isinstance(p, str) and p.strip()
        ]
        media_ids: list[str] = []
        media_entries: list[dict] = []
        for idx in range(count):
            slot_prompt = prompts[idx] if idx < len(prompts) else prompt
            png_bytes = await _render_dry_run_png(
                prompt=slot_prompt,
                aspect_ratio=aspect_ratio,
                variant_idx=idx,
                variant_total=count,
                ref_paths=ref_paths,
            )
            mid = str(uuid.uuid4())
            ok = media_service.ingest_inline_bytes(
                mid, png_bytes, kind="image", mime="image/png"
            )
            if not ok:
                return {}, "dry_run_ingest_failed"
            media_ids.append(mid)
            media_entries.append({"media_id": mid, "url": f"/media/{mid}"})

        return (
            {
                "provider": "dry_run",
                "media_ids": media_ids,
                "media_entries": media_entries,
            },
            None,
        )

    # First + Last frame transition branch
    if kind == "video_first_last":
        frame_ids = list(source_media_ids or [])
        start_id = frame_ids[0] if len(frame_ids) >= 1 else ""
        end_id = frame_ids[1] if len(frame_ids) >= 2 else ""
        start_path = media_service.cached_path(start_id) if start_id else None
        end_path = media_service.cached_path(end_id) if end_id else None
        mp4_bytes, err = await _render_dry_run_first_last_mp4(
            prompt=prompt,
            aspect_ratio=aspect_ratio,
            start_path=start_path,
            end_path=end_path,
            duration_s=duration_s,
        )
        if err or not mp4_bytes:
            return {}, err or "dry_run_first_last_empty"
        mid = str(uuid.uuid4())
        if not media_service.ingest_inline_bytes(mid, mp4_bytes, kind="video", mime="video/mp4"):
            return {}, "dry_run_ingest_failed"
        return (
            {
                "provider": "dry_run",
                "media_ids": [mid],
                "media_entries": [{"media_id": mid, "url": f"/media/{mid}"}],
                "slot_errors": [None],
                "duration_s": duration_s,
            },
            None,
        )

    # Video / Omni Flash r2v branch
    frame_ids = list(source_media_ids or [])
    if not frame_ids and reference_media_ids:
        frame_ids = list(reference_media_ids[:1])
    if not frame_ids:
        frame_ids = [""]

    v_media_ids: list[Optional[str]] = []
    v_entries: list[dict] = []
    slot_errors: list[Optional[str]] = []
    for idx, src_id in enumerate(frame_ids):
        start_path = media_service.cached_path(src_id) if src_id else None
        mp4_bytes, err = await _render_dry_run_mp4(
            prompt=prompt,
            aspect_ratio=aspect_ratio,
            start_path=start_path,
            duration_s=duration_s,
            slot_idx=idx,
        )
        if err or not mp4_bytes:
            v_media_ids.append(None)
            slot_errors.append(err or "dry_run_video_empty")
            continue
        mid = str(uuid.uuid4())
        ok = media_service.ingest_inline_bytes(
            mid, mp4_bytes, kind="video", mime="video/mp4"
        )
        if not ok:
            v_media_ids.append(None)
            slot_errors.append("dry_run_ingest_failed")
            continue
        v_media_ids.append(mid)
        v_entries.append({"media_id": mid, "url": f"/media/{mid}"})
        slot_errors.append(None)

    if not any(v_media_ids):
        first_err = next((e for e in slot_errors if e), "dry_run_video_failed")
        return {}, first_err

    return (
        {
            "provider": "dry_run",
            "media_ids": v_media_ids,
            "media_entries": v_entries,
            "slot_errors": slot_errors,
            "duration_s": duration_s,
        },
        None,
    )
