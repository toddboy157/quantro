// The "Session screen": one page combining the candlestick+walls chart, a
// price ladder, and the Pulse/Terrain heatmaps, all driven off ONE shared
// "current moment" - either the live tick (polled the same way the main
// dashboard does) or, in Replay mode, whichever point in a closed day the
// scrub slider is sitting on. That shared state is what makes the ladder
// and heatmaps "tick with" the chart instead of being three independently
// refreshing panels that happen to sit on the same page.
import { renderCandlestickWithWalls, renderGexHeatmap, nearTermCells } from "../charts.js";

const POLL_MS = 2000;

const state = {
  symbols: [],
  locked: [],
  provider: null,
  mode: "live", // "live" | "replay"
  replay: { days: [], date: null, candles: [], snapshots: [], index: 0 },
};

const els = {
  select: document.getElementById("symbol-select"),
  lockNoteRow: document.getElementById("lock-note-row"),
  statusDot: document.getElementById("status-dot"),
  statusText: document.getElementById("status-text"),
  spot: document.getElementById("v-spot"),
  netgex: document.getElementById("v-netgex"),
  callwall: document.getElementById("v-callwall"),
  putwall: document.getElementById("v-putwall"),
  zerogamma: document.getElementById("v-zerogamma"),
  chartCandles: document.getElementById("chart-candles"),
  chartPulse: document.getElementById("chart-pulse"),
  chartTerrain: document.getElementById("chart-terrain"),
  ladder: document.getElementById("ladder"),
  dataBadge: document.getElementById("data-badge"),
  footerNote: document.getElementById("footer-note"),
  modeToggle: document.getElementById("mode-toggle"),
  replayBar: document.getElementById("replay-bar"),
  replayDaySelect: document.getElementById("replay-day-select"),
  replayScrub: document.getElementById("replay-scrub"),
  replayTimeLabel: document.getElementById("replay-time-label"),
};

let missedTicks = 0;
let liveTimer = null;

