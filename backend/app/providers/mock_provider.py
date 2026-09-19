"""
Simulated options chain generator.

This exists so the whole pipeline (ingestion -> Greeks -> GEX aggregation ->
API -> chart) is runnable and demoable today, with zero data-vendor
signup/cost, and with a clean seam (providers.base.OptionsDataProvider) to
swap in a real vendor later without touching anything downstream.

Design choices that mirror how the real market actually behaves (see the
build-scope doc's note on this): open interest is only regenerated rarely
(exchanges publish official OI once per session), implied vol drifts slowly,
and spot price random-walks every tick. So on a live chart, wall levels
visibly move because spot is moving against a mostly-static OI/IV backdrop -
that's the real dynamic, not a simplification unique to the mock.

Numbers below (spot, IV) are placeholders for a plausible market, not sourced
prices - the UI clearly labels this provider as SIMULATED DATA.
"""
from __future__ import annotations

import math
import random
import time
from typing import Dict, List

import numpy as np

from .base import ChainSnapshot, ContractSnapshot, OptionsDataProvider

# Rough starting points + per-tick volatility + base IV level per underlying.
# per_tick_vol is calibrated for a ~2s refresh tick, not annualized vol.
UNDERLYING_DEFAULTS: Dict[str, dict] = {
    "SPX":  dict(spot=6500.0, strike_step=25.0, iv_base=0.13, per_tick_vol=0.0004, put_skew=0.9),
    "SPY":  dict(spot=650.0,  strike_step=2.5,  iv_base=0.13, per_tick_vol=0.0004, put_skew=0.9),
    "QQQ":  dict(spot=590.0,  strike_step=2.5,  iv_base=0.16, per_tick_vol=0.0005, put_skew=0.8),
    "AAPL": dict(spot=235.0,  strike_step=2.5,  iv_base=0.27, per_tick_vol=0.0006, put_skew=0.5),
    "NVDA": dict(spot=185.0,  strike_step=2.5,  iv_base=0.48, per_tick_vol=0.0010, put_skew=0.4),
    "MSFT": dict(spot=430.0,  strike_step=5.0,  iv_base=0.24, per_tick_vol=0.0005, put_skew=0.5),
    "TSLA": dict(spot=250.0,  strike_step=5.0,  iv_base=0.55, per_tick_vol=0.0012, put_skew=0.4),
    "AMZN": dict(spot=190.0,  strike_step=2.5,  iv_base=0.30, per_tick_vol=0.0006, put_skew=0.5),
}

# Days-to-expiry buckets we simulate: 0DTE, a couple of weeklies, and two
# monthlies - matches the "front 4-6 weeklies + front 2 monthlies" v1 cut
# from the build scope doc, trimmed down for a lighter demo dataset.
EXPIRY_DAYS = [0, 2, 5, 9, 16, 30, 44]

STRIKES_EACH_SIDE = 22  # strikes above and below spot, i.e. ~45 strikes total per expiry

# How many ticks between OI/IV-surface refreshes, vs. every tick for spot.
# Mimics OI updating far less often than price in the real market.
OI_REFRESH_EVERY_N_TICKS = 60   # ~2 minutes at a 2s tick
IV_REFRESH_EVERY_N_TICKS = 15   # ~30s at a 2s tick


