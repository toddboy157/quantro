"""
Vectorized Black-Scholes Greeks. We compute gamma (and delta, as a bonus)
ourselves rather than always trusting a vendor's pre-computed Greeks, for
two reasons: (1) not every vendor supplies gamma directly, and (2) it lets
us re-price the whole chain at hypothetical spot levels to find the "zero
gamma" flip point (see gex_engine.compute_zero_gamma), which requires
recomputing Greeks at spot prices the vendor never quoted.

All inputs/outputs are numpy arrays (or scalars broadcastable against them)
so a full chain (thousands of contracts) prices in one call rather than a
Python loop per contract.
"""
from __future__ import annotations

import numpy as np

_SQRT_2PI = np.sqrt(2.0 * np.pi)

# Floor on time-to-expiry (in years) to avoid division-by-zero / blow-up for
# 0DTE contracts in the last minutes before expiry. ~1 minute.
MIN_T_YEARS = 1.0 / (365.0 * 24.0 * 60.0)


def _norm_pdf(x: np.ndarray) -> np.ndarray:
    return np.exp(-0.5 * x * x) / _SQRT_2PI


def _norm_cdf(x: np.ndarray) -> np.ndarray:
    # 0.5 * (1 + erf(x / sqrt(2))) - avoids a scipy dependency.
    from math import erf
    vec_erf = np.vectorize(erf)
    return 0.5 * (1.0 + vec_erf(x / np.sqrt(2.0)))


def _d1_d2(S, K, T, sigma, r, q=0.0):
    T = np.maximum(T, MIN_T_YEARS)
    sigma = np.maximum(sigma, 1e-4)  # guard against zero/garbage IV
    d1 = (np.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * np.sqrt(T))
    d2 = d1 - sigma * np.sqrt(T)
    return d1, d2


def gamma(S, K, T, sigma, r, q=0.0) -> np.ndarray:
    """Gamma is identical for calls and puts at the same strike/expiry."""
    T_floored = np.maximum(T, MIN_T_YEARS)
    sigma_floored = np.maximum(sigma, 1e-4)
    d1, _ = _d1_d2(S, K, T, sigma, r, q)
    return (np.exp(-q * T_floored) * _norm_pdf(d1)) / (
        S * sigma_floored * np.sqrt(T_floored)
    )


def delta(S, K, T, sigma, r, is_call: np.ndarray, q=0.0) -> np.ndarray:
    T_floored = np.maximum(T, MIN_T_YEARS)
    d1, _ = _d1_d2(S, K, T, sigma, r, q)
    call_delta = np.exp(-q * T_floored) * _norm_cdf(d1)
    put_delta = call_delta - np.exp(-q * T_floored)
    return np.where(is_call, call_delta, put_delta)
