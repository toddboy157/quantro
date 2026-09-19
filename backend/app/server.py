"""
The web layer: a background loop refreshes every configured underlying on a
timer and caches the latest computed GEX result in memory; REST endpoints
serve that cache (and a short SQLite-backed history) to the frontend.

Note on live updates - this build environment's network egress does not
allow installing the `websockets`/`wsproto` packages uvicorn needs to serve
WebSocket connections, so this prototype uses short-interval HTTP polling
from the frontend instead of a push socket. Functionally it looks and feels
live at a 1-2s refresh cadence. To upgrade to a real push architecture
later: `pip install websockets`, add a WebSocketRoute here that broadcasts
`_latest[symbol]` whenever the refresh loop updates it, and switch
frontend/app.js from setInterval+fetch to a WebSocket client - the calc
engine and provider layer underneath don't change at all.

Also serves account/billing endpoints (signup, login, Stripe Checkout) that
gate access to the underlying universe by plan - see accounts.py and
billing.py for the details and their honest caveats about what could and
couldn't be verified inside this build sandbox.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from pathlib import Path
from typing import Dict, List, Optional

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.sessions import SessionMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, RedirectResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import billing, config
from .accounts import AccountStore, EmailAlreadyRegistered, InvalidCredentials, User
from .gex_engine import compute_gex
from .providers import get_provider
from .storage import SnapshotStore

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("quantro")

FRONTEND_ROOT = Path(__file__).resolve().parent.parent.parent / "frontend"
LANDING_DIR = FRONTEND_ROOT / "landing"
APP_DIR = FRONTEND_ROOT / "app"

_latest: Dict[str, dict] = {}
_errors: Dict[str, str] = {}
_provider = None
_store: Optional[SnapshotStore] = None
_accounts: Optional[AccountStore] = None
_refresh_task: Optional[asyncio.Task] = None


async def _refresh_loop():
    global _provider, _store
    # This init step used to be able to fail totally silently: asyncio.
    # create_task() is fire-and-forget, so an exception raised here (e.g. a
    # bad DATA_PROVIDER, a missing/invalid API key, a DB_PATH the volume
    # can't write to yet) used to kill this whole coroutine with nothing
    # printed anywhere - _latest and _errors both stayed empty forever, and
    # every /api/gex/<symbol> call just returned a generic "not ready yet,
    # try again shortly" 503 with no way to tell what actually went wrong.
    # Retrying with the same cadence as the main loop (rather than giving up
    # after one attempt) also means a transient problem at boot - the
    # volume mounting a beat late, a flaky first request to the provider -
    # heals itself on its own instead of requiring a manual redeploy.
    while _provider is None or _store is None:
        try:
            _provider = get_provider(config.DATA_PROVIDER, underlyings=config.UNDERLYINGS)
            _store = SnapshotStore(config.DB_PATH)
        except Exception as exc:
            log.exception("Refresh loop failed to start (provider/store init) - retrying in %ss", config.REFRESH_INTERVAL_SECONDS)
            for symbol in config.UNDERLYINGS:
                _errors[symbol] = f"data refresh never started: {exc}"
            _provider = None
            _store = None
            await asyncio.sleep(config.REFRESH_INTERVAL_SECONDS)
    log.info(
        "Starting refresh loop: provider=%s underlyings=%s interval=%ss",
        config.DATA_PROVIDER, config.UNDERLYINGS, config.REFRESH_INTERVAL_SECONDS,
    )
    while True:
        for symbol in config.UNDERLYINGS:
            try:
                chain = await _provider.get_chain(symbol)
                result = compute_gex(chain, config.RISK_FREE_RATE)
                result["provider"] = config.DATA_PROVIDER
                _latest[symbol] = result
                _errors.pop(symbol, None)
                _store.write(result)
            except Exception as exc:  # noqa: BLE001 - one bad symbol shouldn't kill the loop
                log.exception("Failed to refresh %s", symbol)
                _errors[symbol] = str(exc)
        await asyncio.sleep(config.REFRESH_INTERVAL_SECONDS)


def _log_refresh_task_result(task: "asyncio.Task") -> None:
    """Belt-and-braces alongside the try/except inside _refresh_loop itself:
    if that loop ever exits with an exception anyway (a bug in this function,
    not just the provider/store init this was originally written for), this
    guarantees it's logged instead of vanishing the way asyncio.create_task's
    fire-and-forget tasks otherwise can - see the loop's own comment for the
    silent-503 bug this class of failure caused."""
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        log.error("Refresh loop task ended unexpectedly", exc_info=exc)


# --------------------------------------------------------------------------
# Plan / gating helpers
# --------------------------------------------------------------------------

def _current_user(request: Request) -> Optional[User]:
    user_id = request.session.get("user_id")
    if user_id is None or _accounts is None:
        return None
    return _accounts.get_user(user_id)


def _plan_for_request(request: Request) -> str:
    user = _current_user(request)
    return user.plan if user else "free"


def _allowed_underlyings(plan: str) -> List[str]:
    if plan in ("live", "desk"):
        return list(config.UNDERLYINGS)
    return config.UNDERLYINGS[: config.FREE_PLAN_UNDERLYING_LIMIT]


def _locked_underlyings(plan: str) -> List[str]:
    allowed = set(_allowed_underlyings(plan))
    return [s for s in config.UNDERLYINGS if s not in allowed]


# --------------------------------------------------------------------------
# Positioning data API (now plan-gated)
# --------------------------------------------------------------------------

async def list_underlyings(request):
    plan = _plan_for_request(request)
    user = _current_user(request)
    return JSONResponse(
        {
            "provider": config.DATA_PROVIDER,
            "underlyings": config.UNDERLYINGS,
            "refresh_interval_seconds": config.REFRESH_INTERVAL_SECONDS,
            "plan": plan,
            "allowed_underlyings": _allowed_underlyings(plan),
            "locked_underlyings": _locked_underlyings(plan),
            "email": user.email if user else None,
        }
    )


def _check_symbol_access(request: Request, symbol: str):
    """Returns a JSONResponse to short-circuit with, or None if access is fine."""
    if symbol not in config.UNDERLYINGS:
        return JSONResponse({"error": f"{symbol} is not in the configured universe"}, status_code=404)
    plan = _plan_for_request(request)
    if symbol not in _allowed_underlyings(plan):
        return JSONResponse(
            {
                "error": f"{symbol} requires the Live plan on your current ({plan}) access.",
                "upgrade_required": True,
            },
            status_code=403,
        )
    return None


async def get_gex(request):
    symbol = request.path_params["symbol"].upper()
    denied = _check_symbol_access(request, symbol)
    if denied:
        return denied
    if symbol in _errors and symbol not in _latest:
        return JSONResponse({"error": _errors[symbol]}, status_code=502)
    result = _latest.get(symbol)
    if result is None:
        return JSONResponse({"error": "not ready yet, try again shortly"}, status_code=503)
    return JSONResponse(result)


async def get_gex_all(request):
    """Bulk fetch for the multi-underlying comparison view - one round trip
    instead of N, using the same in-memory cache the per-symbol endpoint
    reads from. Locked symbols (free plan over its underlying limit) come
    back listed separately rather than silently omitted, so the frontend
    can render them as upgrade prompts instead of just not showing up."""
    plan = _plan_for_request(request)
    allowed = _allowed_underlyings(plan)
    results = {}
    for symbol in allowed:
        result = _latest.get(symbol)
        if result is not None:
            results[symbol] = result
    return JSONResponse({"plan": plan, "allowed_underlyings": allowed, "locked_underlyings": _locked_underlyings(plan), "results": results})


async def get_history(request):
    symbol = request.path_params["symbol"].upper()
    denied = _check_symbol_access(request, symbol)
    if denied:
        return denied
    limit = int(request.query_params.get("limit", 200))
    history = _store.history(symbol, limit=limit) if _store else []
    return JSONResponse({"underlying": symbol, "history": history})


async def get_candles(request):
    symbol = request.path_params["symbol"].upper()
    denied = _check_symbol_access(request, symbol)
    if denied:
        return denied
    limit = int(request.query_params.get("limit", 120))
    bucket_seconds = int(request.query_params.get("bucket_seconds", 60))
    candles = _store.candles(symbol, bucket_seconds=bucket_seconds, limit=limit) if _store else []
    return JSONResponse({"underlying": symbol, "bucket_seconds": bucket_seconds, "candles": candles})


async def health(request):
    # `errors` surfaces whatever the background refresh loop last hit per
    # symbol (including "data refresh never started: ..." if the loop's
    # provider/store init is failing) directly in this JSON response, so
    # diagnosing a stuck "not ready yet" symbol doesn't require digging
    # through Railway's log viewer at all - just open /api/health.
    return JSONResponse({
        "status": "ok",
        "time": time.time(),
        "tracking": list(_latest.keys()),
        "errors": _errors,
    })


async def redirect_to_app(request):
    # StaticFiles Mount("/app", ...) only matches "/app/..." - a bare "/app"
    # (no trailing slash, e.g. someone typing the URL by hand or clicking a
    # link authored as href="/app") 404s without this explicit redirect.
    return RedirectResponse(url="/app/")


# --------------------------------------------------------------------------
# Auth API
# --------------------------------------------------------------------------

def _user_json(user: Optional[User]) -> dict:
    if user is None:
        return {"authenticated": False, "email": None, "plan": "free"}
    return {"authenticated": True, "email": user.email, "plan": user.plan}


async def auth_me(request):
    return JSONResponse(_user_json(_current_user(request)))


async def auth_signup(request):
    body = await request.json()
    email = (body.get("email") or "").strip()
    password = body.get("password") or ""
    try:
        user = _accounts.create_user(email, password)
    except EmailAlreadyRegistered as exc:
        return JSONResponse({"error": str(exc)}, status_code=409)
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    request.session["user_id"] = user.id
    return JSONResponse(_user_json(user))


async def auth_login(request):
    body = await request.json()
    email = (body.get("email") or "").strip()
    password = body.get("password") or ""
    try:
        user = _accounts.verify_login(email, password)
    except InvalidCredentials as exc:
        return JSONResponse({"error": str(exc)}, status_code=401)
    request.session["user_id"] = user.id
    return JSONResponse(_user_json(user))


async def auth_logout(request):
    request.session.clear()
    return JSONResponse({"authenticated": False})


# --------------------------------------------------------------------------
# Billing API
# --------------------------------------------------------------------------

async def billing_checkout(request):
    user = _current_user(request)
    if user is None:
        return JSONResponse({"error": "Log in first."}, status_code=401)
    body = await request.json()
    plan = (body.get("plan") or "").strip().lower()
    try:
        url = await billing.create_checkout_session(user.id, user.email, plan)
    except billing.BillingError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    return JSONResponse({"url": url})


async def billing_dev_confirm(request):
    """Only meaningful (and only reachable from the UI) when Stripe isn't
    configured - see billing.py. Still requires a logged-in session, so it
    can't be used to grant a plan to an arbitrary account."""
    if billing.stripe_configured():
        return JSONResponse({"error": "Dev checkout is disabled - real Stripe billing is configured."}, status_code=400)
    user = _current_user(request)
    if user is None:
        return JSONResponse({"error": "Log in first."}, status_code=401)
    body = await request.json()
    plan = (body.get("plan") or "").strip().lower()
    if plan not in ("live",):
        return JSONResponse({"error": f"'{plan}' isn't a self-serve dev-checkout plan."}, status_code=400)
    _accounts.set_plan(user.id, plan)
    log.info("DEV CHECKOUT: account %s upgraded to %s (no real payment processed)", user.email, plan)
    return JSONResponse({"plan": plan})


