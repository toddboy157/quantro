// Polling-based "live" client. See backend/app/server.py for why this
// polls instead of using a WebSocket in this build environment, and what
// the swap to a push socket would look like later.
import { renderZeroCenteredBarChart, renderDualLineChart, renderCandlestickWithWalls, renderGexHeatmap, nearTermCells } from "./charts.js";

const POLL_MS = 2000;

const state = { symbols: [], refreshIntervalSeconds: 2 };

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
  chartByStrike: document.getElementById("chart-bystrike"),
  chartLiveMap: document.getElementById("chart-livemap"),
  chartByExpiry: document.getElementById("chart-byexpiry"),
  chartHistory: document.getElementById("chart-history"),
  dataBadge: document.getElementById("data-badge"),
  footerNote: document.getElementById("footer-note"),
};

let missedTicks = 0;

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
  state.refreshIntervalSeconds = data.refresh_interval_seconds;
  state.provider = data.provider;
  state.plan = data.plan;
  state.locked = data.locked_underlyings || [];
  const lockedSet = new Set(state.locked);
  els.select.innerHTML = state.symbols
    .map((s) => {
      if (lockedSet.has(s)) {
        return `<option value="${s}" disabled>🔒 ${s} — Live plan</option>`;
      }
      return `<option value="${s}">${s}</option>`;
    })
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
    ? "Prototype build · data from a simulated provider (see backend/app/providers/mock_provider.py) · swap DATA_PROVIDER=polygon in backend/.env once a live key is wired up."
    : `Prototype build · live data via ${provider}.`;
}

function updateSummary(result) {
  els.spot.textContent = fmtPrice(result.spot);
  els.netgex.textContent = fmtMoney(result.net_gex);
  setValueClass(els.netgex, result.net_gex);
  els.callwall.textContent = fmtPrice(result.call_wall);
  els.putwall.textContent = fmtPrice(result.put_wall);
  els.zerogamma.textContent = fmtPrice(result.zero_gamma);
}

function updateByStrikeChart(result) {
  const rows = result.by_strike;
  renderZeroCenteredBarChart(
    els.chartByStrike,
    rows.map((r) => r.strike.toLocaleString()),
    rows.map((r) => r.net_gex),
    { valueFormatter: fmtMoney, maxLabels: 20 }
  );
}

function updateExpiryMap(result) {
  renderGexHeatmap(els.chartByExpiry, result.by_strike_expiry, result.spot, {
    valueFormatter: fmtMoney,
    callWall: result.call_wall,
    putWall: result.put_wall,
  });
}

function updateLiveMap(result) {
  // Zoomed to the nearest two expiries and strikes within ~6% of spot - the
  // "what's mechanical right now" companion to the full multi-expiry map
  // above, refreshed every poll tick just like the rest of the dashboard.
  const zoomed = nearTermCells(result.by_strike_expiry, result.spot, { maxExpiries: 2, strikeWindowPct: 0.06 });
  renderGexHeatmap(els.chartLiveMap, zoomed, result.spot, {
    valueFormatter: fmtMoney,
    callWall: result.call_wall,
    putWall: result.put_wall,
    maxStrikeLabels: 30,
  });
}

function updateCandlesChart(candles) {
  renderCandlestickWithWalls(els.chartCandles, candles, { priceFormatter: fmtPrice });
}

function updateHistoryChart(history) {
  if (history.length < 2) return;
  const labels = history.map((h) => new Date(h.timestamp * 1000).toLocaleTimeString());
  renderDualLineChart(
    els.chartHistory,
    labels,
    history.map((h) => h.net_gex),
    history.map((h) => h.spot),
    { labelA: "Net GEX", labelB: "Spot", colorA: "#5b8dff", colorB: "#f5b544", formatterA: fmtMoney, formatterB: fmtPrice }
  );
}

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

async function pollOnce() {
  const symbol = els.select.value;
  if (!symbol) return;
  try {
    const [gexRes, histRes, candlesRes] = await Promise.all([
      fetch(`/api/gex/${symbol}`),
      fetch(`/api/history/${symbol}?limit=120`),
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
    const histData = histRes.ok ? await histRes.json() : { history: [] };
    const candlesData = candlesRes.ok ? await candlesRes.json() : { candles: [] };

    updateSummary(result);
    updateCandlesChart(candlesData.candles);
    updateLiveMap(result);
    updateByStrikeChart(result);
    updateExpiryMap(result);
    updateHistoryChart(histData.history);
    setStatus(true);
  } catch (err) {
    console.error(err);
    setStatus(false);
  }
}

async function main() {
  await loadUnderlyings();
  els.select.addEventListener("change", pollOnce);
  await pollOnce();
  setInterval(pollOnce, POLL_MS);
}

main();
