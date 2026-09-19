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
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

_SCHEMA = """
CREATE TABLE IF NOT EXISTS snapshots (
    underlying TEXT NOT NULL,
    ts REAL NOT NULL,
    spot REAL NOT NULL,
    net_gex REAL NOT NULL,
    call_wall REAL,
    put_wall REAL,
    zero_gamma REAL,
    by_strike_json TEXT NOT NULL,
    by_strike_expiry_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_snapshots_underlying_ts ON snapshots(underlying, ts);
"""

# Added for the Session screen's day-replay feature: a closed day's Pulse
# and Terrain heatmaps need the full strike x expiry grid as it looked at
# each point in that day, not just the by-expiry summary the sparkline/
# history chart was already storing. Existing rows written before this
# column existed simply have NULL here (see the migration block in
# __init__) - session_replay() below skips those gracefully rather than
# erroring, so a volume with older history doesn't break on upgrade.


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
        # Migration for a volume that already has a `snapshots` table from
        # before by_strike_expiry_json existed: CREATE TABLE IF NOT EXISTS
        # above is a no-op on an existing table, so the new column has to be
        # added explicitly here, once, guarded by checking whether it's
        # already there (ALTER TABLE ADD COLUMN has no IF NOT EXISTS form).
        existing_cols = {row[1] for row in conn.execute("PRAGMA table_info(snapshots)").fetchall()}
        if "by_strike_expiry_json" not in existing_cols:
            conn.execute("ALTER TABLE snapshots ADD COLUMN by_strike_expiry_json TEXT")
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
                    "INSERT INTO snapshots (underlying, ts, spot, net_gex, call_wall, put_wall, zero_gamma, by_strike_json, by_strike_expiry_json) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        result["underlying"],
                        result["timestamp"],
                        result["spot"],
                        result["net_gex"],
                        result["call_wall"],
                        result["put_wall"],
                        result["zero_gamma"],
                        json.dumps(result["by_strike"]),
                        json.dumps(result.get("by_strike_expiry", [])),
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

    def candles(
        self,
        underlying: str,
        bucket_seconds: int = 60,
        limit: int = 200,
        day: Optional[str] = None,
    ) -> List[Dict]:
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

        `day` (a 'YYYY-MM-DD' UTC date string) switches this from "most
        recent N candles" to "every candle in that one closed day" - the
        Session screen's replay mode uses this so the candlestick chart
        shows a full session at once rather than a rolling recent window.
        """
        with self._lock:
            conn = self._connect()
            try:
                if day is not None:
                    try:
                        day_start = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp()
                    except ValueError:
                        return []
                    rows = conn.execute(
                        "SELECT ts, spot, call_wall, put_wall, zero_gamma FROM snapshots "
                        "WHERE underlying = ? AND ts >= ? AND ts < ? ORDER BY ts ASC",
                        (underlying, day_start, day_start + 86400),
                    ).fetchall()
                else:
                    # Pull more raw rows than `limit` candles could possibly
                    # need, since many raw ticks collapse into one candle.
                    raw_limit = max(limit * 120, 500)
                    rows = conn.execute(
                        "SELECT ts, spot, call_wall, put_wall, zero_gamma FROM snapshots "
                        "WHERE underlying = ? ORDER BY ts DESC LIMIT ?",
                        (underlying, raw_limit),
                    ).fetchall()
                    rows.reverse()  # oldest -> newest
            finally:
                conn.close()

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

        # In day-replay mode, return every candle for that day (there's no
        # "recent window" concept for a closed day); otherwise keep the
        # existing "most recent N" behavior for the live rolling chart.
        selected_keys = order if day is not None else order[-limit:]
        return [buckets[k] for k in selected_keys]

    def session_days(self, underlying: str, limit: int = 30) -> List[str]:
        """Distinct calendar dates (UTC, 'YYYY-MM-DD') that have stored
        snapshots for this underlying, most recent first - powers the
        Session screen's day picker. A day only shows up once it's fully
        past (see server.py's session_days endpoint, which drops today's
        own date) so replay never competes with the still-filling live
        session for attention."""
        with self._lock:
            conn = self._connect()
            try:
                rows = conn.execute(
                    "SELECT DISTINCT date(ts, 'unixepoch') AS d FROM snapshots "
                    "WHERE underlying = ? ORDER BY d DESC LIMIT ?",
                    (underlying, limit),
                ).fetchall()
            finally:
                conn.close()
        return [r[0] for r in rows]

    def session_replay(self, underlying: str, date_str: str, max_points: int = 180) -> List[Dict]:
        """Every stored snapshot for one calendar date (UTC), downsampled to
        at most max_points evenly-spaced points - this is what lets the
        Session screen's Pulse/Terrain heatmaps and ladder "tick" through a
        closed day as it's scrubbed, without shipping every raw 1-2s tick
        (a full day can be 10,000+ rows) over the wire. Rows written before
        by_strike_expiry_json existed come back with by_strike_expiry: []
        rather than raising, so old history degrades gracefully instead of
        blocking replay entirely.
        """
        try:
            day_start = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            return []
        start_ts = day_start.timestamp()
        end_ts = start_ts + 86400

        with self._lock:
            conn = self._connect()
            try:
                rows = conn.execute(
                    "SELECT ts, spot, call_wall, put_wall, zero_gamma, by_strike_expiry_json FROM snapshots "
                    "WHERE underlying = ? AND ts >= ? AND ts < ? ORDER BY ts ASC",
                    (underlying, start_ts, end_ts),
                ).fetchall()
            finally:
                conn.close()

        if not rows:
            return []

        # Evenly-spaced downsample rather than a naive "every Nth row" off
        # the front, so the selected points span the whole day (open to
        # close) instead of clustering wherever ticks happened to be denser.
        if len(rows) > max_points:
            step = len(rows) / max_points
            rows = [rows[int(i * step)] for i in range(max_points)]

        out = []
        for ts, spot, call_wall, put_wall, zero_gamma, by_strike_expiry_json in rows:
            try:
                cells = json.loads(by_strike_expiry_json) if by_strike_expiry_json else []
            except (TypeError, ValueError):
                cells = []
            out.append(
                {
                    "timestamp": ts,
                    "spot": spot,
                    "call_wall": call_wall,
                    "put_wall": put_wall,
                    "zero_gamma": zero_gamma,
                    "by_strike_expiry": cells,
                }
            )
        return out
