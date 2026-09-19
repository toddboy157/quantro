// Tiny dependency-free SVG chart helpers. No CDN, no build step - the
// whole frontend is three static files. Good enough for a prototype
// dashboard; swap for a real charting library (lightweight-charts, etc.)
// once the product direction is locked in and you want candles/zoom/pan.

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function clear(container) {
  while (container.firstChild) container.removeChild(container.firstChild);
}

function pickLabelStride(n, maxLabels) {
  return Math.max(1, Math.ceil(n / maxLabels));
}

/**
 * Zero-centered bar chart: bars grow up (positive) or down (negative) from
 * a horizontal zero line. Used for GEX-by-strike and GEX-by-expiry.
 */
export function renderZeroCenteredBarChart(container, labels, values, { valueFormatter = (v) => v, maxLabels = 18 } = {}) {
  clear(container);
  const width = 1000, height = 280;
  const padL = 64, padR = 12, padT = 14, padB = 46;
  const innerW = width - padL - padR, innerH = height - padT - padB;

  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", height: "100%" });

  const maxAbs = Math.max(1e-9, ...values.map((v) => Math.abs(v)));
  const zeroY = padT + innerH / 2;
  const scaleY = (v) => zeroY - (v / maxAbs) * (innerH / 2);

  // gridlines + axis labels (max, 0, -max)
  [maxAbs, 0, -maxAbs].forEach((gv) => {
    const y = scaleY(gv);
    svg.appendChild(svgEl("line", { x1: padL, x2: width - padR, y1: y, y2: y, stroke: "#1c2130", "stroke-width": 1 }));
    const t = svgEl("text", { x: padL - 8, y: y + 4, fill: "#8791a8", "font-size": 11, "text-anchor": "end" });
    t.textContent = valueFormatter(gv);
    svg.appendChild(t);
  });

  const n = values.length;
  if (n === 0) {
    container.appendChild(svg);
    return;
  }
  const slot = innerW / n;
  const barW = Math.max(1, slot * 0.7);
  const stride = pickLabelStride(n, maxLabels);

  values.forEach((v, i) => {
    const x = padL + i * slot + (slot - barW) / 2;
    const y0 = scaleY(0), y1 = scaleY(v);
    const y = Math.min(y0, y1), h = Math.max(0.5, Math.abs(y1 - y0));
    const rect = svgEl("rect", {
      x, y, width: barW, height: h,
      fill: v >= 0 ? "rgba(46, 207, 122, 0.85)" : "rgba(239, 74, 95, 0.85)",
    });
    const title = svgEl("title");
    title.textContent = `${labels[i]}: ${valueFormatter(v)}`;
    rect.appendChild(title);
    svg.appendChild(rect);

    if (i % stride === 0) {
      const lbl = svgEl("text", {
        x: x + barW / 2, y: height - padB + 16, fill: "#8791a8", "font-size": 10, "text-anchor": "middle",
      });
      lbl.textContent = labels[i];
      svg.appendChild(lbl);
    }
  });

  container.appendChild(svg);
}

/**
 * Candlestick chart of spot price with horizontal reference lines for the
 * call wall, put wall, and zero-gamma flip level overlaid on top - the
 * signature Zerano/Skylit "dealer positioning vs. price" visual. Each
 * candle is one time bucket of spot ticks (see storage.py SnapshotStore.candles);
 * green body = close >= open, red = close < open, thin wick = high/low.
 */
