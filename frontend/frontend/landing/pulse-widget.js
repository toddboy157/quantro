// Powers the two live, interactive heatmaps on the marketing homepage
// (Pulse + Terrain) plus the hero's live stat strip - all from ONE shared
// poll of /api/gex/<symbol>, since that single response already carries
// everything both widgets need (spot, walls, and the full by_strike_expiry
// grid Pulse/Terrain each render a different slice of). /api/gex/<symbol>
// is already anonymous-accessible for the first FREE_PLAN_UNDERLYING_LIMIT
// symbols (see backend/app/server.py _allowed_underlyings) - SPY is inside
// that free window, so this needs no login and no backend changes.
//
// Reuses the exact same rendering code the real dashboard uses
// (frontend/app/charts.js), imported cross-directory since it's served as
// a plain static file at /app/charts.js regardless of which page loads it.
import { renderGexHeatmap, nearTermCells } from "/app/charts.js";

const SYMBOL = "SPY";
const POLL_MS = 4000; // gentler than the dashboard's own 2s cadence - this is a marketing preview, not a trading tool

function fmtMoney(v) {
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  return `${sign}$${abs.toFixed(0)}`;
}

function fmtPrice(v) {
  return v == null ? "—" : v.toFixed(2);
}

function setStat(id, text, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  if (cls) el.className = "v " + cls;
}

function renderPulse(result) {
  // Rendered into every matching container on the page, not just one - the
  // hero's small preview and the dedicated "Pulse" section further down
  // both want the live near-term heatmap, and re-rendering an SVG into a
  // second container from the same already-fetched response costs nothing
  // extra over the network.
  const zoomed = nearTermCells(result.by_strike_expiry, result.spot, { maxExpiries: 2, strikeWindowPct: 0.06 });
  document.querySelectorAll(".js-pulse-heatmap").forEach((container) => {
    renderGexHeatmap(container, zoomed, result.spot, {
      valueFormatter: fmtMoney,
      callWall: result.call_wall,
      putWall: result.put_wall,
      maxStrikeLabels: 24,
    });
  });
}

function renderTerrain(result) {
  document.querySelectorAll(".js-terrain-heatmap").forEach((container) => {
    renderGexHeatmap(container, result.by_strike_expiry, result.spot, {
      valueFormatter: fmtMoney,
      callWall: result.call_wall,
      putWall: result.put_wall,
      maxStrikeLabels: 18,
    });
  });
}

function renderHeroStats(result) {
  setStat("hero-spot", fmtPrice(result.spot));
  setStat("hero-netgex", fmtMoney(result.net_gex), result.net_gex >= 0 ? "pos" : "neg");
  setStat("hero-callwall", fmtPrice(result.call_wall));
  setStat("hero-putwall", fmtPrice(result.put_wall));
  setStat("hero-zerogamma", fmtPrice(result.zero_gamma));
}

function setLiveBadges(live) {
  document.querySelectorAll(".js-live-badge").forEach((el) => {
    el.textContent = live ? SYMBOL + " · LIVE" : "connecting…";
    el.classList.toggle("is-live", live);
  });
}

async function poll() {
  try {
    const resp = await fetch(`/api/gex/${SYMBOL}`);
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const result = await resp.json();
    renderHeroStats(result);
    renderPulse(result);
    renderTerrain(result);
    setLiveBadges(true);
  } catch (err) {
    // Homepage widget failing (e.g. the backend is still warming up right
    // after a deploy) should never look like a broken page to a visitor -
    // just keep showing "connecting..." and retry on the next tick rather
    // than throwing or leaving stale/half-rendered charts up.
    setLiveBadges(false);
  }
}

export function initPulseWidgets() {
  if (!document.querySelector(".js-pulse-heatmap") && !document.querySelector(".js-terrain-heatmap")) return;
  poll();
  setInterval(poll, POLL_MS);
}
