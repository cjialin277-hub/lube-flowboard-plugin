"""User identity and plan, surfaced from the extension.

The extension used to fetch Google's ``/oauth2/v2/userinfo`` as soon as it
captured a Bearer token and push the profile here over WebSocket.

Since Flow moved to flow.google.com there is no Bearer to capture, so that
never fires: **identity is not obtainable on the current transport**. The
paygate tier isn't either — it came from ``/v1/credits``, same token — so it
is now declared in config instead. This route reports the effective tier and
says which of the two it came from, rather than reporting ``null`` and letting
the AccountPanel imply the user should go open a Flow tab to fix it.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from flowboard import config
from flowboard.services.flow_client import flow_client
from flowboard.services.flow_project import (
    effective_project_id,
    is_onboarding_completed,
    paygate_tier_setting,
    project_setting,
    set_onboarding_completed,
    set_paygate_tier_override,
)
from flowboard.services.flow_sdk import resolve_paygate_tier
from flowboard.services.llm import secrets as llm_secrets

router = APIRouter(prefix="/api/auth", tags=["auth"])


# Test hook kept for backward compatibility with existing test imports.
# The DB-tier-fallback cache it used to reset is gone — see the
# `_last_observed_paygate_tier_from_db` removal below.
def _reset_db_tier_cache_for_tests() -> None:
    """No-op — preserved so existing tests' `from .auth import
    _reset_db_tier_cache_for_tests` doesn't break. Will be removed in
    v1.2 along with the test imports."""
    return


@router.get("/me")
def get_me() -> dict:
    """Return the cached Google profile + paygate tier from the live
    extension signal only.

    The previous version had a "fall back to last observed tier in DB"
    branch that read `request.params.paygate_tier` from the most recent
    gen request. That branch was a footgun: the worker used to default
    to `PAYGATE_TIER_ONE` when no live tier was present, and that wrong
    value got stamped into request.params, polluting the DB. The next
    /api/auth/me call would then read the polluted row and report Pro
    forever — even for Ultra users — until a fresh known-good gen
    happened to overwrite the fallback row.

    Now: no bogus tier can get into the DB, because the tier is resolved from
    config rather than guessed per request (see
    `flow_sdk.resolve_paygate_tier`), and an unrecognised value fails loud at
    dispatch.

    `paygate_tier` is the tier generation will actually use, so the panel shows
    the real checkpoint. `paygate_tier_source` says where it came from:
    `"extension"` if a live signal was somehow available, `"configured"`
    otherwise — which is the normal case now.

    `identity_available` is False when the transport cannot yield a profile at
    all. Without it the AccountPanel would poll /me every five seconds forever
    waiting for an email that is never coming.
    """
    info = flow_client.user_info or {}
    live_tier = flow_client.paygate_tier
    try:
        effective_tier = resolve_paygate_tier(live_tier)
        tier_error = None
    except ValueError as exc:
        # A misconfigured FLOWBOARD_PAYGATE_TIER. Report it here rather than
        # only at dispatch, so the panel can say why generation will refuse.
        effective_tier, tier_error = None, str(exc)
    return {
        "email": info.get("email"),
        "name": info.get("name"),
        "picture": info.get("picture"),
        "verified_email": info.get("verified_email"),
        "paygate_tier": effective_tier,
        "paygate_tier_source": "extension" if live_tier else "configured",
        "paygate_tier_error": tier_error,
        # Identity and credits both rode on the Bearer token that
        # flow.google.com no longer mints. Genuinely unknown, not pending.
        "identity_available": flow_client.user_info is not None,
        "sku": flow_client.sku,
        "credits": flow_client.credits,
    }


@router.post("/logout")
async def logout() -> dict:
    """Disconnect the extension's identity from the agent.

    Clears the agent-side cached profile + tier so /api/auth/me
    returns null fields immediately. Sends a `logout` message to the
    extension over WS so it drops its own in-memory cachedUserInfo +
    flowKey — the next time the user wants to reconnect they pick up
    fresh credentials, not stale ones.

    The extension's WS connection itself stays open. We don't tear it
    down because the user might log back in with a different account
    and we want to be ready to push the new identity.
    """
    extension_notified = await flow_client.notify({"type": "logout"})
    flow_client.clear_extension()
    return {
        "ok": True,
        "extension_notified": extension_notified,
    }


@router.post("/scan")
async def scan_extension() -> dict:
    """Diagnostic + nudge for the extension connection.

    Returns a snapshot of the connection state so the frontend can
    decide what to surface to the user, and (when the WS is open but
    the userinfo cache is empty) asks the extension to re-fetch its
    Google profile.

    Cases the frontend cares about:
      - extension_connected=False: Chrome extension isn't running /
        installed / enabled. The frontend shows install instructions.
      - extension_connected=True + has_user_info=False: WS is open but
        Google /oauth2/v2/userinfo hasn't completed yet (or token
        rotated and the cache cleared). We send a `please_resend_userinfo`
        nudge — the extension's handler will re-call its
        fetchAndPushUserInfo flow.
      - extension_connected=True + has_user_info=True + has_tier=False:
        Token captured but the authoritative /v1/credits fetch hasn't
        landed yet (or it failed transiently). The scan handler retries
        the fetch synchronously below so the response reflects the
        post-fetch state.
      - All three present: nothing to do; frontend re-polls /me to
        refresh the AccountPanel.
    """
    nudged = False
    if flow_client.connected and flow_client.user_info is None:
        nudged = await flow_client.notify({"type": "please_resend_userinfo"})
    # If tier is still null but we have a token, do an authoritative
    # /v1/credits fetch right now. Synchronous (not fire-and-forget)
    # so the response reflects the post-fetch state — UI gets a single
    # round-trip instead of having to re-poll /me.
    tier_fetched = False
    if flow_client.paygate_tier is None:
        tier_fetched = await flow_client.fetch_paygate_tier()
    return {
        "extension_connected": flow_client.connected,
        "has_user_info": flow_client.user_info is not None,
        "has_paygate_tier": flow_client.paygate_tier is not None,
        "userinfo_nudged": nudged,
        "tier_fetched": tier_fetched,
    }


class PaygateTierBody(BaseModel):
    paygate_tier: Optional[str] = Field(default=None, max_length=64)


class OnboardingCompleteBody(BaseModel):
    completed: bool = True


@router.get("/onboarding")
async def get_onboarding_status() -> dict:
    """Unified snapshot for the first-run 3-step friend onboarding wizard."""
    from flowboard.services.midjourney_media import get_mj_settings

    proj = project_setting()
    tier = paygate_tier_setting()
    llm_ok = llm_secrets.is_active_providers_configured()
    completed = is_onboarding_completed()
    has_project = bool(effective_project_id())

    # Existing fully configured installs (e.g. Lube's own Mac) stay undisturbed;
    # fresh friend installs with no project or no LLM immediately open the wizard.
    needs_onboarding = (not completed) and (not (has_project and llm_ok))

    tabs_data: dict = {}
    if flow_client.connected:
        try:
            res = await flow_client.ext_call("get_multimodal_tabs", {}, timeout=4.0)
            if isinstance(res, dict) and isinstance(res.get("data"), dict):
                tabs_data = res["data"]
        except Exception:
            tabs_data = {}

    flow_tab = tabs_data.get("flow") or {}
    mj_tab = tabs_data.get("midjourney") or {}
    muse_tab = tabs_data.get("muse") or {}
    mj_cfg = get_mj_settings()

    return {
        "needs_onboarding": needs_onboarding,
        "completed": completed,
        "extension_connected": flow_client.connected,
        "extension_dir": str((config.ROOT / "extension").resolve()),
        "flow_project_id": proj.get("flow_project_id"),
        "flow_project_source": proj.get("source"),
        "paygate_tier": tier.get("paygate_tier"),
        "paygate_tier_source": tier.get("source"),
        "llm_configured": llm_ok,
        "flow_tab_connected": bool(flow_tab.get("connected")),
        "flow_tab_url": flow_tab.get("url") or "",
        "mj_tab_connected": bool(mj_tab.get("connected")),
        "mj_api_base": mj_cfg.get("api_base") or "",
        "mj_api_key_set": bool(mj_cfg.get("api_key_set")),
        "mj_version": mj_cfg.get("version") or "7",
        "muse_tab_connected": bool(muse_tab.get("connected")),
    }


@router.put("/paygate-tier")
def update_paygate_tier(body: PaygateTierBody) -> dict:
    """Switch Google Flow plan (Ultra / Pro) at runtime without editing .env."""
    try:
        res = set_paygate_tier_override(body.paygate_tier)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"ok": True, **res}


@router.post("/onboarding/complete")
def complete_onboarding(body: OnboardingCompleteBody) -> dict:
    """Persist whether the user has finished or dismissed the first-run wizard."""
    done = set_onboarding_completed(bool(body.completed))
    return {"ok": True, "completed": done}