class _UnderlyingState:
    def __init__(self, symbol: str, cfg: dict):
        self.symbol = symbol
        self.cfg = cfg
        self.spot = cfg["spot"]
        self.tick = 0
        self.oi_by_key: Dict[tuple, int] = {}
        self.iv_by_key: Dict[tuple, float] = {}
        self._regen_strikes()
        self._regen_oi()
        self._regen_iv()

    def _regen_strikes(self):
        step = self.cfg["strike_step"]
        center = round(self.spot / step) * step
        self.strikes = [
            center + i * step
            for i in range(-STRIKES_EACH_SIDE, STRIKES_EACH_SIDE + 1)
        ]

    def _regen_oi(self):
        rng = np.random.default_rng(hash((self.symbol, self.tick // OI_REFRESH_EVERY_N_TICKS)) & 0xFFFFFFFF)
        spot = self.spot
        put_skew = self.cfg["put_skew"]
        for expiry in EXPIRY_DAYS:
            # Longer-dated + 0DTE expiries carry more open interest than
            # mid-range weeklies, roughly matching real OI term structure.
            expiry_weight = 1.6 if expiry == 0 else (1.3 if expiry >= 30 else 1.0)
            for strike in self.strikes:
                dist = (strike - spot) / spot
                # Gaussian bump around spot, wider for further-dated expiries.
                width = 0.05 + expiry / 400.0
                base = math.exp(-(dist ** 2) / (2 * width ** 2))
                # Round-number strikes attract extra open interest.
                round_bonus = 1.4 if (strike % (self.cfg["strike_step"] * 4) == 0) else 1.0
                call_oi = base * round_bonus * expiry_weight * rng.uniform(4000, 20000) * (1.0 if dist >= 0 else 0.6)
                put_oi = base * round_bonus * expiry_weight * rng.uniform(4000, 20000) * put_skew * (1.0 if dist <= 0 else 0.6)
                self.oi_by_key[(expiry, strike, True)] = max(0, int(call_oi))
                self.oi_by_key[(expiry, strike, False)] = max(0, int(put_oi))

    def _regen_iv(self):
        rng = np.random.default_rng(hash((self.symbol, "iv", self.tick // IV_REFRESH_EVERY_N_TICKS)) & 0xFFFFFFFF)
        spot = self.spot
        iv_base = self.cfg["iv_base"]
        for expiry in EXPIRY_DAYS:
            term_bump = 0.01 * math.sqrt(max(expiry, 1) / 30.0)
            for strike in self.strikes:
                moneyness = (spot - strike) / spot  # >0 means strike below spot
                # Standard equity skew: OTM puts (low strikes) trade at higher IV.
                skew = max(moneyness, 0) * 0.35
                noise = rng.normal(0, 0.003)
                iv = max(0.03, iv_base + term_bump + skew + noise)
                self.iv_by_key[(expiry, strike, True)] = iv
                self.iv_by_key[(expiry, strike, False)] = iv

    def step(self):
        self.tick += 1
        vol = self.cfg["per_tick_vol"]
        self.spot *= math.exp(random.gauss(0, vol) - 0.5 * vol * vol)
        if self.tick % OI_REFRESH_EVERY_N_TICKS == 0:
            self._regen_strikes()
            self._regen_oi()
        if self.tick % IV_REFRESH_EVERY_N_TICKS == 0:
            self._regen_iv()

    def snapshot(self) -> ChainSnapshot:
        contracts: List[ContractSnapshot] = []
        for expiry in EXPIRY_DAYS:
            for strike in self.strikes:
                for is_call in (True, False):
                    key = (expiry, strike, is_call)
                    oi = self.oi_by_key.get(key, 0)
                    if oi <= 0:
                        continue
                    iv = self.iv_by_key.get(key, self.cfg["iv_base"])
                    contracts.append(
                        ContractSnapshot(
                            strike=strike,
                            expiry_days=max(expiry, 0.02),  # keep >0 for 0DTE intraday
                            is_call=is_call,
                            open_interest=oi,
                            implied_vol=iv,
                        )
                    )
        return ChainSnapshot(
            underlying=self.symbol,
            spot=self.spot,
            timestamp=time.time(),
            contracts=contracts,
        )


class MockOptionsProvider(OptionsDataProvider):
    def __init__(self, underlyings: List[str] | None = None):
        symbols = underlyings or list(UNDERLYING_DEFAULTS.keys())
        self._states: Dict[str, _UnderlyingState] = {}
        for sym in symbols:
            cfg = UNDERLYING_DEFAULTS.get(sym)
            if cfg is None:
                # Unknown symbol: fall back to SPY-like defaults so adding a
                # new ticker to UNDERLYINGS in .env doesn't hard-crash.
                cfg = dict(UNDERLYING_DEFAULTS["SPY"])
            self._states[sym] = _UnderlyingState(sym, dict(cfg))

    async def get_chain(self, underlying: str) -> ChainSnapshot:
        state = self._states.get(underlying)
        if state is None:
            raise KeyError(f"Unknown underlying for mock provider: {underlying}")
        state.step()
        return state.snapshot()
