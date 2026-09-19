"""
Live connector for Massive / Polygon.io's options snapshot API.

Verified live on 2026-09-14 against a real Options Starter ($29/mo, 15-min
delayed) key, via direct HTTPS requests (not through this sandbox's Python
runtime, which has no outbound network access - see the two findings below,
confirmed by hand against real SPY response payloads). Two things changed
from the original untested version of this file:

1. HOST MOVED: Polygon rebranded to "Massive" and the API host is now
   api.massive.com, not api.polygon.io. The old host was returning 403s that
   looked like a plan/entitlement problem but were actually just a stale
   host - polygon.io/docs itself 302-redirects to massive.com/docs now.
   `GET https://api.massive.com/v3/snapshot/options/{underlyingAsset}` is
   confirmed working end-to-end on the Options Starter tier: real
   open_interest, implied_volatility, and greeks (delta/gamma/theta/vega)
   come back per contract, e.g. SPY 756-strike 0DTE call: OI=295,
   IV=0.149, gamma=0.0549, delta=0.875 - all sane numbers, gamma correctly
   peaking near the at-the-money strike across the chain.

2. NO UNDERLYING PRICE ON THIS PLAN: `underlying_asset` in the response is
   just `{"ticker": "SPY"}` - no `price` field - because reading the
   underlying equity/ETF's own quote is a separate Stocks-plan entitlement
   this key doesn't have (confirmed separately: a stock snapshot call for
   SPY came back "NOT_ENTITLED"). Rather than requiring a second paid plan
   just for spot, this connector derives spot from the chain itself via
   put-call parity (Spot ~= Strike + Call_close - Put_close for a matched
   call/put at the same strike/expiry), picked from whichever strike in the
   nearest expiry has a call delta closest to 0.5 (most at-the-money, least
   distorted by wide bid/ask on far ITM/OTM contracts). This was
   cross-checked by hand on live data: strike 756 gave ~760.3, consistent
   with that strike's call delta of 0.875 (properly ITM, spot above 756).
   If your key/plan *does* include underlying_asset.price (e.g. a fuller
   plan, or Polygon changes this), that value is used directly instead and
   parity is only a fallback.

Before trusting this in production: run the app for real (this sandbox
still can't make outbound HTTP calls, so this has only been exercised via
manual request/response inspection, not through this actual code path) and
watch the terminal for request errors on your specific underlyings.
"""
from __future__ import annotations

import logging
import time
from statistics import median
from typing import Dict, List, Optional, Tuple

import httpx

from ..config import POLYGON_API_KEY
from .base import ChainSnapshot, ContractSnapshot, OptionsDataProvider

log = logging.getLogger("quantro")

BASE_URL = "https://api.massive.com"

# A generous ceiling on how many pages one get_chain() call will follow via
# the vendor's next_url pagination before giving up. At limit=250/page this
# is 25,000 contracts - comfortably more than even SPX's full chain across
# every strike and expiry should need. This exists as defense-in-depth
# alongside server.py's own overall per-symbol timeout: if pagination is
# genuinely endless (a next_url that loops, or a vendor response that never
# runs out for some other reason), this raises a specific, diagnosable error
# ("stopped after N pages") well before that outer timeout would just report
# a generic "timed out."
MAX_CHAIN_PAGES = 100

# Polygon/Massive's index tickers are prefixed with "I:" in most v3 endpoints
# (e.g. I:SPX), while ETFs/equities use the bare ticker (SPY, AAPL, ...).
# Adjust this map if their convention differs at the time you wire this up -
# this hasn't been verified live the way the SPY equity-options path has.
INDEX_TICKER_PREFIX = {"SPX": "I:SPX", "NDX": "I:NDX", "VIX": "I:VIX"}


def _to_polygon_ticker(underlying: str) -> str:
    return INDEX_TICKER_PREFIX.get(underlying.upper(), underlying.upper())