export function renderCandlestickWithWalls(container, candles, {
  priceFormatter = (v) => v.toFixed(2),
  timeFormatter = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  maxLabels = 10,
  playheadIndex = null,
} = {}) {
  clear(container);
  const width = 1000, height = 340;
  const padL = 64, padR = 76, padT = 14, padB = 34;
  const innerW = width - padL - padR, innerH = height - padT - padB;

  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", height: "100%" });

  const n = candles.length;
  if (n === 0) {
    const t = svgEl("text", { x: width / 2, y: height / 2, fill: "#8791a8", "font-size": 12, "text-anchor": "middle" });
    t.textContent = "Waiting for enough ticks to form a candle…";
    svg.appendChild(t);
    container.appendChild(svg);
    return;
  }

  // Latest known wall levels (last candle that actually has them) drive the
  // overlay lines - these track the most current dealer positioning read.
  let callWall = null, putWall = null, zeroGamma = null;
  for (let i = n - 1; i >= 0; i--) {
    const c = candles[i];
    if (callWall === null && c.call_wall != null) callWall = c.call_wall;
    if (putWall === null && c.put_wall != null) putWall = c.put_wall;
    if (zeroGamma === null && c.zero_gamma != null) zeroGamma = c.zero_gamma;
    if (callWall !== null && putWall !== null && zeroGamma !== null) break;
  }

  const allValues = [];
  candles.forEach((c) => { allValues.push(c.high, c.low); });
  [callWall, putWall, zeroGamma].forEach((v) => { if (v != null) allValues.push(v); });
  let vMin = Math.min(...allValues), vMax = Math.max(...allValues);
  if (vMin === vMax) { vMin -= 1; vMax += 1; }
  const pad = (vMax - vMin) * 0.08;
  vMin -= pad; vMax += pad;

  const scaleY = (v) => padT + innerH - ((v - vMin) / (vMax - vMin)) * innerH;
  const slot = innerW / n;
  const bodyW = Math.max(2, slot * 0.6);

  // gridlines + price axis (5 ticks)
  for (let g = 0; g <= 4; g++) {
    const v = vMin + (g / 4) * (vMax - vMin);
    const y = scaleY(v);
    svg.appendChild(svgEl("line", { x1: padL, x2: width - padR, y1: y, y2: y, stroke: "#1c2130", "stroke-width": 1 }));
    const t = svgEl("text", { x: padL - 8, y: y + 4, fill: "#8791a8", "font-size": 11, "text-anchor": "end" });
    t.textContent = priceFormatter(v);
    svg.appendChild(t);
  }

  // candles
  candles.forEach((c, i) => {
    const cx = padL + i * slot + slot / 2;
    const up = c.close >= c.open;
    const color = up ? "rgba(46, 207, 122, 0.95)" : "rgba(239, 74, 95, 0.95)";
    svg.appendChild(svgEl("line", {
      x1: cx, x2: cx, y1: scaleY(c.high), y2: scaleY(c.low), stroke: color, "stroke-width": 1.4,
    }));
    const yOpen = scaleY(c.open), yClose = scaleY(c.close);
    const y = Math.min(yOpen, yClose), h = Math.max(1.5, Math.abs(yClose - yOpen));
    const rect = svgEl("rect", { x: cx - bodyW / 2, y, width: bodyW, height: h, fill: color });
    const title = svgEl("title");
    title.textContent = `${timeFormatter(c.bucket_ts)}  O ${priceFormatter(c.open)}  H ${priceFormatter(c.high)}  L ${priceFormatter(c.low)}  C ${priceFormatter(c.close)}`;
    rect.appendChild(title);
    svg.appendChild(rect);
  });

  // wall / zero-gamma overlay lines, drawn on top of the candles
  const overlays = [
    { value: callWall, color: "#2ecf7a", label: "Call wall" },
    { value: putWall, color: "#ef4a5f", label: "Put wall" },
    { value: zeroGamma, color: "#7c8cff", label: "Zero Γ" },
  ];
  overlays.forEach(({ value, color, label }) => {
    if (value == null) return;
    const y = scaleY(value);
    svg.appendChild(svgEl("line", {
      x1: padL, x2: width - padR, y1: y, y2: y, stroke: color, "stroke-width": 1.4, "stroke-dasharray": "6 4",
    }));
    const tag = svgEl("text", { x: width - padR + 8, y: y + 4, fill: color, "font-size": 10, "text-anchor": "start" });
    tag.textContent = `${label} ${priceFormatter(value)}`;
    svg.appendChild(tag);
  });

  // time axis labels
  const stride = pickLabelStride(n, maxLabels);
  candles.forEach((c, i) => {
    if (i % stride !== 0 && i !== n - 1) return;
    const cx = padL + i * slot + slot / 2;
    const t = svgEl("text", { x: cx, y: height - padB + 16, fill: "#8791a8", "font-size": 10, "text-anchor": "middle" });
    t.textContent = timeFormatter(c.bucket_ts);
    svg.appendChild(t);
  });

  // Playhead: a vertical marker at one specific candle - this is what keeps
  // the Session screen's ladder and heatmaps visibly "on the same time
  // axis" as this chart. In replay mode it tracks the scrub position; in
  // live mode it's left null and simply isn't drawn (the rightmost candle
  // IS the live position, no marker needed).
  if (playheadIndex != null && playheadIndex >= 0 && playheadIndex < n) {
    const cx = padL + playheadIndex * slot + slot / 2;
    svg.appendChild(svgEl("line", {
      x1: cx, x2: cx, y1: padT, y2: padT + innerH, stroke: "#e6e9f0", "stroke-width": 1.2, "stroke-dasharray": "3 3", opacity: 0.75,
    }));
    svg.appendChild(svgEl("circle", { cx, cy: padT + innerH, r: 3.5, fill: "#e6e9f0" }));
  }

  container.appendChild(svg);
}

