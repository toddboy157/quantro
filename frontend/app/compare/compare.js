// Multi-underlying comparison view: one table + one bar chart summarizing
// every underlying's current positioning side by side, so you can spot
// which names are sitting in a negative-gamma pocket vs. pinned safely
// above zero-gamma at a glance, instead of switching the main dashboard's
// single-symbol dropdown one at a time.
import { renderZeroCenteredBarChart } from "../charts.js";

const POLL_MS = 2000;
const state = {};

const els = {
  lockNoteRow: document.getElementById("lock-note-row"),
  statusDot: document.getElementById("status-dot"),
  statusText: document.getElementById("status-text"),
  chartCompareGex: document.getElementById("chart-compare-gex"),
  compareTbody: document.getElementById("compare-tbody"),
  dataBadge: document.getElementById("data-badge"),
  footerNote: document.getElementById("footer-note"),
};

let missedTicks = 0;

// See the matching comment in frontend/app/app.js: futures-style index
// symbols (SPX here; ES/NQ if they're ever added) quote in fixed $0.25
// increments, so this table's Spot/Call Wall/Put Wall/Zero Gamma columns
// round to the nearest real tick for those symbols only - individual stocks
// keep normal penny pricing. Unlike the single-symbol dashboard/Session
// screen, this view shows every symbol at once, so fmtPrice needs the
// symbol passed in explicitly rather than reading one shared dropdown.
const FUTURES_TICK_SYMBOLS = new Set(["SPX", "ES", "NQ"]);
const FUTURES_TICK_SIZE = 0.25;

function roundToTick(n, symbol) {
  return FUTURES_TICK_SYMBOLS.has(symbol) ? Math.round(n / FUTURES_TICK_SIZE) * FUTURES_TICK_SIZE : n;
}

function fmtMoney(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function fmtPrice(n, symbol) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return roundToTick(n, symbol).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function applyProviderBadge(provider) {
  const isMock = (provider || "").toLowerCase() === "mock";
  els.dataBadge.textContent = isMock ? "SIMULATED DATA" : `LIVE DATA (${provider})`;
  els.dataBadge.classList.toggle("badge-live", !isMock);
  els.footerNote.textContent = isMock
    ? "Prototype build · data from a simulated provider · swap DATA_PROVIDER=polygon in backend/.env once a live key is wired up."
    : `Prototype build · live data via ${provider}.`;
}

function applyLockNote(data) {
  if (!data.locked_underlyings || data.locked_underlyings.length === 0) {
    els.lockNoteRow.innerHTML = "";
    return;
  }
  els.lockNoteRow.innerHTML = `
    <div class="symbol-lock-note">
      🔒 ${data.locked_underlyings.join(", ")} ${data.locked_underlyings.length === 1 ? "is" : "are"} locked on the
      ${data.plan === "free" ? "Delayed" : data.plan} plan — <a href="/pricing/">upgrade to Live</a> to compare the full universe.
    </div>
  `;
}

function setStatus(ok) {
  if (ok) {
    missedTicks = 0;
    els.statusDot.className = "dot live";
    els.statusText.textContent = "live";
  } else {
    missedTicks += 1;
    if (missedTicks >= 3) {
      els.statusDot.className = "dot stale";
      els.statusText.textContent = "no data";
    }
  }
}

function renderTable(results, locked) {
  const rows = Object.entries(results).map(([symbol, r]) => `
    <tr>
      <td><strong>${symbol}</strong></td>
      <td>${fmtPrice(r.spot, symbol)}</td>
      <td style="color: ${r.net_gex >= 0 ? "var(--green)" : "var(--red)"}">${fmtMoney(r.net_gex)}</td>
      <td>${fmtPrice(r.call_wall, symbol)}</td>
      <td>${fmtPrice(r.put_wall, symbol)}</td>
      <td>${fmtPrice(r.zero_gamma, symbol)}</td>
    </tr>
  `);
  const lockedRows = locked.map((symbol) => `
    <tr style="opacity: 0.5;">
      <td><strong>${symbol}</strong></td>
      <td colspan="5">🔒 Requires the Live plan — <a href="/pricing/" style="color: var(--accent);">upgrade</a></td>
    </tr>
  `);
  els.compareTbody.innerHTML = rows.join("") + lockedRows.join("");
}

function renderChart(results) {
  const symbols = Object.keys(results);
  renderZeroCenteredBarChart(
    els.chartCompareGex,
    symbols,
    symbols.map((s) => results[s].net_gex),
    { valueFormatter: fmtMoney, maxLabels: symbols.length }
  );
}

async function pollOnce() {
  try {
    const [underlyingsRes, compareRes] = await Promise.all([
      fetch("/api/underlyings"),
      fetch("/api/gex-all"),
    ]);
    if (!underlyingsRes.ok || !compareRes.ok) {
      setStatus(false);
      return;
    }
    const underlyingsData = await underlyingsRes.json();
    const compareData = await compareRes.json();

    applyProviderBadge(underlyingsData.provider);
    applyLockNote(compareData);
    renderTable(compareData.results, compareData.locked_underlyings);
    renderChart(compareData.results);
    setStatus(true);
  } catch (err) {
    console.error(err);
    setStatus(false);
  }
}

async function main() {
  await pollOnce();
  setInterval(pollOnce, POLL_MS);
}

main();
