# Quantro — Dealer Positioning Prototype

A working end-to-end scaffold of the "dealer wall" / gamma exposure product scoped in `quantro-build-scope.md`: ingest an options chain → compute Greeks → aggregate into GEX/DEX → serve it → chart it live. Runs today on simulated data, with a clean seam to plug in a real vendor.

**Want this running on the public internet, not just your laptop?** See `DEPLOY.md` for a step-by-step Railway deployment (Dockerfile included, tested end-to-end from a clean production-shaped directory - real config goes in as platform environment variables, never baked into the image).

## What's here

```
backend/
  app/
    config.py            - all settings, read from .env
    greeks.py             - vectorized Black-Scholes gamma/delta (numpy)
    providers/
      base.py             - the interface every data source implements
      mock_provider.py    - simulated live chain (default, no API key needed)
      polygon_provider.py - Massive/Polygon.io connector (needs an API key; see caveat below)
    gex_engine.py          - turns a chain into GEX by strike/expiry, walls, zero-gamma level
    storage.py             - SQLite snapshot history + OHLC candle bucketing (swap for TimescaleDB later, see build-scope doc)
    accounts.py             - user signup/login + password hashing (SQLite-backed)
    billing.py               - Stripe Checkout + webhook integration, with a dev-checkout fallback - see caveats below
    server.py              - Starlette app: refresh loop + REST API + auth/billing routes + serves both frontends
  run.py                   - `python run.py` starts everything on :8000
  requirements.txt
  .env.example             - copy to .env to configure
  test_polygon_offline.py  - regression test replaying real captured Polygon/Massive payloads (no network needed)
  verify_live_key_refresh.py - re-verifies the connector against a FRESH real snapshot (confirms the key/plan are still active)
  test_accounts_offline.py - signup/login/plan-upgrade round-trip test (no network needed)
  test_billing_offline.py - Stripe webhook signature verification test, incl. tampered/replayed payloads (no network needed)
  demo_replay_real_data.py - serves a REAL captured SPY chain (102 contracts, 2026-09-14) through the actual app - see below
  tests_data/              - the real captured payloads used by the files above
frontend/
  landing/
    index.html, style.css  - marketing homepage (served at `/`): hero, feature grid, how-it-works,
                              a "positioning data only" disclaimer band, and a pricing teaser
    methodology/index.html - deep-dive on the GEX/DEX formulas, walls, and zero-gamma calc (`/methodology/`)
    pricing/index.html     - full pricing page with a plan comparison table and a real "Upgrade to Live" flow (`/pricing/`)
    faq/index.html         - frequently asked questions, native <details> accordion, no JS (`/faq/`)
    legal/index.html       - risk disclaimer / terms of use (`/legal/`)
    account/login/, account/signup/ - auth forms (`/account/login/`, `/account/signup/`)
    billing/dev-checkout/, billing/success/, billing/cancel/ - the checkout flow's landing pages
    auth-client.js          - shared fetch client for /api/auth/* and /api/billing/*, used by every page on the site
  app/
    index.html, app.js, charts.js, style.css - the dependency-free live dashboard (served at `/app`,
                              no CDN, no build step), headlined by a candlestick chart with the
                              call wall / put wall / zero-gamma level drawn on top of price, gated by plan
    compare/index.html, compare.js - multi-underlying comparison view (`/app/compare/`): every tracked
                              underlying's spot/net GEX/walls/zero-gamma side by side, plus a comparison bar chart
```

`server.py` mounts the marketing site (including all the sub-pages above) at `/`, the dashboard at `/app`, and leaves `/api/*` unchanged - so linking to the dashboard from anywhere is just `href="/app"`. The sub-pages are plain subdirectories under `frontend/landing/` (and `/app/compare/` under `frontend/app/`), so Starlette's static-file serving handles them (and the bare-path → trailing-slash redirect) automatically - no extra routes needed in `server.py` per page.

## Run it

```bash
cd backend
pip install -r requirements.txt
cp .env.example .env
python run.py
```

