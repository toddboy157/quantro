"""
Offline verification of the Stripe webhook signature check and event
handling in app/billing.py - no network access needed (and none is
available to api.stripe.com from this sandbox anyway; see billing.py's
module docstring for why this is the best verification possible here).

Constructs a webhook payload and signs it exactly the way Stripe's docs
say Stripe itself signs one, then feeds it through verify_webhook_signature
+ plan_from_webhook_event the same way server.py's webhook route would.

Run: python3 test_billing_offline.py
"""
import hashlib
import hmac
import json
import time

from app.billing import plan_from_webhook_event, verify_webhook_signature

WEBHOOK_SECRET = "whsec_test_secret_for_offline_verification_only"


def make_signed_payload(event: dict, secret: str, timestamp: int) -> tuple:
    payload = json.dumps(event).encode("utf-8")
    signed_payload = f"{timestamp}.".encode("utf-8") + payload
    sig = hmac.new(secret.encode("utf-8"), signed_payload, hashlib.sha256).hexdigest()
    header = f"t={timestamp},v1={sig}"
    return payload, header


def main():
    event = {
        "type": "checkout.session.completed",
        "data": {
            "object": {
                "client_reference_id": "42",
                "metadata": {"user_id": "42", "plan": "live"},
            }
        },
    }
    now = int(time.time())
    payload, header = make_signed_payload(event, WEBHOOK_SECRET, now)

    # 1. Correctly signed payload verifies and parses.
    verified = verify_webhook_signature(payload, header, WEBHOOK_SECRET)
    assert verified["type"] == "checkout.session.completed"
    result = plan_from_webhook_event(verified)
    assert result == (42, "live"), f"expected (42, 'live'), got {result}"
    print("PASS: correctly signed webhook verifies and resolves to (user_id=42, plan='live')")

    # 2. Tampered payload (attacker flips the plan) must fail verification.
    tampered = payload.replace(b'"plan": "live"', b'"plan": "desk"')
    try:
        verify_webhook_signature(tampered, header, WEBHOOK_SECRET)
        raise AssertionError("tampered payload should NOT verify")
    except ValueError:
        print("PASS: tampered payload correctly rejected (signature mismatch)")

    # 3. Wrong secret (e.g. a stale/rotated key) must fail verification.
    try:
        verify_webhook_signature(payload, header, "whsec_wrong_secret")
        raise AssertionError("wrong secret should NOT verify")
    except ValueError:
        print("PASS: wrong webhook secret correctly rejected")

    # 4. Stale timestamp (replay of an old, otherwise-valid request) must fail.
    stale_payload, stale_header = make_signed_payload(event, WEBHOOK_SECRET, now - 10_000)
    try:
        verify_webhook_signature(stale_payload, stale_header, WEBHOOK_SECRET)
        raise AssertionError("stale timestamp should NOT verify")
    except ValueError:
        print("PASS: stale/replayed timestamp correctly rejected")

    print("\nALL ASSERTIONS PASSED")


if __name__ == "__main__":
    main()
