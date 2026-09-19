# Quantro — Technical & Cost Scope: Live Dealer Wall / Options Positioning Site

Prepared: 2026-09-14
Status: Feasibility scoping (pre-build) — decisions below assume: prototype-first path, v1 universe = SPX/SPY/QQQ + a handful of mega-caps, exploring cost/feasibility before committing to a build team.

---

## 1. What the product actually is, end to end

Five components, in order:

**Data ingestion** — pull live options chain data (quotes, open interest, implied vol) for the covered underlyings from a vendor.
**Calculation engine** — turn that chain into per-strike Greeks, then aggregate into GEX/DEX (and optionally vanna/charm) curves and "wall" levels.
**Storage/time-series layer** — keep enough history to draw intraday charts and multi-day comparisons, not just the current snapshot.
**Serving API** — push the computed curves to the frontend, live.
**Frontend** — chart with candles + wall overlays + heatmap, the actual product surface a user pays for.

None of these are exotic individually. The work is in getting the pipeline refreshing reliably and the calculation methodology defensible (see §4), not in any single hard algorithm.

---

## 2. V1 scope (as decided)

**Underlyings:** SPX, SPY, QQQ, plus 5–8 of the most-traded mega-caps (typically AAPL, NVDA, MSFT, TSLA, AMZN, META, GOOGL — final list should be whichever names your target users actually trade).

**Expiries:** include 0DTE/weeklies — this is where dealer gamma effects are most visible and where most retail GEX-watching traffic concentrates (SPX/SPY 0DTE volume is now a large share of total index options volume). Front 4–6 weekly expiries plus the front 2 monthlies is a reasonable v1 cut; going further out adds contracts for little added signal.

**Rough contract universe size:** SPX alone can have 100+ strikes per expiry across 6+ active expiries → 600–1,000+ live contracts; SPY and QQQ similar; each mega-cap name adds another 100–300 active contracts across its own expiries. All-in, v1 is realistically tracking **5,000–12,000 live option contracts** at any time. This number is the key input for picking a data plan tier — it's what determines whether a "free" or entry-level API tier is actually usable or whether you need a real-time/professional tier.

---

## 3. Phase 1 — Prototype architecture

### Data vendor
Use **Massive (Polygon.io)** or **Tradier** as decided. Practical note either way: exchanges publish **official open interest once per day** (pre-market), not tick-by-tick — no vendor, including OPRA direct, gives you real-time OI. What *is* real-time is the underlying spot price and (depending on vendor tier) the options quotes/IV. This matters for the calc engine design below: "live" dealer walls mostly means the wall levels move continuously because spot is moving, recomputed against an OI/IV snapshot that itself only refreshes every few minutes to once a day. This is standard industry practice (SpotGamma, Skylit, Zerano all work this way) — being transparent about this cadence internally will save you from over-promising "tick-level positioning changes" to users.

If picking **Tradier**: note production Greeks update hourly per their docs, so treat their Greeks as an IV/reference snapshot and recompute gamma yourself off live spot rather than relying on Tradier's Greeks refreshing continuously.
If picking **Massive/Polygon**: confirm current pricing directly before committing — the free tier is EOD-only; real-time options quotes + Greeks live on a paid tier whose current price should be checked at signup time rather than assumed from what was found in research (pricing pages change).