let _heatmapGradientCounter = 0;

/**
 * Collapses adjacent strikes into a fixed number of price bands, summing
 * net_gex within each band. Found live (Round 10, comparing this against
 * Zerano's screenshots): SPY's real chain lists strikes in $1 increments
 * near the money - 100+ distinct rows for a single expiry - which, crammed
 * into one fixed-height box, gives each row only 1-2 pixels of height. The
 * per-row color IS varying correctly by then (confirmed against the real
 * captured numbers), it's just too thin a strip to perceive as texture, so
 * the whole grid still reads as flat, blocky bands even after the color-
 * scale fix. Zerano's own screenshots show roughly 20-40 rows per panel,
 * not 100+. Grouping every N *adjacent* strikes (by sort order, not by
 * fixed dollar width) into one row keeps the dense near-the-money area
 * meaningfully thick while leaving the already-sparse far-OTM strikes close
 * to 1:1, and strengthens the real signal instead of hiding it (ten
 * strikes each worth $2-5M sum into one $30M row, which is far easier to
 * see against a $537M peak than any one of them alone was).
 */
function _bucketCellsByStrike(cells, maxRows) {
  const strikesAsc = [...new Set(cells.map((c) => c.strike))].sort((a, b) => a - b);
  if (strikesAsc.length <= maxRows) return cells;

  const bucketSize = Math.ceil(strikesAsc.length / maxRows);
  const strikeToBand = new Map(); // strike -> { rep, lo, hi }
  for (let i = 0; i < strikesAsc.length; i += bucketSize) {
    const group = strikesAsc.slice(i, i + bucketSize);
    const band = { rep: (group[0] + group[group.length - 1]) / 2, lo: group[0], hi: group[group.length - 1] };
    group.forEach((s) => strikeToBand.set(s, band));
  }

  const agg = new Map(); // "expiry|rep" -> { expiry_days, strike, net_gex, lo, hi }
  cells.forEach((c) => {
    const band = strikeToBand.get(c.strike);
    const key = `${c.expiry_days}|${band.rep}`;
    const existing = agg.get(key);
    if (existing) existing.net_gex += c.net_gex;
    else agg.set(key, { expiry_days: c.expiry_days, strike: band.rep, net_gex: c.net_gex, lo: band.lo, hi: band.hi });
  });
  return [...agg.values()];
}

/**
 * Interpolates the standard "viridis" perceptual colormap (dark purple ->
 * blue -> teal -> green -> yellow) at t in [0, 1]. Chosen to match the
 * dense, terminal-style heatmaps on zerano.club/skylit.ai, which use a
 * sequential palette with printed per-cell values rather than a simple
 * red/green diverging wash.
 */
function _viridisRGB(t) {
  const stops = [
    [0.00, 68, 1, 84],
    [0.25, 59, 82, 139],
    [0.50, 33, 145, 140],
    [0.75, 94, 201, 98],
    [1.00, 253, 231, 37],
  ];
  const tt = Math.min(1, Math.max(0, t));
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, r0, g0, b0] = stops[i];
    const [t1, r1, g1, b1] = stops[i + 1];
    if (tt >= t0 && tt <= t1) {
      const f = (tt - t0) / (t1 - t0 || 1);
      return [Math.round(r0 + (r1 - r0) * f), Math.round(g0 + (g1 - g0) * f), Math.round(b0 + (b1 - b0) * f)];
    }
  }
  const last = stops[stops.length - 1];
  return [last[1], last[2], last[3]];
}

