"""
Turns a raw options chain (from any provider) into the numbers a "dealer
wall" chart actually plots: net gamma exposure (GEX) by strike, the call
wall / put wall, and the zero-gamma flip level.

Formula (per contract, standard industry convention - see e.g. SpotGamma's
public methodology writeups):

    GEX = gamma * open_interest * 100 * spot^2 * 0.01

with calls contributing positive GEX and puts contributing negative GEX
(this encodes the standard "dealers are short what customers bought"
convention - a modeling assumption, not a verified fact; see the risk note
in the build-scope doc). Net GEX at a strike/expiry is the sum across
calls and puts there; total net GEX is the sum across the whole chain.

Zero-gamma level: instead of trusting a single point estimate, we re-price
the *entire* chain's gamma at a grid of hypothetical spot prices (holding
strikes/IV/OI/expiry fixed) and find where total net GEX crosses zero. This
is the same approach the industry uses and is why it requires our own
Black-Scholes gamma (app.greeks) rather than only ever trusting a vendor's
Greeks computed at the single spot price they quote.
"""
from __future__ import annotations

from typing import Dict, List, Optional

import numpy as np
import pandas as pd

from . import greeks
from .providers.base import ChainSnapshot

CONTRACT_MULTIPLIER = 100
ZERO_GAMMA_SCENARIO_RANGE = 0.12  # +/- 12% around spot
ZERO_GAMMA_SCENARIO_POINTS = 61


def _chain_to_frame(chain: ChainSnapshot) -> pd.DataFrame:
    if not chain.contracts:
        return pd.DataFrame(columns=["strike", "expiry_days", "is_call", "oi", "iv"])
    return pd.DataFrame(
        {
            "strike": [c.strike for c in chain.contracts],
            "expiry_days": [c.expiry_days for c in chain.contracts],
            "is_call": [c.is_call for c in chain.contracts],
            "oi": [c.open_interest for c in chain.contracts],
            "iv": [c.implied_vol for c in chain.contracts],
        }
    )


def _signed_gex(df: pd.DataFrame, spot: float, r: float, spot_override: Optional[float] = None) -> np.ndarray:
    S = spot_override if spot_override is not None else spot
    T = (df["strike"].to_numpy() * 0 + df["expiry_days"].to_numpy()) / 365.0
    gamma_arr = greeks.gamma(S=S, K=df["strike"].to_numpy(), T=T, sigma=df["iv"].to_numpy(), r=r)
    sign = np.where(df["is_call"].to_numpy(), 1.0, -1.0)
    return gamma_arr * df["oi"].to_numpy() * CONTRACT_MULTIPLIER * (spot ** 2) * 0.01 * sign


def compute_zero_gamma(df: pd.DataFrame, spot: float, r: float) -> Optional[float]:
    """Scan hypothetical spot levels and linearly interpolate the crossing."""
    if df.empty:
        return None
    scenarios = np.linspace(
        spot * (1 - ZERO_GAMMA_SCENARIO_RANGE),
        spot * (1 + ZERO_GAMMA_SCENARIO_RANGE),
        ZERO_GAMMA_SCENARIO_POINTS,
    )
    totals = []
    for s in scenarios:
        totals.append(float(_signed_gex(df, spot, r, spot_override=s).sum()))
    totals = np.array(totals)

    sign_changes = np.where(np.diff(np.sign(totals)) != 0)[0]
    if len(sign_changes) == 0:
        return None
    i = sign_changes[0]
    s0, s1 = scenarios[i], scenarios[i + 1]
    t0, t1 = totals[i], totals[i + 1]
    if t1 == t0:
        return float(s0)
    # linear interpolation for the zero crossing
    frac = -t0 / (t1 - t0)
    return float(s0 + frac * (s1 - s0))


def compute_gex(chain: ChainSnapshot, risk_free_rate: float) -> Dict:
    df = _chain_to_frame(chain)
    if df.empty:
        return {
            "underlying": chain.underlying,
            "spot": chain.spot,
            "timestamp": chain.timestamp,
            "net_gex": 0.0,
            "call_wall": None,
            "put_wall": None,
            "zero_gamma": None,
            "by_strike": [],
            "by_expiry": [],
            "by_strike_expiry": [],
        }

    df["gex"] = _signed_gex(df, chain.spot, risk_free_rate)

    by_strike = (
        df.groupby("strike")
        .apply(
            lambda g: pd.Series(
                {
                    "call_gex": g.loc[g["is_call"], "gex"].sum(),
                    "put_gex": g.loc[~g["is_call"], "gex"].sum(),
                    "net_gex": g["gex"].sum(),
                }
            ),
            include_groups=False,
        )
        .reset_index()
        .sort_values("strike")
    )

    by_expiry = (
        df.groupby("expiry_days")["gex"]
        .sum()
        .reset_index()
        .rename(columns={"gex": "net_gex"})
        .sort_values("expiry_days")
    )

    # Full strike x expiry breakdown - the source data for the "dealer
    # positioning map" heatmap (each cell is one expiry bucket's net GEX at
    # one strike). by_strike/by_expiry above are just the 1-D projections of
    # this same grid, summed across the other axis.
    by_strike_expiry = (
        df.groupby(["expiry_days", "strike"])["gex"]
        .sum()
        .reset_index()
        .rename(columns={"gex": "net_gex"})
        .sort_values(["expiry_days", "strike"])
    )

    net_gex = float(df["gex"].sum())

    call_wall_row = by_strike.loc[by_strike["net_gex"].idxmax()] if not by_strike.empty else None
    put_wall_row = by_strike.loc[by_strike["net_gex"].idxmin()] if not by_strike.empty else None

    zero_gamma = compute_zero_gamma(df, chain.spot, risk_free_rate)

    return {
        "underlying": chain.underlying,
        "spot": chain.spot,
        "timestamp": chain.timestamp,
        "net_gex": net_gex,
        "call_wall": float(call_wall_row["strike"]) if call_wall_row is not None else None,
        "put_wall": float(put_wall_row["strike"]) if put_wall_row is not None else None,
        "zero_gamma": zero_gamma,
        "by_strike": [
            {
                "strike": float(row.strike),
                "call_gex": float(row.call_gex),
                "put_gex": float(row.put_gex),
                "net_gex": float(row.net_gex),
            }
            for row in by_strike.itertuples()
        ],
        "by_expiry": [
            {"expiry_days": float(row.expiry_days), "net_gex": float(row.net_gex)}
            for row in by_expiry.itertuples()
        ],
        "by_strike_expiry": [
            {
                "expiry_days": float(row.expiry_days),
                "strike": float(row.strike),
                "net_gex": float(row.net_gex),
            }
            for row in by_strike_expiry.itertuples()
        ],
    }
