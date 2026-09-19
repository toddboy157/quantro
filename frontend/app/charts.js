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

  container.appendChild(svg);
}

/**
 * Strike x expiry "dealer positioning map" heatmap. Rows are strikes
 * (highest at top, like a depth-of-book ladder), columns are expiry
 * buckets (nearest-dated first), and each cell's fill encodes that
 * strike/expiry's net GEX - green for net-positive (call-dominated,
 * dealers theoretically long gamma there), red for net-negative
 * (put-dominated). This is the richer sibling of the by-strike and
 * by-expiry bar charts: those are just this same grid summed across one
 * axis. The strike nearest current spot gets a highlighted row so you can
 * see at a glance where price sits relative to the whole term structure.
 */
export function renderGexHeatmap(container, cells, spot, { valueFormatter = (v) => v, maxStrikeLabels = 22 } = {}) {
  clear(container);
  const width = 1000, height = 420;
  const padL = 76, padR = 16, padT = 28, padB = 34;
  const innerW = width - padL - padR, innerH = height - padT - padB;

  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", height: "100%" });

  if (!cells || cells.length === 0) {
    const t = svgEl("text", { x: width / 2, y: height / 2, fill: "#8791a8", "font-size": 12, "text-anchor": "middle" });
    t.textContent = "Waiting for chain data…";
    svg.appendChild(t);
    container.appendChild(svg);
    return;
  }

  const expiries = [...new Set(cells.map((c) => c.expiry_days))].sort((a, b) => a - b);
  // Highest strike at top of the grid (row 0), matching how a price ladder reads.
  const strikes = [...new Set(cells.map((c) => c.strike))].sort((a, b) => b - a);

  const cellByKey = new Map(cells.map((c) => [`${c.expiry_days}|${c.strike}`, c.net_gex]));
  const maxAbs = Math.max(1e-9, ...cells.map((c) => Math.abs(c.net_gex)));

  const colW = innerW / expiries.length;
  const rowH = innerH / strikes.length;

  function colorFor(v) {
    const t = Math.min(1, Math.abs(v) / maxAbs); // 0..1 intensity
    const alpha = 0.12 + t * 0.8;
    return v >= 0 ? `rgba(46, 207, 122, ${alpha.toFixed(3)})` : `rgba(239, 74, 95, ${alpha.toFixed(3)})`;
  }

  // Nearest strike to spot, for the highlighted row.
  let spotStrike = null;
  if (spot != null && strikes.length > 0) {
    spotStrike = strikes.reduce((best, s) => (Math.abs(s - spot) < Math.abs(best - spot) ? s : best));
  }

  // cells
  strikes.forEach((strike, rowI) => {
    expiries.forEach((expiry, colI) => {
      const v = cellByKey.get(`${expiry}|${strike}`) ?? 0;
      const x = padL + colI * colW, y = padT + rowI * rowH;
      const rect = svgEl("rect", {
        x: x + 0.5, y: y + 0.5, width: Math.max(0, colW - 1), height: Math.max(0, rowH - 1),
        fill: colorFor(v),
      });
      const title = svgEl("title");
      title.textContent = `${strike.toLocaleString()} strike · ${Math.round(expiry)}d out: ${valueFormatter(v)}`;
      rect.appendChild(title);
      svg.appendChild(rect);
    });
  });

  // spot-row highlight: a bracket down the left edge at the nearest strike
  if (spotStrike !== null) {
    const rowI = strikes.indexOf(spotStrike);
    const y = padT + rowI * rowH;
    svg.appendChild(svgEl("rect", {
      x: padL, y, width: innerW, height: rowH, fill: "none", stroke: "#7c8cff", "stroke-width": 1.6,
    }));
    const tag = svgEl("text", { x: padL - 8, y: y + rowH / 2 + 4, fill: "#7c8cff", "font-size": 10, "font-weight": "600", "text-anchor": "end" });
    tag.textContent = `spot → ${spotStrike.toLocaleString()}`;
    svg.appendChild(tag);
  }

  // row labels (strikes) - thin out if there are a lot of them. The spot
  // row already gets its own "spot -> <strike>" label above, so skip it
  // here to avoid drawing two overlapping labels on the same line.
  const rowStride = pickLabelStride(strikes.length, maxStrikeLabels);
  strikes.forEach((strike, rowI) => {
    if (strike === spotStrike) return;
    if (rowI % rowStride !== 0) return;
    const y = padT + rowI * rowH + rowH / 2 + 4;
    const t = svgEl("text", { x: padL - 8, y, fill: strike === spotStrike ? "#7c8cff" : "#8791a8", "font-size": 10, "text-anchor": "end" });
    t.textContent = strike.toLocaleString();
    svg.appendChild(t);
  });

  // column labels (expiries), all shown - there are usually only a handful
  expiries.forEach((expiry, colI) => {
    const x = padL + colI * colW + colW / 2;
    const t = svgEl("text", { x, y: padT - 10, fill: "#8791a8", "font-size": 10, "text-anchor": "middle" });
    t.textContent = expiry < 1 ? "0DTE" : `${Math.round(expiry)}d`;
    svg.appendChild(t);
  });

  container.appendChild(svg);
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