/**
 * Strike x expiry "dealer positioning map" heatmap, styled to match the
 * dense terminal look on zerano.club/skylit.ai rather than a soft abstract
 * gradient: a viridis (purple -> blue -> teal -> green -> yellow) palette,
 * a visible grid of bordered cells, the actual formatted value printed in
 * each cell, and a bright highlight on each column's single most extreme
 * strike - the same "one number jumps out per column" pattern in Zerano's
 * own screenshots. Rows are strikes (highest at top, like a depth-of-book
 * ladder), columns are expiry buckets (nearest-dated first).
 *
 * Color is assigned by PERCENTILE RANK of each cell's raw net_gex among all
 * currently-visible cells, not by its raw fraction of the largest value.
 * Found live (Round 9/10): a straight magnitude scale lets one dominant
 * strike (e.g. a real $537M call wall) wash out every other cell - even
 * $1-50M ones - down to a nearly uniform faint tint, because they're all a
 * tiny fraction of that one outlier. Ranking instead of scaling guarantees
 * the full purple-to-yellow spectrum gets used across whatever cells are
 * actually on screen, however skewed the underlying dollar values are -
 * which is much closer to how Zerano's own grid stays colorful cell to
 * cell instead of being dominated by one strike.
 *
 * Three rows also get called out with a colored outline + label (merged
 * into one label if more than one lands on the same strike): the strike
 * nearest current spot, and - when passed in, since these are whole-chain
 * values that may fall outside a zoomed near-term view - the overall call
 * wall and put wall strikes.
 */
