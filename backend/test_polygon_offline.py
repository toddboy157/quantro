"""
Offline verification of PolygonOptionsProvider against REAL response payloads
captured live from api.massive.com on 2026-09-14 with a real Options Starter
key (the sandbox this was built in has no outbound network access, so this
replays real captured JSON through a mock transport instead of hitting the
network - it still exercises the actual get_chain() code path: request
building, pagination, field parsing, and the put-call-parity spot fallback).

Run: python3 test_polygon_offline.py
"""
import asyncio
import json

import httpx

from app.providers.polygon_provider import PolygonOptionsProvider

# These two objects are byte-for-byte what api.massive.com returned live for
# O:SPY260914C00756000 and O:SPY260914P00756000 on an Options Starter key -
# note underlying_asset has no "price" field, which is exactly the gap the
# parity fallback exists for.
REAL_CALL_756 = {
    "session": {"change": -4.26, "change_percent": -48.4, "early_trading_change": 0,
                "early_trading_change_percent": 0, "close": 4.54, "high": 4.76,
                "low": 3.03, "open": 3.59, "volume": 2430, "previous_close": 8.8},
    "details": {"contract_type": "call", "exercise_style": "american",
                "expiration_date": "2026-09-14", "shares_per_contract": 100, "strike_price": 756},
    "greeks": {"delta": 0.8752161508307174, "gamma": 0.05491060812806319,
               "theta": -1.0122014421591088, "vega": 0.04470620259472326},
    "implied_volatility": 0.1489534852561212,
    "open_interest": 295,
    "underlying_asset": {"ticker": "SPY"},
    "name": "SPY $756.00 call",
    "market_status": "open",
    "ticker": "O:SPY260914C00756000",
    "type": "options",
}

REAL_PUT_756 = {
    "session": {"change": -0.09, "change_percent": -26.5, "early_trading_change": 0,
                "early_trading_change_percent": 0, "close": 0.25, "high": 0.64,
                "low": 0.23, "open": 0.59, "volume": 14479, "previous_close": 0.34},
    "details": {"contract_type": "put", "exercise_style": "american",
                "expiration_date": "2026-09-14", "shares_per_contract": 100, "strike_price": 756},
    "greeks": {"delta": -0.12683831576135968, "gamma": 0.054959464123331775,
               "theta": -0.982878338140625, "vega": 0.04474888372660255},
    "implied_volatility": 0.1508135824643093,
    "open_interest": 2868,
    "underlying_asset": {"ticker": "SPY"},
    "name": "SPY $756.00 put",
    "market_status": "open",
    "ticker": "O:SPY260914P00756000",
    "type": "options",
}

# A second, further-OTM pair (deep ITM call / far OTM put at strike 670, also
# captured live) mixed in to prove the parity picker correctly prefers the
# closest-to-ATM strike (756, delta 0.875) over a worse candidate (670,
# delta ~0.9999 - much further from 0.5) rather than just averaging blindly.
REAL_CALL_670 = {
    "session": {"close": 88.63},
    "details": {"contract_type": "call", "expiration_date": "2026-09-14", "strike_price": 670},
    "greeks": {"delta": 0.9999891389, "gamma": -1.67e-08},
    "implied_volatility": 0.0001633,
    "open_interest": 72,
    "underlying_asset": {"ticker": "SPY"},
    "ticker": "O:SPY260914C00670000",
}
REAL_PUT_670 = {
    "session": {"close": 0.01},
    "details": {"contract_type": "put", "expiration_date": "2026-09-14", "strike_price": 670},
    "greeks": {"delta": -0.0001, "gamma": -1.6e-08},
    "implied_volatility": 0.02,
    "open_interest": 10,
    "underlying_asset": {"ticker": "SPY"},
    "ticker": "O:SPY260914P00670000",
}


def mock_handler(request: httpx.Request) -> httpx.Response:
    assert "/v3/snapshot/options/SPY" in str(request.url)
    return httpx.Response(
        200,
        json={
            "results": [REAL_CALL_756, REAL_PUT_756, REAL_CALL_670, REAL_PUT_670],
            "status": "OK",
        },
    )


async def main():
    provider = PolygonOptionsProvider(api_key="test-key")
    # Swap in a mock transport so the real httpx.AsyncClient.get() call in
    # get_chain() is exercised, just against canned (real, captured) data
    # instead of the network.
    provider._client = httpx.AsyncClient(
        base_url="https://api.massive.com",
        transport=httpx.MockTransport(mock_handler),
    )

    chain = await provider.get_chain("SPY")

    print(f"underlying:   {chain.underlying}")
    print(f"spot:         {chain.spot:.4f}")
    print(f"n_contracts:  {len(chain.contracts)}")
    for c in chain.contracts:
        print(f"  strike={c.strike:>6} {'call' if c.is_call else 'put ':>4} "
              f"OI={c.open_interest:>5} IV={c.implied_vol:.4f} expiry_days={c.expiry_days:.3f}")

    expected_spot = 756 + 4.54 - 0.25  # put-call parity by hand at the ATM-est strike
    assert abs(chain.spot - expected_spot) < 0.01, f"spot mismatch: {chain.spot} vs {expected_spot}"
    assert len(chain.contracts) == 4
    assert chain.spot > 756, "spot should be above the 756 strike, matching that call's 0.875 delta (ITM)"

    await provider.close()
    print("\nALL ASSERTIONS PASSED - spot correctly inferred via put-call parity")
    print(f"(picked strike 756 over strike 670, since 756's call delta 0.875 is far closer to 0.5)")


if __name__ == "__main__":
    asyncio.run(main())
