"""
Stripe Checkout integration for the Live plan upgrade.

Honest status: this code implements the real Stripe Checkout Session +
webhook flow (direct REST calls via httpx - the official `stripe` Python
SDK isn't installable in this build sandbox, PyPI returned a 403 for it
specifically), but it has NOT been exercised against the real Stripe API.
This sandbox's own network egress can't reach api.stripe.com at all
(confirmed the same way api.massive.com was: a direct curl through the
sandbox's proxy gets a 403 CONNECT tunnel failure), and unlike the
Massive/Polygon key, there's no read-only WebFetch-shaped way to verify an
authenticated POST endpoint like Checkout Session creation from here either.

So: wire up STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / STRIPE_PRICE_ID_LIVE
in backend/.env against a real (or Stripe test-mode) account and treat the
Checkout creation + webhook path as needing a first real run in a normal
network environment before trusting it, the same way the Polygon connector
did before it was verified. Signature verification is covered by an offline
test (backend/test_billing_offline.py) using a hand-constructed payload, the
same way test_polygon_offline.py validates parsing without live network
access.

Until STRIPE_SECRET_KEY is set, `create_checkout_session` returns a "dev
checkout" URL instead - a local page that instantly flips the account's
plan with no payment processor involved, clearly labeled as a dev/test
bypass. This is what makes the full signup -> upgrade -> gated-dashboard
flow demoable end-to-end inside this sandbox.
"""
from __future__ import annotations

import hashlib
import hmac
import time
from typing import Optional
from urllib.parse import urlencode

import httpx

from . import config

STRIPE_API_BASE = "https://api.stripe.com/v1"

# Maps our internal plan name to the Stripe Price ID that should be charged.
# Desk is "contact us" (custom/negotiated), not self-serve checkout, so it's
# intentionally not in here.
PLAN_PRICE_IDS = {
    "live": config.STRIPE_PRICE_ID_LIVE,
}


class BillingError(Exception):
    pass


def stripe_configured() -> bool:
    return bool(config.STRIPE_SECRET_KEY and config.STRIPE_PRICE_ID_LIVE)


async def create_checkout_session(user_id: int, user_email: str, plan: str) -> str:
    """Returns a URL to redirect the browser to. Real Stripe Checkout if
    configured, otherwise a local dev-checkout page."""
    if plan not in PLAN_PRICE_IDS:
        raise BillingError(f"'{plan}' isn't a self-serve plan - use the Desk contact flow instead.")

    if not stripe_configured():
        # Dev bypass - see module docstring. `plan` and `user_id` are
        # trusted here only because dev-confirm re-checks the session's
        # logged-in user server-side before applying anything; this URL
        # itself grants nothing on its own.
        return f"/billing/dev-checkout/?plan={plan}"

    price_id = PLAN_PRICE_IDS[plan]
    body = {
        "mode": "subscription",
        "line_items[0][price]": price_id,
        "line_items[0][quantity]": "1",
        "client_reference_id": str(user_id),
        "customer_email": user_email,
        "success_url": f"{config.PUBLIC_BASE_URL}/billing/success/?session_id={{CHECKOUT_SESSION_ID}}",
        "cancel_url": f"{config.PUBLIC_BASE_URL}/billing/cancel/",
        "metadata[plan]": plan,
        "metadata[user_id]": str(user_id),
    }
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            f"{STRIPE_API_BASE}/checkout/sessions",
            data=body,
            auth=(config.STRIPE_SECRET_KEY, ""),
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    if resp.status_code >= 400:
        raise BillingError(f"Stripe rejected the checkout session request: {resp.status_code} {resp.text}")
    return resp.json()["url"]


def verify_webhook_signature(payload: bytes, sig_header: str, secret: str, tolerance_seconds: int = 300) -> dict:
    """Implements Stripe's documented webhook signature scheme:
    https://docs.stripe.com/webhooks#verify-manually

    The header looks like `t=<timestamp>,v1=<hex hmac>[,v0=...]`. We compute
    HMAC-SHA256 of "<timestamp>.<payload>" with the webhook signing secret
    and compare against the v1 signature(s) present, using a constant-time
    comparison, and reject stale timestamps to guard against replay.

    Raises ValueError on any failure. Returns the parsed JSON event on
    success - deliberately NOT parsed before verification, so a forged
    payload is never even deserialized as if it were trustworthy.
    """
    if not sig_header:
        raise ValueError("Missing Stripe-Signature header.")

    parts = dict(item.split("=", 1) for item in sig_header.split(",") if "=" in item)
    timestamp = parts.get("t")
    signature = parts.get("v1")
    if not timestamp or not signature:
        raise ValueError("Malformed Stripe-Signature header.")

    if abs(time.time() - int(timestamp)) > tolerance_seconds:
        raise ValueError("Webhook timestamp outside tolerance - possible replay.")

    signed_payload = f"{timestamp}.".encode("utf-8") + payload
    expected = hmac.new(secret.encode("utf-8"), signed_payload, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise ValueError("Signature mismatch.")

    import json
    return json.loads(payload)


def plan_from_webhook_event(event: dict) -> Optional[tuple]:
    """Given a verified Stripe event dict, returns (user_id, plan) if this
    event should upgrade an account, else None. Only handles
    checkout.session.completed - the minimal event needed for this
    self-serve, single-tier flow."""
    if event.get("type") != "checkout.session.completed":
        return None
    session = event.get("data", {}).get("object", {})
    metadata = session.get("metadata", {}) or {}
    user_id = metadata.get("user_id") or session.get("client_reference_id")
    plan = metadata.get("plan")
    if not user_id or not plan:
        return None
    return int(user_id), plan