export function renderGexHeatmap(container, cells, spot, {
  valueFormatter = (v) => v, maxStrikeLabels = 22, maxRows = 26, callWall = null, putWall = null, showLegend = true,
} = {}) {
  clear(container);
  const width = 1000;
  const legendH = showLegend ? 46 : 0;
  const padL = 76, padR = 16, padT = 28, padB = 34;
  const gridH = 460 - 28 - 34; // taller than the old 420 so bucketed rows are thick enough to hold printed values
  const height = padT + gridH + padB + legendH;
  const innerW = width - padL - padR, innerH = gridH;

  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", height: "100%" });

  if (!cells || cells.length === 0) {
    const t = svgEl("text", { x: width / 2, y: height / 2, fill: "#8791a8", "font-size": 12, "text-anchor": "middle" });
    t.textContent = "Waiting for chain data…";
    svg.appendChild(t);
    container.appendChild(svg);
    return;
  }

  cells = _bucketCellsByStrike(cells, maxRows);
  const bandByStrike = new Map(cells.map((c) => [c.strike, { lo: c.lo, hi: c.hi }]));

  const expiries = [...new Set(cells.map((c) => c.expiry_days))].sort((a, b) => a - b);
  // Highest strike at top of the grid (row 0), matching how a price ladder reads.
  const strikes = [...new Set(cells.map((c) => c.strike))].sort((a, b) => b - a);

  const cellByKey = new Map(cells.map((c) => [`${c.expiry_days}|${c.strike}`, c.net_gex]));

  const colW = innerW / expiries.length;
  const rowH = innerH / strikes.length;

  // Percentile rank (0..1) of a value among every currently-visible cell -
  // see the function doc above for why rank beats a fixed magnitude scale.
  const sortedVals = cells.map((c) => c.net_gex).slice().sort((a, b) => a - b);
  const n = sortedVals.length;
  function percentileRank(v) {
    if (n <= 1) return 0.5;
    let lo = 0, hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedVals[mid] < v) lo = mid + 1; else hi = mid;
    }
    return lo / (n - 1);
  }
  function colorFor(v) {
    const [r, g, b] = _viridisRGB(percentileRank(v));
    return `rgb(${r}, ${g}, ${b})`;
  }
  // White text on the dark purple/blue end of the scale, near-black text on
  // the light green/yellow end, so the printed value stays readable across
  // the whole palette instead of just picking one fixed text color.
  function textColorFor(v) {
    const [r, g, b] = _viridisRGB(percentileRank(v));
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.58 ? "#0b0e14" : "#eef1f5";
  }

  // Human-readable row label: a single strike shows as-is, a bucketed band
  // shows as its price range so it's clear the row represents more than one
  // real strike.
  function strikeLabel(strike) {
    const band = bandByStrike.get(strike);
    if (band && band.lo !== band.hi) return `${band.lo.toLocaleString()}-${band.hi.toLocaleString()}`;
    return strike.toLocaleString();
  }

  // Nearest strike (or bucketed band) to spot, for the highlighted row.
  let spotStrike = null;
  if (spot != null && strikes.length > 0) {
    spotStrike = strikes.reduce((best, s) => (Math.abs(s - spot) < Math.abs(best - spot) ? s : best));
  }

  // Each column's single most extreme cell (by |value|) gets a bright
  // yellow highlight box, independent of its viridis color - matching the
  // "one number jumps out" pattern in Zerano's own screenshots, where each
  // ticker/column has its own standout strike flagged rather than only the
  // strikes that happen to land at the top of the color scale.
  const peakKeyByExpiry = new Map();
  expiries.forEach((expiry) => {
    let bestKey = null, bestAbs = -1;
    strikes.forEach((strike) => {
      const v = cellByKey.get(`${expiry}|${strike}`);
      if (v != null && Math.abs(v) > bestAbs) { bestAbs = Math.abs(v); bestKey = `${expiry}|${strike}`; }
    });
    // Skip the highlight entirely for a column with no real signal yet (e.g.
    // a next-day expiration with no OI published overnight) - a $0 cell
    // "winning" by default and getting flagged as the biggest mover would
    // be actively misleading rather than helpful.
    if (bestKey && bestAbs > 0) peakKeyByExpiry.set(expiry, bestKey);
  });

  // cells - solid viridis fill, a visible dark grid border (the "bordered
  // spreadsheet" look, not a smooth blurred wash), and the actual formatted
  // value printed in monospace when the cell has room for it.
  strikes.forEach((strike, rowI) => {
    expiries.forEach((expiry, colI) => {
      const key = `${expiry}|${strike}`;
      const v = cellByKey.get(key) ?? 0;
      const x = padL + colI * colW, y = padT + rowI * rowH;
      const isPeak = peakKeyByExpiry.get(expiry) === key;
      const rect = svgEl("rect", {
        x: x + 0.5, y: y + 0.5, width: Math.max(0, colW - 1), height: Math.max(0, rowH - 1),
        fill: colorFor(v),
        stroke: isPeak ? "#fde725" : "rgba(11, 14, 20, 0.85)",
        "stroke-width": isPeak ? 2 : 1,
      });
      const title = svgEl("title");
      title.textContent = `${strikeLabel(strike)} strike · ${Math.round(expiry)}d out: ${valueFormatter(v)}`;
      rect.appendChild(title);
      svg.appendChild(rect);

      if (rowH >= 11 && colW >= 46) {
        const label = svgEl("text", {
          x: x + colW / 2, y: y + rowH / 2 + 3.5,
          fill: isPeak ? "#0b0e14" : textColorFor(v),
          "font-family": "'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace",
          "font-size": Math.min(10.5, rowH * 0.62),
          "font-weight": isPeak ? "700" : "500",
          "text-anchor": "middle",
        });
        label.textContent = valueFormatter(v);
        label.style.pointerEvents = "none";
        svg.appendChild(label);
      }
    });
  });

  // Callouts: spot, call wall, put wall - each a colored outline across the
  // full row plus a label. If two land on the same strike (e.g. spot sitting
  // right at the put wall), merge into one outline/label instead of drawing
  // twice on top of each other. Matches to the NEAREST row rather than
  // requiring an exact strike match, since a bucketed row's "strike" is a
  // band midpoint that a real wall/spot value will rarely land on exactly.
  const callouts = new Map(); // strike -> { color, parts: [text, ...] }
  function addCallout(strike, color, text) {
    if (strike === null || strike === undefined || strikes.length === 0) return;
    const nearest = strikes.reduce((best, s) => (Math.abs(s - strike) < Math.abs(best - strike) ? s : best));
    const existing = callouts.get(nearest);
    if (existing) existing.parts.push(text);
    else callouts.set(nearest, { color, parts: [text] });
  }
  addCallout(callWall, "#2ecf7a", `call wall ${callWall != null ? callWall.toLocaleString() : ""}`);
  addCallout(putWall, "#ef4a5f", `put wall ${putWall != null ? putWall.toLocaleString() : ""}`);
  addCallout(spotStrike, "#7c8cff", `spot ${spotStrike != null ? spotStrike.toLocaleString() : ""}`);

  callouts.forEach(({ color, parts }, strike) => {
    const rowI = strikes.indexOf(strike);
    const y = padT + rowI * rowH;
    svg.appendChild(svgEl("rect", {
      x: padL, y, width: innerW, height: rowH, fill: "none", stroke: color, "stroke-width": 1.6,
    }));
    const tag = svgEl("text", { x: padL - 8, y: y + rowH / 2 + 4, fill: color, "font-size": 10, "font-weight": "600", "text-anchor": "end" });
    tag.textContent = parts.join(" & ") + " →";
    svg.appendChild(tag);
  });

  // row labels (strikes) - thin out if there are a lot of them. Callout rows
  // already carry their own label above, so skip those to avoid overlap.
  const rowStride = pickLabelStride(strikes.length, maxStrikeLabels);
  strikes.forEach((strike, rowI) => {
    if (callouts.has(strike)) return;
    if (rowI % rowStride !== 0) return;
    const y = padT + rowI * rowH + rowH / 2 + 4;
    const t = svgEl("text", { x: padL - 8, y, fill: "#8791a8", "font-size": 10, "text-anchor": "end" });
    t.textContent = strikeLabel(strike);
    svg.appendChild(t);
  });

  // column labels (expiries), all shown - there are usually only a handful.
  // Drawn on a small chip background, closer to the ticker-badge headers on
  // Zerano's own columns than a bare text label floating in space.
  expiries.forEach((expiry, colI) => {
    const x = padL + colI * colW + colW / 2;
    const label = expiry < 1 ? "0DTE" : `${Math.round(expiry)}d`;
    const chipW = Math.max(34, label.length * 7 + 14);
    svg.appendChild(svgEl("rect", {
      x: x - chipW / 2, y: padT - 22, width: chipW, height: 16, rx: 4, fill: "#1c2130",
    }));
    const t = svgEl("text", { x, y: padT - 10, fill: "#c7cede", "font-size": 10, "font-weight": "600", "text-anchor": "middle" });
    t.textContent = label;
    svg.appendChild(t);
  });

  // Color legend: the viridis ramp itself, labeled by the actual min/median/
  // max values it spans - since color now encodes percentile rank rather
  // than a fixed dollar scale, the legend explains it as a rank, with the
  // real dollar values it currently corresponds to alongside.
  if (showLegend) {
    _heatmapGradientCounter += 1;
    const gradId = `gexHeatmapLegendGrad${_heatmapGradientCounter}`;
    const defs = svgEl("defs");
    const grad = svgEl("linearGradient", { id: gradId, x1: "0", x2: "1", y1: "0", y2: "0" });
    [0, 0.25, 0.5, 0.75, 1].forEach((t) => {
      const [r, g, b] = _viridisRGB(t);
      grad.appendChild(svgEl("stop", { offset: t, "stop-color": `rgb(${r}, ${g}, ${b})` }));
    });
    defs.appendChild(grad);
    svg.appendChild(defs);

    const legendY = padT + innerH + 30;
    const legendW = 220;
    const legendX = padL;
    svg.appendChild(svgEl("rect", {
      x: legendX, y: legendY, width: legendW, height: 8, rx: 4, fill: `url(#${gradId})`,
    }));
    const legendLabels = [
      [legendX, "start", valueFormatter(sortedVals[0])],
      [legendX + legendW / 2, "middle", valueFormatter(sortedVals[Math.floor((n - 1) / 2)])],
      [legendX + legendW, "end", valueFormatter(sortedVals[n - 1])],
    ];
    legendLabels.forEach(([x, anchor, text]) => {
      const t = svgEl("text", { x, y: legendY + 20, fill: "#8791a8", "font-size": 10, "text-anchor": anchor });
      t.textContent = text;
      svg.appendChild(t);
    });
    const caption = svgEl("text", { x: legendX + legendW + 14, y: legendY + 7, fill: "#8791a8", "font-size": 10.5, "text-anchor": "start" });
    caption.textContent = "net GEX by percentile rank — most negative ← → most positive · ⬛ yellow border = column's biggest mover";
    svg.appendChild(caption);
  }

  container.appendChild(svg);
}

