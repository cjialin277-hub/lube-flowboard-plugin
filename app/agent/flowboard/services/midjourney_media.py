"""Midjourney V7 / V6.1 image generation provider & prompt compiler for Flowboard.

Allows users to generate keyframes and character/scene anchors using Midjourney
on the canvas and wire them directly into downstream Google Flow (Omni 1.2 Flash
/ Veo 3.1) video nodes.

Supports two execution transports:
1. Direct Midjourney Proxy / API Gateway (when `api_base` is configured via
   Settings or `FLOWBOARD_MJ_API_BASE`):
   - `midjourney-proxy` REST (`POST /mj/submit/imagine` + `GET /mj/task/{id}/fetch`)
   - OpenAI-compatible MJ image endpoint (`POST /v1/images/generations`)
2. Zero-config Hybrid Canvas Mode (when `api_base` is not set):
   - Compiles the prompt into Midjourney V7 `--style raw` cinema photography
     tokens + full `/imagine prompt: ...` syntax, and renders via the active
     Flow `GEM_PIX_2` checkpoint (or dry-run fallback if offline) so the node
     immediately receives usable media bytes for video chaining.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
import subprocess
import sys
import uuid
from typing import Any, Optional

import httpx

from flowboard import config
from flowboard.db import get_session
from flowboard.db.models import AppSetting
from flowboard.services import media as media_service
from flowboard.services.flow_client import flow_client
from flowboard.services.flow_project import effective_project_id
from flowboard.services.flow_sdk import get_flow_sdk, is_valid_project_id, resolve_paygate_tier

logger = logging.getLogger(__name__)

MJ_SETTING_KEY = "midjourney.settings"


def _aspect_to_mj_ar(aspect_ratio: Optional[str]) -> str:
    up = (aspect_ratio or "").upper()
    if "PORTRAIT" in up or "9:16" in up:
        return "9:16"
    if "SQUARE" in up or "1:1" in up:
        return "1:1"
    if "4_3" in up or "4:3" in up:
        return "4:3"
    if "3_4" in up or "3:4" in up:
        return "3:4"
    return "16:9"


def get_mj_settings() -> dict[str, Any]:
    """Return effective Midjourney gateway configuration."""
    stored: dict[str, Any] = {}
    try:
        with get_session() as s:
            row = s.get(AppSetting, MJ_SETTING_KEY)
            if row and row.value:
                parsed = json.loads(row.value)
                if isinstance(parsed, dict):
                    stored = parsed
    except Exception:  # noqa: BLE001
        logger.debug("could not read midjourney.settings from DB", exc_info=True)

    api_base = str(stored.get("api_base") or config.MJ_API_BASE or "").strip().rstrip("/")
    api_key = str(stored.get("api_key") or config.MJ_API_KEY or "").strip()
    version = str(stored.get("version") or config.MJ_DEFAULT_VERSION or "7").strip() or "7"
    return {
        "api_base": api_base,
        "api_key_set": bool(api_key),
        "api_key_preview": f"{api_key[:4]}…{api_key[-3:]}" if len(api_key) > 8 else ("***" if api_key else ""),
        "version": version,
        "mode": "gateway" if api_base else "hybrid_flow",
        "_raw_key": api_key,
    }


def set_mj_settings(
    *,
    api_base: Optional[str] = None,
    api_key: Optional[str] = None,
    version: Optional[str] = None,
) -> dict[str, Any]:
    """Persist Midjourney gateway configuration into AppSetting."""
    current = get_mj_settings()
    next_base = current["api_base"] if api_base is None else api_base.strip().rstrip("/")
    next_key = current["_raw_key"] if api_key is None else api_key.strip()
    next_ver = current["version"] if version is None else (version.strip() or "7")
    payload = {"api_base": next_base, "api_key": next_key, "version": next_ver}
    with get_session() as s:
        row = s.get(AppSetting, MJ_SETTING_KEY)
        if row is None:
            s.add(AppSetting(key=MJ_SETTING_KEY, value=json.dumps(payload, ensure_ascii=False)))
        else:
            row.value = json.dumps(payload, ensure_ascii=False)
            s.add(row)
        s.commit()
    out = get_mj_settings()
    out.pop("_raw_key", None)
    return out


def compile_mj_prompt(
    prompt: str,
    aspect_ratio: Optional[str] = None,
    ref_media_ids: Optional[list[str]] = None,
    version: str = "7",
) -> dict[str, str]:
    """Compile a canvas prompt + aspect ratio + refs into MJ V7 command and aesthetic prompt."""
    ar = _aspect_to_mj_ar(aspect_ratio)
    clean = re.sub(
        r"\bNO\s+TEXT\s+IN\s+THE\s+IMAGE\.?\s*|\bNO\s+SUBTITLES\.?\s*|\bNO\s+WATERMARKS?\.?\s*",
        "",
        prompt or "",
        flags=re.IGNORECASE,
    ).strip()
    clean = re.sub(r"\s{2,}", " ", clean).strip(" ,.")

    ref_tags: list[str] = []
    if ref_media_ids:
        for mid in ref_media_ids[:3]:
            if isinstance(mid, str) and mid.strip():
                ref_tags.append(f"http://localhost:8434/media/{mid.strip()}")

    oref_clause = f" --oref {' '.join(ref_tags)}" if ref_tags else ""
    mj_command = (
        f"/imagine prompt: {clean}{oref_clause} --ar {ar} --v {version} "
        f"--style raw --no text subtitles watermark"
    )
    aesthetic_prompt = (
        "NO TEXT IN THE IMAGE. NO SUBTITLES. "
        "Midjourney V7 --style raw flagship cinema photography, Kodak Portra 400 35mm anamorphic film grain, "
        "authentic skin pores, micro-contrast and natural chiaroscuro lighting: "
        f"{clean}"
    )
    return {
        "ar": ar,
        "clean_prompt": clean,
        "mj_command": mj_command,
        "aesthetic_prompt": aesthetic_prompt,
    }


async def _try_gateway_generate(
    *,
    api_base: str,
    api_key: str,
    compiled: dict[str, str],
    variant_count: int,
) -> Optional[tuple[list[str], list[dict]]]:
    """Call external midjourney-proxy (/mj/submit/imagine) or OpenAI (/v1/images/generations)."""
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
        headers["mj-api-secret"] = api_key

    async with httpx.AsyncClient(timeout=120.0) as client:
        # 1) If api_base looks like OpenAI /v1 or ends with /v1, call /v1/images/generations
        if api_base.endswith("/v1") or "/v1/" in api_base:
            url = f"{api_base}/images/generations" if api_base.endswith("/v1") else api_base
            size = "1792x1024" if compiled["ar"] == "16:9" else ("1024x1792" if compiled["ar"] == "9:16" else "1024x1024")
            resp = await client.post(
                url,
                headers=headers,
                json={
                    "model": "midjourney",
                    "prompt": compiled["mj_command"].removeprefix("/imagine prompt: ").strip(),
                    "n": max(1, min(variant_count, 4)),
                    "size": size,
                },
            )
            if resp.status_code >= 400:
                raise RuntimeError(f"MJ API HTTP {resp.status_code}: {resp.text[:200]}")
            data = resp.json()
            items = data.get("data") or []
            media_ids: list[str] = []
            entries: list[dict] = []
            for item in items:
                if not isinstance(item, dict):
                    continue
                mid = str(uuid.uuid4())
                if isinstance(item.get("b64_json"), str):
                    raw_bytes = base64.b64decode(item["b64_json"])
                    media_service.ingest_inline_bytes(mid, raw_bytes, kind="image", mime="image/png")
                    media_ids.append(mid)
                    entries.append({"media_id": mid, "url": f"/media/{mid}"})
                elif isinstance(item.get("url"), str):
                    img_r = await client.get(item["url"])
                    if img_r.status_code == 200 and img_r.content:
                        mime = img_r.headers.get("content-type", "image/png").split(";")[0]
                        media_service.ingest_inline_bytes(mid, img_r.content, kind="image", mime=mime)
                        media_ids.append(mid)
                        entries.append({"media_id": mid, "url": f"/media/{mid}"})
            if media_ids:
                return media_ids, entries

        # 2) Standard midjourney-proxy (/mj/submit/imagine -> /mj/task/{id}/fetch)
        submit_url = f"{api_base}/mj/submit/imagine"
        resp = await client.post(
            submit_url,
            headers=headers,
            json={"prompt": compiled["mj_command"].removeprefix("/imagine prompt: ").strip()},
        )
        if resp.status_code >= 400:
            raise RuntimeError(f"MJ Proxy HTTP {resp.status_code}: {resp.text[:200]}")
        sub = resp.json()
        task_id = sub.get("result") or sub.get("taskId") or sub.get("id")
        if not task_id:
            raise RuntimeError(f"MJ Proxy returned no task id: {str(sub)[:200]}")

        for _ in range(45):
            await asyncio.sleep(3.5)
            poll_r = await client.get(f"{api_base}/mj/task/{task_id}/fetch", headers=headers)
            if poll_r.status_code >= 400:
                continue
            tdata = poll_r.json()
            status = str(tdata.get("status") or "").upper()
            if status in ("FAILURE", "FAILED", "CANCEL"):
                raise RuntimeError(f"MJ task failed: {tdata.get('failReason') or status}")
            if status == "SUCCESS":
                urls: list[str] = []
                if isinstance(tdata.get("imageUrls"), list):
                    urls = [u["url"] if isinstance(u, dict) else str(u) for u in tdata["imageUrls"] if u]
                if not urls and isinstance(tdata.get("imageUrl"), str) and tdata["imageUrl"]:
                    urls = [tdata["imageUrl"]]
                media_ids = []
                entries = []
                for u in urls[:4]:
                    img_r = await client.get(u)
                    if img_r.status_code == 200 and img_r.content:
                        mid = str(uuid.uuid4())
                        mime = img_r.headers.get("content-type", "image/png").split(";")[0]
                        media_service.ingest_inline_bytes(mid, img_r.content, kind="image", mime=mime)
                        media_ids.append(mid)
                        entries.append({"media_id": mid, "url": f"/media/{mid}"})
                if media_ids:
                    return media_ids, entries
                break

    return None


async def list_browser_mj_assets(limit: int = 40) -> dict:
    """List images currently visible in the user's open www.midjourney.com Chrome tab
    (checks both the Flow extension profile and all macOS Chrome profile windows).
    """
    if flow_client.connected:
        res = await flow_client.ext_call("mj_list_assets", {"limit": limit}, timeout=10.0)
        if isinstance(res, dict) and not res.get("error"):
            data = res.get("data") if isinstance(res.get("data"), dict) else {}
            if data.get("items"):
                return {
                    "connected": True,
                    "url": data.get("url") or "",
                    "folder": data.get("folder") or "",
                    "count": data.get("count") or 0,
                    "items": data.get("items") or [],
                }
    # Fallback to cross-profile macOS Chrome inspection (handles MJ open in another Chrome profile)
    return await asyncio.to_thread(_macos_chrome_list_mj_assets, limit)


def _run_chrome_tab_js(url_substring: str, js_code: str, timeout_s: float = 12.0) -> Optional[str]:
    """Execute JavaScript in the first Google Chrome tab across ANY Chrome profile window
    whose URL contains `url_substring`. Non-invasive read/fetch helper for macOS.
    """
    if sys.platform != "darwin":
        return None
    apple_script = f"""