class PolygonOptionsProvider(OptionsDataProvider):
    def __init__(self, api_key: Optional[str] = None, timeout: float = 10.0, **_ignored):
        # get_provider() (providers/__init__.py) calls every provider the
        # same way, passing underlyings=config.UNDERLYINGS - MockOptionsProvider
        # needs that list up front to pre-seed simulated per-symbol state, but
        # this connector fetches one symbol's real chain per get_chain() call
        # and has no use for the full list. Accepting and discarding it here
        # (via **_ignored) keeps the factory call site uniform instead of
        # needing a provider-specific branch. This was previously a hard
        # TypeError - "unexpected keyword argument 'underlyings'" - raised
        # during the background refresh loop's startup, which (before the
        # accompanying server.py fix) failed completely silently: nothing
        # logged, every /api/gex/<symbol> stuck on a permanent, indistinguishable
        # "not ready yet" 503. DATA_PROVIDER=polygon was therefore never able
        # to actually serve live data in production until this fix.
        key = api_key or POLYGON_API_KEY
        if not key:
            raise RuntimeError(
                "POLYGON_API_KEY is not set. Add it to backend/.env or pass "
                "api_key= explicitly before using DATA_PROVIDER=polygon."
            )
        self._api_key = key
        self._client = httpx.AsyncClient(base_url=BASE_URL, timeout=timeout)

    async def close(self) -> None:
        await self._client.aclose()

    async def get_chain(self, underlying: str) -> ChainSnapshot:
        from datetime import datetime, timezone

        ticker = _to_polygon_ticker(underlying)
        contracts: List[ContractSnapshot] = []
        spot: Optional[float] = None
        # Computed once per call, not once per contract: two contracts with
        # the identical expiration_date must get an identical expiry_days,
        # or gex_engine's groupby("expiry_days") fragments one real expiry
        # into many near-duplicate float buckets (caught by test_polygon_offline.py -
        # datetime.now() drifting by microseconds between contracts was enough
        # to break the by-expiry aggregation).
        now = datetime.now(timezone.utc)

        # Keyed by (strike, expiry_date) -> {"call": (close, delta), "put": (close, delta)}
        # Only used if the plan doesn't hand us underlying_asset.price directly.
        parity_pairs: Dict[Tuple[float, str], Dict[str, Tuple[float, float]]] = {}

        url = f"/v3/snapshot/options/{ticker}"
        params = {"apiKey": self._api_key, "limit": 250}
        page_count = 0
        fetch_started = time.monotonic()

        # Belt-and-braces alongside the empty-results-page check below: if a
        # page comes back non-empty (payload["results"] has rows) but every
        # single row in it gets skipped by the "incomplete row" continue
        # below (missing strike/expiry/type/iv), that page contributed zero
        # real contracts even though it wasn't literally an empty list. Found
        # live (round 2): trusting only a truly-empty results page still hit
        # the MAX_CHAIN_PAGES cap on every symbol, with contract counts
        # plateauing exactly at each symbol's real chain size (SPX/SPY/QQQ/
        # AAPL/TSLA ~1200, NVDA 647, MSFT 295, AMZN 385) on both the first
        # and second test - identical counts across separate runs rules out
        # duplicate/looping real data (that would keep growing the count) and
        # points at the vendor padding out pages past the entitlement
        # boundary with rows that are missing the fields this connector
        # needs, rather than ever sending back an empty list or a null
        # next_url. Treating N consecutive zero-yield pages as "chain
        # complete" catches that case too.
        ZERO_YIELD_PAGE_LIMIT = 3
        zero_yield_pages_in_a_row = 0
        logged_skip_sample = False

        while url:
            page_count += 1
            if page_count > MAX_CHAIN_PAGES:
                raise RuntimeError(
                    f"{ticker}: stopped after {MAX_CHAIN_PAGES} pages ({len(contracts)} contracts so far) "
                    "without running out of next_url or hitting the zero-yield-page limit - "
                    "treating this as a pagination bug/runaway response rather than looping forever."
                )
            resp = await self._client.get(url, params=params)
            resp.raise_for_status()
            payload = resp.json()
            page_results = payload.get("results", [])
            if page_count == 1 or page_count % 10 == 0:
                log.info(
                    "%s: fetched page %d (%d contracts so far, %.1fs elapsed)",
                    ticker, page_count, len(contracts), time.monotonic() - fetch_started,
                )

            if not page_results:
                # Some symbols/plans may still legitimately signal "done" this
                # way even though round 2's testing showed it isn't the only
                # (or even the common) signal in practice - kept as the
                # cheapest possible check before falling through to the
                # zero-yield counting below.
                log.info(
                    "%s: page %d returned no results - treating chain as complete (%d contracts total)",
                    ticker, page_count, len(contracts),
                )
                break

            contracts_added_this_page = 0
            for row in page_results:
                details = row.get("details", {})
                greeks = row.get("greeks", {}) or {}
                underlying_asset = row.get("underlying_asset", {}) or {}

                if spot is None:
                    price = underlying_asset.get("price") or underlying_asset.get("value")
                    if price is not None:
                        spot = float(price)

                strike = details.get("strike_price")
                expiry_date = details.get("expiration_date")  # "YYYY-MM-DD"
                contract_type = details.get("contract_type")  # "call" | "put"
                oi = row.get("open_interest", 0) or 0
                iv = row.get("implied_volatility")

                # Collect parity inputs regardless of whether IV is present,
                # since a contract with no IV can still have a usable close
                # price for spot inference (e.g. very thin/no vega contracts
                # where the vendor's IV solver gives up - seen live on deep
                # ITM 0DTE contracts).
                # The bulk chain endpoint (this one) returns the daily price
                # bar under "day"; a different snapshot endpoint variant
                # returns it under "session" - checking both defensively
                # since this has only been confirmed live for "day".
                close_px = (row.get("day") or row.get("session") or {}).get("close")
                delta = greeks.get("delta")
                if strike is not None and expiry_date is not None and contract_type in ("call", "put") and close_px:
                    key_ = (float(strike), expiry_date)
                    parity_pairs.setdefault(key_, {})[contract_type] = (float(close_px), delta)

                if strike is None or expiry_date is None or contract_type is None or iv is None:
                    if not logged_skip_sample:
                        # Logged once per get_chain() call (not once per row)
                        # so this doesn't flood the logs, but it's enough to
                        # see, the next time this fires live, exactly which
                        # field(s) the vendor is omitting on these padding
                        # pages - confirms or corrects the entitlement-boundary
                        # theory above instead of leaving it a guess.
                        log.info(
                            "%s: skipping incomplete row on page %d (strike=%r expiry=%r "
                            "type=%r iv=%r) - keys present: %s",
                            ticker, page_count, strike, expiry_date, contract_type, iv,
                            sorted(row.keys()),
                        )
                        logged_skip_sample = True
                    continue  # skip incomplete rows rather than crash the whole tick

                expiry_days = _days_to_expiry(expiry_date, now)

                contracts.append(
                    ContractSnapshot(
                        strike=float(strike),
                        expiry_days=max(expiry_days, 0.02),
                        is_call=(contract_type == "call"),
                        open_interest=int(oi),
                        implied_vol=float(iv),
                    )
                )
                contracts_added_this_page += 1
                # Vendor gamma (greeks.get("gamma")) is available here if you'd
                # rather trust Polygon/Massive's own Greeks instead of
                # recomputing via app.greeks - see gex_engine.compute_gex for
                # where that swap would go; using our own Black-Scholes keeps
                # the zero-gamma scenario re-pricing (which needs gamma at
                # hypothetical spot levels the vendor never quoted) consistent
                # with the main calc.

            if contracts_added_this_page == 0:
                zero_yield_pages_in_a_row += 1
                if zero_yield_pages_in_a_row >= ZERO_YIELD_PAGE_LIMIT:
                    log.info(
                        "%s: %d consecutive pages returned data but zero usable contracts - "
                        "treating chain as complete past this entitlement boundary (%d contracts total)",
                        ticker, zero_yield_pages_in_a_row, len(contracts),
                    )
                    break
            else:
                zero_yield_pages_in_a_row = 0

            next_url = payload.get("next_url")
            if next_url:
                # next_url is a full URL already including its own query
                # params (per the vendor's pagination convention) except the key.
                url = next_url
                params = {"apiKey": self._api_key}
            else:
                url = None

        if spot is None:
            spot = _infer_spot_via_parity(parity_pairs)

        if spot is None:
            raise RuntimeError(
                f"Could not determine spot price for {ticker}: no underlying_asset "
                "price/value on this plan, and no matched call/put pair with close "
                "prices to infer it via put-call parity. Check the ticker format "
                "(index tickers may need an 'I:' prefix) or add a Stocks-plan key."
            )

        return ChainSnapshot(
            underlying=underlying,
            spot=spot,
            timestamp=time.time(),
            contracts=contracts,
        )


