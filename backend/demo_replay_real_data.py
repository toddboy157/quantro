"""
Demo utility: serves a REAL SPY options chain (102 live contracts, strikes
735-785, captured 2026-09-14 from your Options Starter key via api.massive.com)
through the actual, unmodified app - same PolygonOptionsProvider.get_chain()
parsing/parity code, same gex_engine.compute_gex, same server.py API, same
frontend. Nothing about the calc engine or UI is different from a real run;
only the network call itself is replayed from tests_data/real_spy_snapshot_20260914.json
instead of hitting api.massive.com live, because this build sandbox has no
outbound network access.

This is a SNAPSHOT REPLAY, not a live feed: the same captured moment is
served on every refresh tick, so the numbers are real but static between
ticks (only the "last updated" timestamp moves) - that's expected here, not
a bug. Point this at your own key with DATA_PROVIDER=polygon in a normal
environment to get an actually-live-updating version of this same view.

Run: python3 demo_replay_real_data.py
Then open http://localhost:8000
"""
import json
import time
from pathlib import Path

import httpx

from app import config

# Real captured data is SPY-only for this demo.
config.UNDERLYINGS = ["SPY"]
config.DATA_PROVIDER = "polygon, replayed capture"

from app.providers.base import ChainSnapshot, OptionsDataProvider
from app.providers.polygon_provider import PolygonOptionsProvider
import app.server as server_module

FIXTURE_PATH = Path(__file__).parent / "tests_data" / "real_spy_snapshot_20260914.json"


class ReplayProvider(OptionsDataProvider):
    """Wraps the real PolygonOptionsProvider but points its HTTP client at a
    mock transport that always replays the captured real payload - so every
    line of parsing/pagination/spot-inference logic in polygon_provider.py
    actually runs, just against a frozen real snapshot instead of a live one.
    """

    def __init__(self, fixture_results):
        self._fixture_results = fixture_results
        self._inner = PolygonOptionsProvider(api_key="replay-not-a-real-key")

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"results": self._fixture_results, "status": "OK"})

        self._inner._client = httpx.AsyncClient(
            base_url="https://api.massive.com",
            transport=httpx.MockTransport(handler),
        )

    async def get_chain(self, underlying: str) -> ChainSnapshot:
        chain = await self._inner.get_chain(underlying)
        chain.timestamp = time.time()  # so the UI's "last updated" still moves
        return chain

    async def close(self) -> None:
        await self._inner.close()


def fake_get_provider(name, **kwargs):
    with open(FIXTURE_PATH) as f:
        results = json.load(f)
    return ReplayProvider(results)


# server.py imported get_provider by name, so patch its reference directly.
server_module.get_provider = fake_get_provider

app = server_module.app

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