tell application "Google Chrome"
  repeat with w in windows
    repeat with t in tabs of w
      if (URL of t) contains {json.dumps(url_substring)} then
        return execute t javascript {json.dumps(js_code)}
      end if
    end repeat
  end repeat
  return ""
end tell
"""
    try:
        proc = subprocess.run(
            ["osascript", "-e", apple_script],
            capture_output=True,
            text=True,
            timeout=timeout_s,
            check=False,
        )
        out = (proc.stdout or "").strip()
        if not out or out == "missing value":
            return None
        return out
    except Exception:
        return None


def probe_macos_chrome_mj_tab() -> dict:
    js = """(() => {
      const u = new URL(location.href);
      const folder = u.searchParams.get('folder') || '';
      const hasInputBar = !!document.getElementById('desktop_input_bar');
      const imgs = Array.from(document.querySelectorAll('img')).filter(i =>
        (i.currentSrc || i.src || '').includes('cdn.midjourney.com/')
      );
      return JSON.stringify({
        connected: true,
        url: location.href,
        title: document.title,
        folder,
        hasInputBar,
        visibleImageCount: imgs.length
      });
    })()"""
    raw = _run_chrome_tab_js("midjourney.com", js, timeout_s=5.0)
    if not raw:
        return {"connected": False}
    try:
        return json.loads(raw)
    except Exception:
        return {"connected": False}


def probe_macos_chrome_muse_tab() -> dict:
    js = """(() => {
      const body = (document.body?.innerText || '').toLowerCase();
      const hasTextarea = !!document.querySelector('textarea');
      const loginHint = ['log in', 'sign in', 'create an account'].some(h => body.includes(h));
      return JSON.stringify({
        connected: true,
        url: location.href,
        title: document.title,
        ready: hasTextarea && !loginHint,
        hasTextarea,
        loginRequired: loginHint && !hasTextarea
      });
    })()"""
    raw = _run_chrome_tab_js("muse.ai", js, timeout_s=5.0)
    if not raw:
        return {"connected": False}
    try:
        return json.loads(raw)
    except Exception:
        return {"connected": False}


def _macos_chrome_list_mj_assets(limit: int = 24) -> dict:
    import time as _time

    token = f"__fbMjList_{uuid.uuid4().hex[:8]}"
    max_items = min(max(int(limit), 1), 36)
    start_js = f"""(() => {{
      window[{json.dumps(token)}] = "PENDING";
      (async () => {{
        const maxItems = {max_items};
        const u = new URL(location.href);
        const folder = u.searchParams.get('folder') || '';
        const seen = new Set();
        const rawItems = [];
        for (const img of document.querySelectorAll('img')) {{
          const src = img.currentSrc || img.src || '';
          if (!src.includes('cdn.midjourney.com/')) continue;
          const mJob = src.match(/cdn\\.midjourney\\.com\\/([0-9a-f-]{{36}})\\/0_(\\d+)/i);
          if (mJob) {{
            const jobId = mJob[1].toLowerCase();
            const variantIdx = Number(mJob[2]);
            const key = `${{jobId}}_${{variantIdx}}`;
            if (seen.has(key)) continue;
            seen.add(key);
            rawItems.push({{
              key,
              kind: 'job',
              jobId,
              variantIdx,
              rawThumbUrl: src,
              thumbUrl: src,
              fullUrl: `https://cdn.midjourney.com/${{jobId}}/0_${{variantIdx}}.jpeg`,
              width: img.naturalWidth || 685,
              height: img.naturalHeight || 384,
              alt: (img.alt || '').trim()
            }});
            if (rawItems.length >= maxItems) break;
            continue;
          }}
          const mUp = src.match(/cdn\\.midjourney\\.com\\/u\\/([0-9a-f-]{{36}})\\/([0-9a-f]+?)(?:_\\d+_[A-Z])?\\.(jpg|jpeg|png|webp)/i);
          if (mUp) {{
            const userId = mUp[1].toLowerCase();
            const hash = mUp[2].toLowerCase();
            const key = `u_${{hash.slice(0, 16)}}`;
            if (seen.has(key)) continue;
            seen.add(key);
            rawItems.push({{
              key,
              kind: 'upload',
              jobId: hash.slice(0, 16),
              variantIdx: 0,
              rawThumbUrl: src,
              thumbUrl: src,
              fullUrl: `https://cdn.midjourney.com/u/${{userId}}/${{hash}}.jpg`,
              width: img.naturalWidth || 512,
              height: img.naturalHeight || 512,
              alt: (img.alt || '').trim()
            }});
            if (rawItems.length >= maxItems) break;
          }}
        }}
        await Promise.all(rawItems.map(async (it) => {{
          try {{
            const r = await fetch(it.rawThumbUrl);
            if (!r.ok) return;
            const b = await r.blob();
            if (!b || b.size < 200) return;
            const buf = new Uint8Array(await b.arrayBuffer());
            let s = '';
            for (let i = 0; i < buf.length; i += 0x8000) {{
              s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
            }}
            it.thumbUrl = `data:${{b.type || 'image/webp'}};base64,${{btoa(s)}}`;
          }} catch {{}}
        }}));
        window[{json.dumps(token)}] = JSON.stringify({{
          connected: true,
          url: location.href,
          folder,
          count: rawItems.length,
          items: rawItems
        }});
      }})();
      return "STARTED";
    }})()"""
    if _run_chrome_tab_js("midjourney.com", start_js, timeout_s=6.0) != "STARTED":
        return {"connected": False, "error": "NO_MIDJOURNEY_TAB", "items": []}
    poll_js = f"""(() => {{
      const v = window[{json.dumps(token)}];
      if (v && v !== "PENDING") {{
        delete window[{json.dumps(token)}];
        return v;
      }}
      return "PENDING";
    }})()"""
    for _ in range(25):
        _time.sleep(0.25)
        ans = _run_chrome_tab_js("midjourney.com", poll_js, timeout_s=6.0)
        if ans and ans != "PENDING":
            try:
                return json.loads(ans)
            except Exception as exc:
                return {"connected": False, "error": str(exc), "items": []}
    return {"connected": False, "error": "MJ_LIST_TIMEOUT", "items": []}


def _macos_chrome_fetch_mj_image(full_url: str, thumb_url: str = "") -> Optional[dict]:
    import time as _time

    token = f"__fbMjFetch_{uuid.uuid4().hex[:8]}"
    start_js = f"""(() => {{
      window[{json.dumps(token)}] = "PENDING";
      (async () => {{
        const tryFetch = async (u) => {{
          if (!u) return null;
          const r = await fetch(u);
          if (!r.ok) return null;
          const b = await r.blob();
          if (!b || b.size < 1000) return null;
          const buf = new Uint8Array(await b.arrayBuffer());
          let s = '';
          for (let i = 0; i < buf.length; i += 0x8000) {{
            s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
          }}
          return {{ mime: b.type || 'image/jpeg', size: b.size, b64: btoa(s), urlUsed: u }};
        }};
        try {{
          const got = (await tryFetch({json.dumps(full_url)})) || (await tryFetch({json.dumps(thumb_url)}));
          window[{json.dumps(token)}] = JSON.stringify(got || {{ error: "MJ_CDN_FETCH_FAILED" }});
        }} catch (e) {{
          window[{json.dumps(token)}] = JSON.stringify({{ error: String(e) }});
        }}
      }})();
      return "STARTED";
    }})()"""
    if _run_chrome_tab_js("midjourney.com", start_js, timeout_s=5.0) != "STARTED":
        return None
    poll_js = f"""(() => {{
      const v = window[{json.dumps(token)}];
      if (v && v !== "PENDING") {{
        delete window[{json.dumps(token)}];
        return v;
      }}
      return "PENDING";
    }})()"""
    for _ in range(25):
        _time.sleep(0.35)
        ans = _run_chrome_tab_js("midjourney.com", poll_js, timeout_s=5.0)
        if ans and ans != "PENDING":
            try:
                return json.loads(ans)
            except Exception:
                return None
    return None


async def import_browser_mj_asset(full_url: str, thumb_url: str = "") -> tuple[str, str, int]:
    """Fetch a full-resolution JPEG from cdn.midjourney.com inside the user's signed-in
    Midjourney tab (either via extension or cross-profile macOS Chrome bridge) and
    ingest it into Flowboard's local media cache.
    Returns (media_id, mime, byte_size).
    """
    data: Optional[dict] = None
    if flow_client.connected:
        res = await flow_client.ext_call(
            "mj_fetch_image",
            {"fullUrl": full_url, "thumbUrl": thumb_url},
            timeout=20.0,
        )
        if isinstance(res, dict) and not res.get("error") and isinstance(res.get("data"), dict):
            data = res["data"]
    if not data or not isinstance(data.get("b64"), str):
        data = await asyncio.to_thread(_macos_chrome_fetch_mj_image, full_url, thumb_url)
    if not data or data.get("error"):
        raise RuntimeError(f"Midjourney browser fetch failed: {(data or {}).get('error', 'no_tab')}")
    b64 = data.get("b64")
    if not isinstance(b64, str) or not b64:
        raise RuntimeError("Midjourney browser fetch returned empty payload")
    raw_bytes = base64.b64decode(b64)
    mime = str(data.get("mime") or "image/jpeg").split(";")[0].strip()
    if not mime.startswith("image/"):
        mime = "image/jpeg"
    mid = str(uuid.uuid4())
    media_service.ingest_inline_bytes(mid, raw_bytes, kind="image", mime=mime)
    return mid, mime, len(raw_bytes)


async def _try_browser_mj_generate(
    *,
    compiled: dict[str, str],
    variant_count: int,
    timeout_s: float = 95.0,
) -> Optional[tuple[list[str], list[dict], str]]:
    """Submit an imagine prompt directly into `#desktop_input_bar` on an open
    www.midjourney.com tab via the Chrome extension and ingest the resulting JPEGs.
    Returns (media_ids, media_entries, mj_job_id) or None if no MJ tab / timeout.
    """
    if not flow_client.connected:
        return None
    prompt_body = compiled["mj_command"].removeprefix("/imagine prompt: ").strip()
    res = await flow_client.ext_call(
        "mj_imagine",
        {
            "prompt": prompt_body,
            "count": max(1, min(variant_count, 4)),
            "timeoutMs": int(timeout_s * 1000),
        },
        timeout=timeout_s + 10.0,
    )
    if not isinstance(res, dict) or res.get("error"):
        return None
    data = res.get("data") if isinstance(res.get("data"), dict) else {}
    images = data.get("images")
    if not isinstance(images, list) or not images:
        return None
    media_ids: list[str] = []
    entries: list[dict] = []
    for item in images:
        if not isinstance(item, dict) or not isinstance(item.get("b64"), str):
            continue
        raw = base64.b64decode(item["b64"])
        mime = str(item.get("mime") or "image/jpeg")
        mid = str(uuid.uuid4())
        media_service.ingest_inline_bytes(mid, raw, kind="image", mime=mime)
        media_ids.append(mid)
        entries.append({"media_id": mid, "url": f"/media/{mid}"})
    if not media_ids:
        return None
    return media_ids, entries, str(data.get("jobId") or "")


async def run_midjourney_media(
    *,
    kind: str,
    prompt: str,
    aspect_ratio: Optional[str] = None,
    project_id: Optional[str] = None,
    source_media_id: Optional[str] = None,
    reference_media_ids: Optional[list[str]] = None,
    variant_count: int = 1,
    per_variant_prompts: Optional[list[str]] = None,
    paygate_tier: Optional[str] = None,
) -> tuple[dict, Optional[str]]:
    """Execute Midjourney V7 image generation or edit and ingest into local cache."""
    cfg = get_mj_settings()
    refs = list(reference_media_ids or [])
    if source_media_id and source_media_id not in refs:
        refs.insert(0, source_media_id)

    compiled = compile_mj_prompt(
        prompt=prompt,
        aspect_ratio=aspect_ratio,
        ref_media_ids=refs,
        version=cfg["version"],
    )

    # 1) External MJ Proxy / Gateway path if configured
    if cfg["api_base"]:
        try:
            gw = await _try_gateway_generate(
                api_base=cfg["api_base"],
                api_key=cfg["_raw_key"],
                compiled=compiled,
                variant_count=variant_count,
            )
            if gw:
                mids, entries = gw
                return (
                    {
                        "media_ids": mids,
                        "media_entries": entries,
                        "provider": "midjourney",
                        "mj_command": compiled["mj_command"],
                        "image_model": "MIDJOURNEY_V7",
                    },
                    None,
                )
        except Exception as exc:  # noqa: BLE001
            return {}, f"midjourney_gateway_failed: {exc}"[:200]

    # 2) Hybrid Canvas Mode: render with compiled MJ V7 raw cinema aesthetic via
    # Flow GEM_PIX_2 if connected, else dry_run synthesis so the canvas never blocks.
    pid = (project_id or effective_project_id() or "").strip()
    aspect = aspect_ratio or "IMAGE_ASPECT_RATIO_LANDSCAPE"
    if flow_client.connected and pid and is_valid_project_id(pid):
        try:
            tier = resolve_paygate_tier(paygate_tier or flow_client.paygate_tier)
            sdk = get_flow_sdk()
            if kind == "edit_image" and source_media_id:
                resp = await sdk.edit_image(
                    prompt=compiled["aesthetic_prompt"],
                    project_id=pid,
                    source_media_id=source_media_id,
                    ref_media_ids=[r for r in refs if r != source_media_id] or None,
                    aspect_ratio=aspect,
                    paygate_tier=tier,
                    image_model="NANO_BANANA_PRO",
                )
            else:
                resp = await sdk.gen_image(
                    prompt=compiled["aesthetic_prompt"],
                    project_id=pid,
                    aspect_ratio=aspect,
                    paygate_tier=tier,
                    ref_media_ids=refs or None,
                    variant_count=variant_count,
                    prompts=per_variant_prompts,
                    image_model="NANO_BANANA_PRO",
                )
            if not resp.get("error"):
                entries_with_urls = [
                    e for e in (resp.get("media_entries") or []) if isinstance(e, dict) and e.get("url")
                ]
                if entries_with_urls:
                    try:
                        media_service.ingest_urls(entries_with_urls)
                    except Exception:  # noqa: BLE001
                        logger.exception("auto-ingest from midjourney hybrid gen_image failed")
                resp["provider"] = "midjourney"
                resp["image_model"] = "MIDJOURNEY_V7"
                resp["mj_command"] = compiled["mj_command"]
                return resp, None
        except Exception as exc:  # noqa: BLE001
            logger.warning("MJ hybrid Flow path failed, falling back to local synth: %s", exc)

    from flowboard.services.dry_run_media import run_dry_run_media

    dry_res, dry_err = await run_dry_run_media(
        kind="edit_image" if kind == "edit_image" else "image",
        prompt=compiled["aesthetic_prompt"],
        aspect_ratio=aspect,
        source_media_ids=[source_media_id] if source_media_id else None,
        reference_media_ids=refs or None,
        variant_count=variant_count,
        per_variant_prompts=per_variant_prompts,
    )
    dry_res["provider"] = "midjourney"
    dry_res["image_model"] = "MIDJOURNEY_V7"
    dry_res["mj_command"] = compiled["mj_command"]
    return dry_res, dry_err