def _infer_spot_via_parity(
    parity_pairs: Dict[Tuple[float, str], Dict[str, Tuple[float, float]]],
) -> Optional[float]:
    """Spot ~= Strike + Call_close - Put_close (ignoring the small interest/
    dividend term, fine for short-dated contracts). Restrict to the nearest
    expiry present, then prefer the strike whose call delta is closest to
    0.5 (most at-the-money); fall back to the median across that expiry's
    strikes if delta wasn't available for some reason.
    """
    if not parity_pairs:
        return None

    nearest_expiry = min(expiry for (_, expiry) in parity_pairs.keys())

    candidates: List[Tuple[float, Optional[float]]] = []  # (implied_spot, call_delta)
    for (strike, expiry), sides in parity_pairs.items():
        if expiry != nearest_expiry:
            continue
        call = sides.get("call")
        put = sides.get("put")
        if call is None or put is None:
            continue
        call_close, call_delta = call
        put_close, _ = put
        implied_spot = strike + call_close - put_close
        candidates.append((implied_spot, call_delta))

    if not candidates:
        return None

    with_delta = [(spot, d) for spot, d in candidates if d is not None]
    if with_delta:
        best_spot, _ = min(with_delta, key=lambda pair: abs(pair[1] - 0.5))
        return best_spot

    return median(spot for spot, _ in candidates)


def _days_to_expiry(expiry_date_str: str, now) -> float:
    from datetime import datetime, timezone
    expiry = datetime.strptime(expiry_date_str, "%Y-%m-%d").replace(
        hour=21, minute=0, tzinfo=timezone.utc  # approx 4pm ET close
    )
    return max((expiry - now).total_seconds() / 86400.0, 0.0)