### Calculation engine
A small backend service (Python is the natural choice here — `py_vollib` or `QuantLib` for Black-Scholes Greeks, or use vendor-supplied Greeks where available and only compute the ones the vendor doesn't give you, e.g. vanna/charm) that:

1. On each OI/chain refresh (every 1–15 min is typical), pulls the latest chain per underlying: strike, expiry, OI, IV, right (call/put).
2. On a faster loop (every 1–5 sec, bounded by your data plan's rate limits), pulls the latest spot price per underlying.
3. Recomputes gamma per contract off (spot, strike, IV, time-to-expiry, rate) via Black-Scholes.
4. Aggregates per strike: `GEX = Γ × OI × 100 × Spot² × 0.01`, sign-flipped for puts, summed across calls+puts, and separately across expiries for a multi-expiry heatmap.
5. Also compute **DEX** (delta exposure, same OI-weighted approach) and, if you want to match Skylit's VEX language, vanna exposure — same pattern, different Greek.
6. Writes the resulting per-strike/per-expiry snapshot to the storage layer with a timestamp.

### Storage
A time-series-friendly store — **TimescaleDB** (Postgres extension) or **InfluxDB** — holding: raw chain snapshots (for audit/backtesting), computed GEX/DEX snapshots per strike/expiry/timestamp, and daily EOD summaries for historical charts. Expect a modest data footprint at this scale (thousands of contracts × a few refreshes/minute) — this is not a big-data problem at v1 scope.

### Serving API + realtime push
A backend API (FastAPI/Node both fine) exposing REST for historical/chart-load and **WebSocket** for pushing live GEX/spot updates to connected clients — this is what makes the frontend feel "live" without polling.

### Frontend
Lightweight-charts (TradingView's open-source charting library) or a similar library for the candle chart, with the wall levels drawn as horizontal lines/zones and a separate heatmap panel for the multi-expiry view (this is the same visual language Zerano's "Oracle"/"Horizon" and Skylit's "Heatseeker" use). Subscribe to the WebSocket feed for live updates.

### Prototype cost estimate (rough, verify at signup)
| Item | Estimate | Notes |
|---|---|---|
| Data vendor (Polygon real-time tier, or free w/ Tradier brokerage) | $0–~$300/mo | Confirm current real-time options pricing directly; Tradier is free but Greeks are hourly |
| Compute + DB hosting (small VPS/managed Postgres) | $50–150/mo | A single mid-size server comfortably handles v1 contract volume |
| Frontend hosting | ~$0–20/mo | Static hosting / Vercel-class free tier is enough at this stage |
| **Total** | **roughly $100–500/mo** | Dominated by which data vendor tier you need |

### Prototype timeline (order of magnitude, not a commitment)
Building the pipeline (ingestion → calc → storage) is usually the fastest part once a vendor is picked — a working backend is plausible in **2–4 weeks** for one experienced engineer. The frontend chart/heatmap UI to a polished, ship-able standard is typically the longer pole — **4–8 weeks** for something that looks credible next to Zerano/Skylit. Total realistic MVP timeline: **8–12 weeks** for a small team or a very focused solo builder, longer if this is a part-time effort.

---

## 4. Phase 2 — Production scaling (when/why to move off the prototype vendor)

Triggers to reconsider: you have paying users, you need SPX/VIX data with lower latency or higher reliability than an aggregator's SLA, or the aggregator's rate limits/costs stop scaling sensibly with your contract universe.

**Path:** license OPRA directly (e.g. via Databento, exchange fees passed through at cost) for equities/ETFs, and add a **Cboe DataShop / All Access API** subscription specifically for SPX/VIX-family index products (these are Cboe-proprietary listings). Consider **ThetaData** as a middle ground — full OPRA coverage with Greeks already computed (including gamma/vanna/charm) — if you'd rather not run your own Black-Scholes pipeline in production.

**The cost trap to plan for now, not later:** OPRA charges **non-display/redistribution fees per end-subscriber** once you have paying users viewing the data in any form (even as a derived visualization) — this applies regardless of which vendor you route the raw feed through. This is the fee structure that has caught other retail options-data products off guard when they moved from prototype to paying customers. Budget for it as a per-user or tiered cost in your pricing model rather than a fixed monthly line item, and get written clarity from CBOE/OPRA (or whichever vendor is your OPRA reseller) on how they classify a "display" vs "non-display" derived-analytics product like this one — a gamma-exposure chart is a derived analytic, not a raw quote display, and the fee treatment can differ.

---

## 5. Key risks / open questions worth resolving before writing code

**Licensing classification** — confirm with an OPRA-authorized vendor how a derived analytics product (GEX chart, not raw quotes) is fee-classified; this changes your unit economics materially once you have subscribers.

**Differentiation** — Skylit, Zerano, SpotGamma, GEXStream, FlashAlpha, Unusual Whales, and others already occupy this space. The data pipeline described above gets you to feature parity, not ahead of it — worth being clear-eyed about what the actual wedge is (better UI, price, a specific underlying niche, an angle like TradingView integration, alerts, or an AI layer) before/while building.

**Dealer-sign assumption is a modeling convention, not a fact** — the "customers buy = dealers short" assumption behind GEX is standard but imperfect (it ignores market maker-to-market maker flow, non-dealer-facilitated trades, etc.). Not a blocker, but worth stating clearly to users as a methodology assumption rather than implying certainty — this is also a lower legal-risk posture than presenting it as verified positioning data.

**Not investment advice** — a product like this sits close to regulated territory (market data redistribution, and depending on framing, could brush up against investment-adviser-adjacent territory if marketed as signals rather than positioning data — note Zerano's explicit "positioning data only, no trade signals" framing is likely a deliberate compliance choice worth mirroring).

---

## 6. Suggested next steps

1. Pick the v1 data vendor (Polygon/Massive vs Tradier) and confirm live current pricing for the real-time tier you'd actually need at your contract volume.
2. Decide the differentiation angle before writing the frontend — it changes what "MVP" needs to include.
3. When ready to actually build, this doc is enough to scope developer time/cost from, or to start scaffolding the ingestion + calc engine directly.

---

*Saved to the Quantro project for reference. Happy to turn this into an actual repo/scaffold (ingestion service + calc engine + a first chart) whenever you want to move from scoping to building.*
