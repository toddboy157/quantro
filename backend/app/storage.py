"""
Minimal time-series logging so the frontend can show a short history
sparkline and so nothing computed is thrown away between ticks. This is
intentionally simple (stdlib sqlite3) - the build-scope doc's recommended
production store is TimescaleDB/InfluxDB once volume and query needs grow
past what a single SQLite file handles comfortably. Swapping later means
replacing this module; nothing else depends on SQLite specifically.
"""
from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path
from typing import Dict, List

_SCHEMA = """
CREATE TABLE IF NOT EXISTS snapshots (
    underlying TEXT NOT NULL,
    ts REAL NOT NULL,
    spot REAL NOT NULL,
    net_gex REAL NOT NULL,
    call_wall REAL,
    put_wall REAL,
    zero_gamma REAL,
    by_strike_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_underlying_ts ON snapshots(underlying, ts);
"""


class SnapshotStore:
    def __init__(self, db_path: str):
        self._db_path = db_path
        # DB_PATH commonly points at a mounted volume (e.g. /data/quantro.db
        # in production - see DEPLOY.md). If that directory doesn't exist
        # yet (a volume attached after this variable was set, or just a
        # typo), sqlite3.connect() below fails loudly instead of silently
        # writing next to the working directory - better to create the
        # parent up front than crash-loop on every deploy.
        parent = Path(db_path).parent
        if str(parent) not in ("", "."):
            parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        conn = self._connect()
        conn.executescript(_SCHEMA)
        conn.commit()
        conn.close()

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self._db_path, check_same_thread=False)

    def write(self, result: Dict) -> None:
        """Called from the refresh loop after each recompute. Cheap enough
        to call synchronously at a 1-2s cadence for this data volume."""
        with self._lock:
            conn = self._connect()
            try:
                conn.execute(
                    "INSERT INTO snapshots (underlying, ts, spot, net_gex, call_wall, put_wall, zero_gamma, by_strike_json) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        result["underlying"],
                        result["timestamp"],
                        result["spot"],
                        result["net_gex"],
                        result["call_wall"],
                        result["put_wall"],
                        result["zero_gamma"],
                        json.dumps(result["by_strike"]),
                    ),
                )
                conn.commit()
            finally:
                conn.close()

    def history(self, underlying: str, limit: int = 200) -> List[Dict]:
        with self._lock:
            conn = self._connect()
            try:
                rows = conn.execute(
                    "SELECT ts, spot, net_gex, call_wall, put_wall, zero_gamma FROM snapshots "
                    "WHERE underlying = ? ORDER BY ts DESC LIMIT ?",
                    (underlying, limit),
                ).fetchall()
            finally:
                conn.close()
        rows.reverse()
        return [
            {
                "timestamp": r[0],
                "spot": r[1],
                "net_gex": r[2],
                "call_wall": r[3],
                "put_wall": r[4],
                "zero_gamma": r[5],
            }
            for r in rows
        ]

    def candles(self, underlying: str, bucket_seconds: int = 60, limit: int = 200) -> List[Dict]:
        """Bucket raw spot ticks into OHLC candles for the headline
        candlestick+walls chart - the signature Zerano/Skylit visual.

        There's no true intra-bucket high/low feed here (each tick is a
        single spot sample, not a trade print), so a candle's high/low is
        the max/min of the spot samples that landed in that time window and
        its open/close are the first/last sample in the window. With the
        mock provider's 2s tick cadence and a 60s bucket that's ~30 samples
        per candle - plenty to produce a real-looking wick, not a degenerate
        flat bar. The most recent (still-filling) bucket is included so the
        chart's rightmost candle is "live" and updates in place tick to
        tick, same as a real trading terminal.

        call_wall/put_wall/zero_gamma for each candle are taken from that
        bucket's last snapshot, so the overlay lines track the most current
        wall levels known as of that candle.
        """
        # Pull more raw rows than `limit` candles could possibly need, since
        # many raw ticks collapse into one candle.
        raw_limit = max(limit * 120, 500)
        with self._lock:
            conn = self._connect()
            try:
                rows = conn.execute(
                    "SELECT ts, spot, call_wall, put_wall, zero_gamma FROM snapshots "
                    "WHERE underlying = ? ORDER BY ts DESC LIMIT ?",
                    (underlying, raw_limit),
                ).fetchall()
            finally:
                conn.close()
        rows.reverse()  # oldest -> newest

        buckets: "Dict[int, Dict]" = {}
        order: List[int] = []
        for ts, spot, call_wall, put_wall, zero_gamma in rows:
            bucket_key = int(ts // bucket_seconds) * bucket_seconds
            b = buckets.get(bucket_key)
            if b is None:
                b = {
                    "bucket_ts": bucket_key,
                    "open": spot,
                    "high": spot,
                    "low": spot,
                    "close": spot,
                    "call_wall": call_wall,
                    "put_wall": put_wall,
                    "zero_gamma": zero_gamma,
                }
                buckets[bucket_key] = b
                order.append(bucket_key)
            else:
                b["high"] = max(b["high"], spot)
                b["low"] = min(b["low"], spot)
                b["close"] = spot
                b["call_wall"] = call_wall
                b["put_wall"] = put_wall
                b["zero_gamma"] = zero_gamma

        recent_keys = order[-limit:]
        return [buckets[k] for k in recent_keys]