async def billing_webhook(request):
    payload = await request.body()
    sig_header = request.headers.get("stripe-signature", "")
    if not config.STRIPE_WEBHOOK_SECRET:
        return JSONResponse({"error": "Webhook secret not configured."}, status_code=400)
    try:
        event = billing.verify_webhook_signature(payload, sig_header, config.STRIPE_WEBHOOK_SECRET)
    except ValueError as exc:
        log.warning("Rejected Stripe webhook: %s", exc)
        return JSONResponse({"error": str(exc)}, status_code=400)

    resolved = billing.plan_from_webhook_event(event)
    if resolved:
        user_id, plan = resolved
        _accounts.set_plan(user_id, plan)
        log.info("Stripe webhook: account id=%s upgraded to %s", user_id, plan)
    return JSONResponse({"received": True})


@contextlib.asynccontextmanager
async def lifespan(app: Starlette):
    global _refresh_task, _accounts
    _accounts = AccountStore(config.DB_PATH)
    _refresh_task = asyncio.create_task(_refresh_loop())
    _refresh_task.add_done_callback(_log_refresh_task_result)
    try:
        yield
    finally:
        if _refresh_task:
            _refresh_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await _refresh_task
        if _provider:
            await _provider.close()


routes = [
    Route("/api/health", health),
    Route("/api/underlyings", list_underlyings),
    Route("/api/gex/{symbol}", get_gex),
    Route("/api/gex-all", get_gex_all),
    Route("/api/history/{symbol}", get_history),
    Route("/api/candles/{symbol}", get_candles),
    Route("/api/auth/me", auth_me),
    Route("/api/auth/signup", auth_signup, methods=["POST"]),
    Route("/api/auth/login", auth_login, methods=["POST"]),
    Route("/api/auth/logout", auth_logout, methods=["POST"]),
    Route("/api/billing/checkout", billing_checkout, methods=["POST"]),
    Route("/api/billing/dev-confirm", billing_dev_confirm, methods=["POST"]),
    Route("/api/billing/webhook", billing_webhook, methods=["POST"]),
    Route("/app", redirect_to_app),
    Mount("/app", app=StaticFiles(directory=str(APP_DIR), html=True), name="app"),
    Mount("/", app=StaticFiles(directory=str(LANDING_DIR), html=True), name="landing"),
]

app = Starlette(
    routes=routes,
    lifespan=lifespan,
    middleware=[
        Middleware(SessionMiddleware, secret_key=config.SECRET_KEY, same_site="lax", session_cookie="quantro_session"),
    ],
)