/**
 * Narrows a strike x expiry cell list to just the nearest `maxExpiries`
 * expiry buckets and strikes within `strikeWindowPct` of spot - the "fast,
 * live, near-term" companion view to the full multi-expiry map (Zerano's
 * "Oracle" / Skylit's "Trinity" role: same underlying data, zoomed to what
 * matters for the current session rather than the whole term structure).
 */
export function nearTermCells(cells, spot, { maxExpiries = 2, strikeWindowPct = 0.06 } = {}) {
  if (!cells || cells.length === 0) return [];
  const expiries = [...new Set(cells.map((c) => c.expiry_days))].sort((a, b) => a - b);
  const keep = new Set(expiries.slice(0, maxExpiries));
  if (spot == null) return cells.filter((c) => keep.has(c.expiry_days));
  const lo = spot * (1 - strikeWindowPct), hi = spot * (1 + strikeWindowPct);
  return cells.filter((c) => keep.has(c.expiry_days) && c.strike >= lo && c.strike <= hi);
}

/**
 * Dual-axis line chart: series A on the left axis, series B on the right
 * axis, sharing the same x positions (used for net GEX + spot history).
 */
export function renderDualLineChart(container, labels, seriesA, seriesB, {
  colorA = "#5b8dff", colorB = "#f5b544", labelA = "A", labelB = "B",
  formatterA = (v) => v, formatterB = (v) => v, maxLabels = 8,
} = {}) {
  clear(container);
  const width = 1000, height = 260;
  const padL = 64, padR = 64, padT = 20, padB = 34;
  const innerW = width - padL - padR, innerH = height - padT - padB;

  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", height: "100%" });

  const n = labels.length;
  if (n < 2) {
    container.appendChild(svg);
    return;
  }

  function bounds(arr) {
    const min = Math.min(...arr), max = Math.max(...arr);
    if (min === max) return [min - 1, max + 1];
    const pad = (max - min) * 0.1;
    return [min - pad, max + pad];
  }
  const [aMin, aMax] = bounds(seriesA);
  const [bMin, bMax] = bounds(seriesB);

  const x = (i) => padL + (i / (n - 1)) * innerW;
  const yA = (v) => padT + innerH - ((v - aMin) / (aMax - aMin)) * innerH;
  const yB = (v) => padT + innerH - ((v - bMin) / (bMax - bMin)) * innerH;

  // baseline grid
  for (let g = 0; g <= 4; g++) {
    const y = padT + (g / 4) * innerH;
    svg.appendChild(svgEl("line", { x1: padL, x2: width - padR, y1: y, y2: y, stroke: "#1c2130" }));
  }

  // axis labels (left = A, right = B), 5 ticks
  for (let g = 0; g <= 4; g++) {
    const frac = 1 - g / 4;
    const y = padT + (g / 4) * innerH;
    const aVal = aMin + frac * (aMax - aMin);
    const bVal = bMin + frac * (bMax - bMin);
    const la = svgEl("text", { x: padL - 8, y: y + 4, fill: colorA, "font-size": 10, "text-anchor": "end" });
    la.textContent = formatterA(aVal);
    svg.appendChild(la);
    const lb = svgEl("text", { x: width - padR + 8, y: y + 4, fill: colorB, "font-size": 10, "text-anchor": "start" });
    lb.textContent = formatterB(bVal);
    svg.appendChild(lb);
  }

  function path(arr, yFn) {
    return arr.map((v, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${yFn(v).toFixed(1)}`).join(" ");
  }
  svg.appendChild(svgEl("path", { d: path(seriesA, yA), fill: "none", stroke: colorA, "stroke-width": 2 }));
  svg.appendChild(svgEl("path", { d: path(seriesB, yB), fill: "none", stroke: colorB, "stroke-width": 2 }));

  const stride = pickLabelStride(n, maxLabels);
  let lastDrawnIndex = -Infinity;
  const minGap = stride * 0.6;
  labels.forEach((lbl, i) => {
    const isLast = i === n - 1;
    if (i % stride !== 0 && !isLast) return;
    if (isLast && i - lastDrawnIndex < minGap) return; // avoid crowding the previous label
    lastDrawnIndex = i;
    const t = svgEl("text", { x: x(i), y: height - padB + 16, fill: "#8791a8", "font-size": 10, "text-anchor": "middle" });
    t.textContent = lbl;
    svg.appendChild(t);
  });

  // legend
  const legend = svgEl("g");
  [[labelA, colorA, 0], [labelB, colorB, 1]].forEach(([text, color, idx]) => {
    const lx = padL + idx * 120;
    legend.appendChild(svgEl("rect", { x: lx, y: 2, width: 10, height: 10, fill: color }));
    const t = svgEl("text", { x: lx + 14, y: 11, fill: "#e6e9f0", "font-size": 11 });
    t.textContent = text;
    legend.appendChild(t);
  });
  svg.appendChild(legend);

  container.appendChild(svg);
}
