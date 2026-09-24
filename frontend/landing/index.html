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
import { renderGexHeatmap, nearTermCells, renderCandlestickWithWalls } from "/app/charts.js";

const SYMBOL = "SPY";
const POLL_MS = 4000; // gentler than the dashboard's own 2s cadence - this is a marketing preview, not a trading tool

// See the matching comment in frontend/app/app.js: futures-style index
// symbols (SPX; ES/NQ if they're ever added) quote in fixed $0.25
// increments. SPY itself is an ETF (penny pricing), so this is a no-op today
// given SYMBOL is hardcoded above - kept here so the hero stats stay correct
// automatically if this widget is ever pointed at SPX instead.
const FUTURES_TICK_SYMBOLS = new Set(["SPX", "ES", "NQ"]);
const FUTURES_TICK_SIZE = 0.25;

function roundToTick(n, symbol) {
  return FUTURES_TICK_SYMBOLS.has(symbol) ? Math.round(n / FUTURES_TICK_SIZE) * FUTURES_TICK_SIZE : n;
}

function fmtMoney(v) {
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function fmtPrice(v) {
  return v == null ? "—" : roundToTick(v, SYMBOL).toFixed(2);
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

function renderChart(result, candles) {
  // Same reuse pattern as renderPulse/renderTerrain above: the marketing
  // "Chart" section (Zerano's own showcase feature, matched here) reuses
  // the exact dashboard rendering code and the same by_strike array the
  // dot-matrix uses on /app and /app/session/ - this is a real live render
  // of the same feature, not a separate mockup of it.
  document.querySelectorAll(".js-chart-candles").forEach((container) => {
    renderCandlestickWithWalls(container, candles, {
      priceFormatter: fmtPrice,
      strikeExposure: result ? result.by_strike : null,
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

function formatDayLabel(dayStr) {
  const d = new Date(dayStr + "T00:00:00Z");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function setChartBadge(ok, showcaseLabel) {
  document.querySelectorAll(".js-chart-badge").forEach((el) => {
    if (!ok) {
      el.textContent = "connecting…";
      el.classList.remove("is-live");
      return;
    }
    el.textContent = showcaseLabel ? `${SYMBOL} · ${formatDayLabel(showcaseLabel)}` : SYMBOL + " · LIVE";
    el.classList.add("is-live");
  });
}

// A marketing preview should look good whenever someone lands on it - nights,
// weekends, or (found live 2026-09-24) the quiet pre-market stretch where a
// plan-inferred spot barely moves at all, since there's no fresh options
// trading yet to update it. A live rolling window can end up looking almost
// flat depending purely on what time it's viewed. Using the most recent
// CLOSED trading day instead - real historical data pulled from the same
// Replay endpoints the Session screen uses, not a mockup - means this panel
// reliably shows a full session's real movement no matter when the page
// loads. Resolved once and cached (a closed day's candles never change);
// falls back to the live rolling window if no closed day exists yet (a very
// new deployment with no history).
let showcaseCache; // undefined = not yet attempted; null = no closed day, use live; {candles, label} = resolved
async function getShowcaseCandles() {
  if (showcaseCache !== undefined) return showcaseCache;
  try {
    const daysResp = await fetch(`/api/session/${SYMBOL}/days`);
    if (daysResp.ok) {
      const { days } = await daysResp.json();
      if (days && days.length) {
        const day = days[0];
        const candlesResp = await fetch(`/api/candles/${SYMBOL}?day=${day}&bucket_seconds=300`);
        if (candlesResp.ok) {
          const data = await candlesResp.json();
          if (data.candles && data.candles.length) {
            showcaseCache = { candles: data.candles, label: day };
            return showcaseCache;
          }
        }
      }
    }
  } catch (err) {
    // fall through to live below
  }
  showcaseCache = null;
  return null;
}

async function poll() {
  try {
    const wantsChart = !!document.querySelector(".js-chart-candles");
    const showcase = wantsChart ? await getShowcaseCandles() : null;
    const [gexResp, candlesResp] = await Promise.all([
      fetch(`/api/gex/${SYMBOL}`),
      // Only fetch the live rolling window if this page has the chart panel
      // AND no closed-day showcase data was available - the hero/Pulse/
      // Terrain-only pages (methodology, faq, etc. reuse this same script)
      // shouldn't pay for a request they don't render, and once a showcase
      // day is cached there's no need to keep re-polling live candles for it.
      (wantsChart && !showcase) ? fetch(`/api/candles/${SYMBOL}?bucket_seconds=60&limit=80`) : Promise.resolve(null),
    ]);
    if (!gexResp.ok) throw new Error(`status ${gexResp.status}`);
    const result = await gexResp.json();
    renderHeroStats(result);
    renderPulse(result);
    renderTerrain(result);
    if (wantsChart) {
      if (showcase) {
        renderChart(result, showcase.candles);
      } else {
        const candlesData = candlesResp && candlesResp.ok ? await candlesResp.json() : { candles: [] };
        renderChart(result, candlesData.candles);
      }
      setChartBadge(true, showcase ? showcase.label : null);
    }
    setLiveBadges(true);
  } catch (err) {
    // Homepage widget failing (e.g. the backend is still warming up right
    // after a deploy) should never look like a broken page to a visitor -
    // just keep showing "connecting..." and retry on the next tick rather
    // than throwing or leaving stale/half-rendered charts up.
    setLiveBadges(false);
    setChartBadge(false, null);
  }
}

export function initPulseWidgets() {
  if (
    !document.querySelector(".js-pulse-heatmap") &&
    !document.querySelector(".js-terrain-heatmap") &&
    !document.querySelector(".js-chart-candles")
  ) return;
  poll();
  setInterval(poll, POLL_MS);
}