function fmtMoney(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function fmtPrice(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function setValueClass(el, n) {
  el.classList.remove("positive", "negative");
  if (n > 0) el.classList.add("positive");
  else if (n < 0) el.classList.add("negative");
}

async function loadUnderlyings() {
  const res = await fetch("/api/underlyings");
  const data = await res.json();
  state.symbols = data.underlyings;
  state.provider = data.provider;
  state.locked = data.locked_underlyings || [];
  const lockedSet = new Set(state.locked);
  els.select.innerHTML = state.symbols
    .map((s) => (lockedSet.has(s) ? `<option value="${s}" disabled>🔒 ${s} — Live plan</option>` : `<option value="${s}">${s}</option>`))
    .join("");
  applyProviderBadge(data.provider);
  applyLockNote(data);
}

function applyLockNote(data) {
  if (!data.locked_underlyings || data.locked_underlyings.length === 0) {
    els.lockNoteRow.innerHTML = "";
    return;
  }
  els.lockNoteRow.innerHTML = `
    <div class="symbol-lock-note">
      🔒 ${data.locked_underlyings.join(", ")} ${data.locked_underlyings.length === 1 ? "is" : "are"} locked on the
      ${data.plan === "free" ? "Delayed" : data.plan} plan — <a href="/pricing/">upgrade to Live</a> to unlock the full universe.
    </div>
  `;
}

function applyProviderBadge(provider) {
  const isMock = (provider || "").toLowerCase() === "mock";
  els.dataBadge.textContent = isMock ? "SIMULATED DATA" : `LIVE DATA (${provider})`;
  els.dataBadge.classList.toggle("badge-live", !isMock);
  els.footerNote.textContent = isMock
    ? "Prototype build · data from a simulated provider · swap DATA_PROVIDER=polygon in backend/.env once a live key is wired up."
    : `Prototype build · live data via ${provider}.`;
}

// -------------------------------------------------------------------------
// Shared "current moment" renderers - both live polling and replay
// scrubbing funnel into these, so the chart/ladder/heatmaps never drift
// out of sync with each other regardless of which mode is driving them.
// -------------------------------------------------------------------------

function renderSummary(moment) {
  els.spot.textContent = fmtPrice(moment.spot);
  if (moment.net_gex != null) {
    els.netgex.textContent = fmtMoney(moment.net_gex);
    setValueClass(els.netgex, moment.net_gex);
  } else {
    els.netgex.textContent = "—";
  }
  els.callwall.textContent = fmtPrice(moment.call_wall);
  els.putwall.textContent = fmtPrice(moment.put_wall);
  els.zerogamma.textContent = fmtPrice(moment.zero_gamma);
}

function renderLadder(moment) {
  const rows = [
    { key: "call", label: "Call Wall", value: moment.call_wall },
    { key: "spot", label: "Spot", value: moment.spot },
    { key: "flip", label: "Zero Gamma", value: moment.zero_gamma },
    { key: "put", label: "Put Wall", value: moment.put_wall },
  ].filter((r) => r.value != null);
  // Sorted by price, highest first - a real ladder, not a fixed list: when
  // spot crosses the zero-gamma flip (or, on a wide-ranging day, a wall),
  // its row visibly moves rather than staying pinned in place.
  rows.sort((a, b) => b.value - a.value);
  els.ladder.innerHTML = rows
    .map(
      (r) => `
    <div class="ladder-row ladder-${r.key}">
      <span class="ladder-dot"></span>
      <span class="ladder-label">${r.label}</span>
      <span class="ladder-value">${fmtPrice(r.value)}</span>
    </div>`
    )
    .join("");
}

function renderPulseTerrain(moment) {
  const cells = moment.by_strike_expiry || [];
  if (cells.length === 0) {
    els.chartPulse.innerHTML = '<div class="chart-empty-note">No positioning grid stored for this moment yet.</div>';
    els.chartTerrain.innerHTML = '<div class="chart-empty-note">No positioning grid stored for this moment yet.</div>';
    return;
  }
  const zoomed = nearTermCells(cells, moment.spot, { maxExpiries: 2, strikeWindowPct: 0.06 });
  renderGexHeatmap(els.chartPulse, zoomed, moment.spot, {
    valueFormatter: fmtMoney,
    callWall: moment.call_wall,
    putWall: moment.put_wall,
    maxStrikeLabels: 30,
  });
  renderGexHeatmap(els.chartTerrain, cells, moment.spot, {
    valueFormatter: fmtMoney,
    callWall: moment.call_wall,
    putWall: moment.put_wall,
  });
}

function renderChart(candles, playheadIndex) {
  renderCandlestickWithWalls(els.chartCandles, candles, { priceFormatter: fmtPrice, playheadIndex });
}

// -------------------------------------------------------------------------
// Live mode
// -------------------------------------------------------------------------

function setStatus(ok) {
  if (ok) {
    missedTicks = 0;
    els.statusDot.className = "dot live";
    const isMock = (state.provider || "").toLowerCase() === "mock";
    els.statusText.textContent = isMock ? "live (simulated)" : "live";
  } else {
    missedTicks += 1;
    if (missedTicks >= 3) {
      els.statusDot.className = "dot stale";
      els.statusText.textContent = "no data";
    }
  }
}

async function pollLiveOnce() {
  if (state.mode !== "live") return;
  const symbol = els.select.value;
  if (!symbol) return;
  try {
    const [gexRes, candlesRes] = await Promise.all([
      fetch(`/api/gex/${symbol}`),
      fetch(`/api/candles/${symbol}?bucket_seconds=15&limit=80`),
    ]);
    if (gexRes.status === 403) {
      els.statusDot.className = "dot stale";
      els.statusText.textContent = "locked — upgrade to view";
      return;
    }
    if (!gexRes.ok) {
      setStatus(false);
      return;
    }
    const result = await gexRes.json();
    const candlesData = candlesRes.ok ? await candlesRes.json() : { candles: [] };

    renderSummary(result);
    renderLadder(result);
    renderPulseTerrain(result);
    renderChart(candlesData.candles, null); // no playhead needed live - the rightmost candle IS "now"
    setStatus(true);
  } catch (err) {
    console.error(err);
    setStatus(false);
  }
}

function startLivePolling() {
  stopLivePolling();
  pollLiveOnce();
  liveTimer = setInterval(pollLiveOnce, POLL_MS);
}

function stopLivePolling() {
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = null;
}

// -------------------------------------------------------------------------
// Replay mode
// -------------------------------------------------------------------------

async function loadReplayDays() {
  const symbol = els.select.value;
  if (!symbol) return;
  els.statusText.textContent = "loading days…";
  const res = await fetch(`/api/session/${symbol}/days`);
  const data = res.ok ? await res.json() : { days: [] };
  state.replay.days = data.days || [];
  if (state.replay.days.length === 0) {
    els.replayDaySelect.innerHTML = '<option value="">No closed days yet</option>';
    els.replayDaySelect.disabled = true;
    els.replayScrub.disabled = true;
    els.statusText.textContent = "no history to replay yet";
    els.statusDot.className = "dot stale";
    clearMoment();
    return;
  }
  els.replayDaySelect.disabled = false;
  els.replayDaySelect.innerHTML = state.replay.days.map((d) => `<option value="${d}">${d}</option>`).join("");
  await loadReplayDay(state.replay.days[0]);
}

async function loadReplayDay(dateStr) {
  const symbol = els.select.value;
  if (!symbol || !dateStr) return;
  els.statusText.textContent = `loading ${dateStr}…`;
  const res = await fetch(`/api/session/${symbol}/replay?date=${dateStr}`);
  if (!res.ok) {
    els.statusText.textContent = `no data for ${dateStr}`;
    els.statusDot.className = "dot stale";
    return;
  }
  const data = await res.json();
  state.replay.date = dateStr;
  state.replay.candles = data.candles || [];
  state.replay.snapshots = data.snapshots || [];
  const maxIdx = Math.max(0, state.replay.snapshots.length - 1);
  els.replayScrub.min = 0;
  els.replayScrub.max = maxIdx;
  els.replayScrub.value = 0;
  els.replayScrub.disabled = state.replay.snapshots.length === 0;
  applyReplayIndex(0);
  els.statusDot.className = "dot live";
  els.statusText.textContent = `replay · ${dateStr}`;
}

function nearestCandleIndex(candles, ts) {
  if (!candles || candles.length === 0) return null;
  let best = 0;
  let bestDiff = Infinity;
  candles.forEach((c, i) => {
    const diff = Math.abs(c.bucket_ts - ts);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  });
  return best;
}

function applyReplayIndex(idx) {
  const snapshots = state.replay.snapshots;
  if (!snapshots || snapshots.length === 0) return;
  const i = Math.max(0, Math.min(idx, snapshots.length - 1));
  state.replay.index = i;
  const moment = snapshots[i];
  els.replayTimeLabel.textContent = new Date(moment.timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  renderSummary(moment);
  renderLadder(moment);
  renderPulseTerrain(moment);
  const playheadIndex = nearestCandleIndex(state.replay.candles, moment.timestamp);
  renderChart(state.replay.candles, playheadIndex);
}

function clearMoment() {
  els.spot.textContent = "—";
  els.netgex.textContent = "—";
  els.callwall.textContent = "—";
  els.putwall.textContent = "—";
  els.zerogamma.textContent = "—";
  els.ladder.innerHTML = "";
  els.chartPulse.innerHTML = "";
  els.chartTerrain.innerHTML = "";
  renderChart([], null);
}

// -------------------------------------------------------------------------
// Mode switching + wiring
// -------------------------------------------------------------------------

function setMode(mode) {
  state.mode = mode;
  els.modeToggle.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
  els.replayBar.hidden = mode !== "replay";
  if (mode === "live") {
    startLivePolling();
  } else {
    stopLivePolling();
    loadReplayDays();
  }
}

async function main() {
  await loadUnderlyings();

  els.select.addEventListener("change", () => {
    if (state.mode === "live") {
      pollLiveOnce();
    } else {
      loadReplayDays();
    }
  });

  els.modeToggle.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  });

  els.replayDaySelect.addEventListener("change", (e) => loadReplayDay(e.target.value));
  els.replayScrub.addEventListener("input", (e) => applyReplayIndex(Number(e.target.value)));

  setMode("live");
}

main();
