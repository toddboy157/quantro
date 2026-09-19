"""
Central configuration, read from environment variables (with a .env file
loaded if present). Copy backend/.env.example to backend/.env and edit it
to switch providers or the underlying universe.
"""
import os
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except ImportError:
    pass  # python-dotenv is optional; env vars can be set directly instead


def _bool(name: str, default: bool) -> bool:
    val = os.getenv(name)
    if val is None:
        return default
    return val.strip().lower() in ("1", "true", "yes", "on")


# "mock" runs entirely on simulated data (no API key needed) - this is the
# default so the app runs out of the box. Set to "polygon" once you have a
# Massive/Polygon.io API key to switch to live data.
DATA_PROVIDER = os.getenv("DATA_PROVIDER", "mock").strip().lower()

POLYGON_API_KEY = os.getenv("POLYGON_API_KEY", "").strip()

# How often (seconds) the backend pulls a fresh chain and recomputes GEX.
# The frontend polls at roughly this same cadence. 2s is a reasonable
# default for a prototype; real vendor rate limits may force this higher.
REFRESH_INTERVAL_SECONDS = float(os.getenv("REFRESH_INTERVAL_SECONDS", "2"))

# Comma-separated list of underlyings to track. Keep this list short while
# prototyping - each symbol adds a full chain fetch + recompute per tick.
UNDERLYINGS = [
    s.strip().upper()
    for s in os.getenv("UNDERLYINGS", "SPX,SPY,QQQ,AAPL,NVDA,MSFT,TSLA,AMZN").split(",")
    if s.strip()
]

# Risk-free rate used in the Black-Scholes Greeks calc. Fine to hardcode /
# update occasionally rather than source live - it has a small effect on
# gamma relative to spot/strike/IV/T.
RISK_FREE_RATE = float(os.getenv("RISK_FREE_RATE", "0.045"))

DB_PATH = os.getenv("DB_PATH", str(Path(__file__).resolve().parent.parent / "quantro.db"))

HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))

# --- Auth / billing -------------------------------------------------------

# Signs the session cookie (Starlette's SessionMiddleware). This MUST be set
# to a real secret in production - a random one is generated per-process if
# missing, which is fine for local prototyping (sessions just don't survive
# a restart) but wrong for anything deployed with more than one worker.
import secrets as _secrets  # noqa: E402

SECRET_KEY = os.getenv("SECRET_KEY", "").strip() or _secrets.token_hex(32)

# How many underlyings a free-plan account (or an anonymous visitor) can
# pull positioning data for at once - mirrors the "Up to 3 underlyings"
# line on the pricing page. None/"live"/"desk" plans are unlimited.
FREE_PLAN_UNDERLYING_LIMIT = int(os.getenv("FREE_PLAN_UNDERLYING_LIMIT", "3"))

# Real Stripe Checkout integration. Leave both unset to run in "dev
# checkout" mode: clicking Upgrade instantly flips the account's plan with
# no real payment processor involved, clearly labeled as such in the UI -
# this sandbox's own network egress can't reach api.stripe.com to test a
# live integration end-to-end (see billing.py's module docstring), so this
# is what lets the full signup -> upgrade -> gated-access flow be verified
# here. Setting STRIPE_SECRET_KEY switches on the real Checkout Session
# creation + webhook verification code path.
STRIPE_SECRET_KEY = os.getenv("STRIPE_SECRET_KEY", "").strip()
STRIPE_WEBHOOK_SECRET = os.getenv("STRIPE_WEBHOOK_SECRET", "").strip()
STRIPE_PRICE_ID_LIVE = os.getenv("STRIPE_PRICE_ID_LIVE", "").strip()

# Used to build absolute success_url/cancel_url for Stripe Checkout. Update
# this to your real domain once deployed.
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", f"http://localhost:{PORT}").rstrip("/")