Then open **http://localhost:8000** for the marketing landing page, or go straight to **http://localhost:8000/app** for the live dashboard — you'll see live (simulated) dealer positioning for SPX/SPY/QQQ/AAPL/NVDA/MSFT/TSLA/AMZN, refreshing every 2 seconds: spot price, net GEX, call wall / put wall, the zero-gamma flip level, a headline candlestick chart with the walls and zero-gamma drawn over price, a GEX-by-strike histogram, GEX-by-expiry, and a short net-GEX/spot history chart.

The candlestick chart is built from a new `/api/candles/{symbol}` endpoint that buckets the raw spot ticks `storage.py` already logs into OHLC candles (`SnapshotStore.candles()`) - no new data feed needed, just a different aggregation of the same history table.

It runs on **simulated data by default** — no signup, no API key, no cost. The mock provider (`app/providers/mock_provider.py`) is deliberately modeled on how the real market actually behaves: open interest only regenerates every ~2 minutes and IV every ~30s (exchanges publish official OI once per session, real vendors don't refresh it every tick either), while spot random-walks every 2s. That's why the wall levels visibly move between ticks even though the underlying OI/IV backdrop is mostly static — that's the real dynamic, not a shortcut taken for the demo.

## Multi-underlying comparison view

**http://localhost:8000/app/compare/** shows every tracked underlying's spot, net GEX, call wall, put wall, and zero-gamma side by side in one table, plus a bar chart comparing net GEX across the whole universe at a glance - useful for spotting which names are sitting in a negative-gamma pocket right now without flipping through the main dashboard's dropdown one symbol at a time. It's powered by a new bulk `/api/gex-all` endpoint that reads from the same in-memory cache the per-symbol endpoint uses (one request instead of N), and respects the same plan-based gating described below - a free-plan account sees its unlocked underlyings compared normally and its locked ones listed with an upgrade link instead of silently missing.

## Accounts, plans, and billing

The site now has real accounts and plan-based gating, not just marketing copy:

- **Free/anonymous visitors and free-plan accounts** can see the first `FREE_PLAN_UNDERLYING_LIMIT` (3 by default) underlyings from your configured universe - matching the "Up to 3 underlyings" line on the pricing page. No signup is required for this tier at all.
- **Signing up** (`/account/signup/`) creates a real account (email + password, hashed with `hashlib.pbkdf2_hmac` - no bcrypt dependency needed) in a `users` table in the same SQLite file as the positioning data. Sessions are a signed cookie via Starlette's `SessionMiddleware` (needs the `itsdangerous` package, now in `requirements.txt`).
- **Upgrading to Live** (the Pricing page's "Upgrade to Live" button) calls `/api/billing/checkout`, which either redirects to real Stripe Checkout or - by default, since Stripe isn't configured in this environment - to a local "dev checkout" page that flips the account's plan instantly with no payment processor involved, clearly labeled as a dev/test bypass in the UI itself. Every locked underlying (in the dashboard's symbol dropdown, and in the comparison view) unlocks immediately after.
- Attempting to fetch a locked underlying's data (`/api/gex/{symbol}`, `/api/candles/{symbol}`, `/api/history/{symbol}`) returns `403 {"upgrade_required": true}` rather than silently succeeding or crashing - the dashboard renders this as a lock icon + upgrade link instead of a raw error.

**Honest status on real Stripe billing:** the Checkout Session creation and webhook signature verification in `billing.py` are implemented against Stripe's real REST API (direct HTTP calls via `httpx`, since the official `stripe` Python SDK isn't installable in this build sandbox - PyPI returned a 403 for that specific package), but **have not been exercised against the real Stripe API** - this sandbox's network egress can't reach `api.stripe.com` at all (same story as `api.massive.com` earlier: a direct request through the sandbox's proxy gets a 403 CONNECT failure), and unlike the Massive/Polygon key, there's no read-only way to verify an authenticated POST-based API like Checkout Session creation from here. `test_billing_offline.py` verifies the webhook signature logic in isolation (correct signature accepted, tampered payload rejected, wrong secret rejected, stale/replayed timestamp rejected) the same way `test_polygon_offline.py` verified the options connector without live network access - but the Checkout creation call itself needs a first real run against a Stripe (test-mode is fine) account before you trust it in production. To turn it on:

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ID_LIVE=price_...
PUBLIC_BASE_URL=https://your-real-domain.com
```

Leave all of these unset (the shipped default) to keep running in dev-checkout mode.

## Going live: switching to Polygon/Massive

**Status: `backend/.env` is already wired up to Todd's real Options Starter key** (`DATA_PROVIDER=polygon`) - this isn't just documented, it's the live default in the delivered `.env` now. To use a different key or go back to simulated data:

1. Get a Massive (formerly Polygon.io) **Options** plan — Starter ($29/mo, 15-min delayed) is enough to validate everything below; only upgrade to Advanced ($199/mo) once you actually need real-time.
2. In `backend/.env`, set:
   ```
   DATA_PROVIDER=polygon
   POLYGON_API_KEY=your_key_here
   ```
   (or `DATA_PROVIDER=mock` with no key, to go back to simulated data).
3. Restart `python run.py`.

Re-verified live on 2026-09-14 - the key is still active and current (fetched a fresh SPY chain: spot ~$762, real greeks/OI/IV on strikes 750-770), and the connector's parsing/parity/aggregation code was re-run against that fresh data end-to-end (spot inferred at $762.01 exactly matching hand-calculated put-call parity, call wall 768, put wall 760, zero-gamma 764.85 - sane, current numbers). Two real bugs were caught and fixed in an earlier pass (via direct API requests, not through this sandbox's Python runtime, which has no outbound network access — verification was done by hand-inspecting real request/response payloads, then replaying those exact payloads through the actual `get_chain()` code path with a mock transport; see `test_polygon_offline.py`):

- **Host moved.** Polygon rebranded to Massive; the API host is `api.massive.com`, not `api.polygon.io` (which now just redirects the marketing/docs site, not the API itself — the old host was producing 403s that looked like a plan problem but were actually just wrong). Fixed in `BASE_URL`.
- **No underlying price on the Options plan alone.** `underlying_asset` in the snapshot response only ever has `{"ticker": "SPY"}` — the actual spot price is a separate Stocks-plan entitlement this key doesn't include (confirmed: a direct stock snapshot call came back `NOT_ENTITLED`). Rather than requiring a second paid plan, the connector now derives spot from the chain itself via put-call parity at the most at-the-money strike it can find (`_infer_spot_via_parity` in `polygon_provider.py`) — cross-checked by hand against live SPY data and accurate to the cent.

Run `python3 test_polygon_offline.py` from `backend/` any time to re-verify the parsing/parity logic against the real captured payloads without needing network access. What's *not* yet verified: the index-ticker prefix convention (`I:SPX` etc.) — the SPY equity-options path is the one that's been proven end-to-end so far. Watch the terminal the first time you run this against SPX/QQQ for request errors before trusting those.

**One thing this build sandbox specifically cannot verify: sustained continuous polling.** This sandbox's own network egress can't reach `api.massive.com` at all (confirmed again just now — DNS/connect attempts just hang rather than erroring, which is why re-verification above was done by fetching fresh data through a different path and replaying it through the real code, not by actually running `python run.py` against the live key in this sandbox). On your own machine, with a normal network path, `python run.py` with the `.env` as shipped will just start polling live data immediately — nothing else to configure.

**Security note:** `backend/.env` now contains your real API key in plaintext, since that's what "wired up and live" means. Keep this zip somewhere private, and rotate the key at your Massive/Polygon dashboard if it, or this codebase, ever ends up somewhere more public than intended.

**Want to see it running on real numbers right now, before wiring up your own key?** `python3 demo_replay_real_data.py` from `backend/` serves a full real SPY chain — 102 live contracts, strikes 735-785, captured 2026-09-14 straight from a real Options Starter key — through the exact same production code path (the real `PolygonOptionsProvider.get_chain()`, the real `gex_engine`, the real API, the real frontend). Open **http://localhost:8000** and you'll see genuine market structure: spot inferred at $760.02, a call wall at 766, a put wall at 760, and a deep negative-gamma trough right at spot — the classic 0DTE "pinned in a negative gamma pocket" pattern. The header badge turns green and says "LIVE DATA" instead of "SIMULATED DATA" whenever the backend isn't running the mock provider (this is now driven by the actual `/api/underlyings` response, not hardcoded — a real fix, not just a demo trick). The one caveat: this is a frozen snapshot replayed on every tick, not an actually-updating live feed (this sandbox has no outbound network access to make it one) — point `DATA_PROVIDER=polygon` at your own key in a normal environment to get a genuinely live-updating version of this same view.

## Known limitations of this prototype (by design, not oversight)

- **HTTP polling instead of WebSocket push.** The sandbox this was built in couldn't install the `websockets`/`wsproto` packages uvicorn needs for WebSocket support, so the frontend polls `/api/gex/{symbol}` every 2s instead of receiving a push. It still feels live at that cadence. To upgrade: `pip install websockets`, add a `WebSocketRoute` in `server.py` that broadcasts `_latest[symbol]` whenever the refresh loop updates it, and switch `app.js` from `setInterval`+`fetch` to a `WebSocket` client. Nothing in the provider or calc-engine layers needs to change.
- **SQLite, not TimescaleDB.** Fine at this data volume (a handful of underlyings, thousands of contracts); revisit per the build-scope doc once you're tracking a much larger universe or need heavier historical queries.
- **Single-process, single-instance auth.** Sessions are a signed cookie, but `SECRET_KEY` is randomly generated per process if unset - fine for one local instance, wrong for anything running as more than one worker/replica (set `SECRET_KEY` explicitly once you deploy more than one process). No password reset flow, no email verification, no multi-user org accounts (Desk plan's "multi-user access" is pricing-page copy, not implemented).
- **Stripe billing is wired but unverified against the real API** - see the "Accounts, plans, and billing" section above for exactly what was and wasn't testable in this sandbox.
- **Zero-gamma level can come back empty** for an underlying whose net GEX doesn't cross zero within ±12% of spot (you'll see this on some mock tickers) — that's the calc correctly declining to report a level that doesn't exist in range, not a bug.
- **The dealer-sign convention** (customers buy → dealers short, calls +GEX / puts −GEX) is the industry-standard assumption, not verified fact — see the risk notes in `quantro-build-scope.md`.

## Next steps

- Wire a real vendor (above) and validate the numbers against a known reference (e.g. compare SPX zero-gamma against a published SpotGamma/GEX Twitter/X post for the same day) before trusting it.
- Run the billing flow against a real (test-mode) Stripe account at least once before flipping it on for real customers - see the honest caveats above.
- Add the WebSocket push upgrade once you're past prototyping.
- A real Desk-plan flow (multi-user accounts, an actual API key issuance path) is the biggest remaining piece from the original Zerano/Skylit feature set. (The multi-expiry GEX heatmap is now built — see "Dealer Positioning Map" on the dashboard.)
- **Whop checkout — paused mid-swap.** You asked to replace the Stripe Checkout link with a Whop.com one; billing.py/config.py/the dev-checkout page are all still on Stripe as of this round while that was set aside in favor of the positioning-map work. What's been confirmed so far (via Whop's public docs, since this sandbox's network can't reach whop.com or api.whop.com directly, same as it can't reach api.stripe.com): Whop checkout is normally a static per-plan link from your Whop dashboard (not a server-created session like Stripe's), and Whop's webhooks follow the open Standard Webhooks spec — `webhook-id`/`webhook-timestamp`/`webhook-signature` headers, HMAC-SHA256 over `{id}.{timestamp}.{body}`, secret prefixed `whsec_`/`ws_` and base64-decoded before use. What's still needed before this can be wired in for real: your actual Whop checkout URL (and webhook secret, if you want automatic plan upgrades rather than the same dev-confirm bypass Stripe uses today). Say the word and this gets finished the same way Stripe was — implemented against the documented spec, offline-tested, honestly caveated on what couldn't be verified live.
- Decide the differentiation angle (see build-scope doc §5) before investing in frontend polish — the pipeline here gets you to feature parity with Skylit/Zerano/SpotGamma, not ahead of them.
