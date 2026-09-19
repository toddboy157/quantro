:root {
  --bg: #0b0e14;
  --panel: #12161f;
  --panel-border: #232838;
  --text: #e6e9f0;
  --text-dim: #8791a8;
  --green: #2ecf7a;
  --red: #ef4a5f;
  --accent: #5b8dff;
  --amber: #f5b544;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid var(--panel-border);
  flex-wrap: wrap;
  gap: 10px;
}

header h1 {
  font-size: 18px;
  margin: 0;
  letter-spacing: 0.3px;
}

header h1 span { color: var(--accent); }

.brand-link {
  color: var(--text);
  text-decoration: none;
  font-weight: 700;
  font-size: 18px;
  letter-spacing: 0.3px;
  margin-right: 2px;
}
.brand-link:hover { color: var(--accent); }

header { row-gap: 6px; }
header h1 { display: inline-flex; align-items: center; gap: 4px; }

.app-nav {
  display: flex;
  align-items: center;
  gap: 18px;
  font-size: 13px;
  margin-right: auto;
  padding-left: 14px;
}
.app-nav a { color: var(--text-dim); text-decoration: none; }
.app-nav a:hover { color: var(--text); }
.app-nav a.active { color: var(--text); font-weight: 600; }

.wrap-note { padding: 0 20px; max-width: 1200px; margin: 0 auto; }
.wrap-note:empty { display: none; }

.badge {
  display: inline-block;
  font-size: 11px;
  font-weight: 600;
  padding: 3px 8px;
  border-radius: 4px;
  background: rgba(245, 181, 68, 0.15);
  color: var(--amber);
  border: 1px solid rgba(245, 181, 68, 0.4);
  margin-left: 10px;
  vertical-align: middle;
}

.badge.badge-live {
  background: rgba(46, 207, 122, 0.15);
  color: var(--green);
  border: 1px solid rgba(46, 207, 122, 0.4);
}

.controls {
  display: flex;
  align-items: center;
  gap: 12px;
}

#account-widget {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
#account-widget .account-link {
  color: var(--text-dim);
  text-decoration: none;
  background: none;
  border: none;
  font: inherit;
  cursor: pointer;
  padding: 0;
}
#account-widget .account-link:hover { color: var(--text); }
#account-widget .account-signup-btn {
  padding: 6px 12px;
  font-size: 12.5px;
  border-radius: 6px;
  border: 1px solid var(--panel-border);
  color: var(--text);
  text-decoration: none;
}
#account-widget .account-signup-btn:hover { border-color: var(--accent); color: var(--accent); }
#account-widget .account-email { color: var(--text); font-weight: 600; }
.plan-pill {
  display: inline-block;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  padding: 2px 7px;
  border-radius: 12px;
  background: rgba(245, 181, 68, 0.15);
  color: var(--amber);
  border: 1px solid rgba(245, 181, 68, 0.35);
}
.plan-pill-live {
  background: rgba(46, 207, 122, 0.15);
  color: var(--green);
  border: 1px solid rgba(46, 207, 122, 0.4);
}

.symbol-lock-note {
  font-size: 12px;
  color: var(--amber);
  display: flex;
  align-items: center;
  gap: 6px;
}
.symbol-lock-note a { color: var(--amber); }

select {
  background: var(--panel);
  color: var(--text);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  padding: 7px 10px;
  font-size: 14px;
}

#status {
  font-size: 12px;
  color: var(--text-dim);
  display: flex;
  align-items: center;
  gap: 6px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-dim);
}
.dot.live { background: var(--green); box-shadow: 0 0 6px var(--green); }
.dot.stale { background: var(--red); }

main {
  padding: 16px 20px 40px;
  max-width: 1200px;
  margin: 0 auto;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
  margin-bottom: 18px;
}

.card {
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 10px;
  padding: 12px 14px;
}

.card .label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-dim);
  margin-bottom: 6px;
}

.card .value {
  font-size: 20px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.value.positive { color: var(--green); }
.value.negative { color: var(--red); }

.panel {
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 10px;
  padding: 16px;
  margin-bottom: 18px;
}

.panel h2 {
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-dim);
  margin: 0 0 12px 0;
}

.panel-tag {
  display: inline-block;
  margin-left: 8px;
  padding: 2px 8px;
  border-radius: 100px;
  background: rgba(91, 141, 255, 0.14);
  color: var(--accent);
  font-size: 10px;
  letter-spacing: 0.3px;
  text-transform: none;
  vertical-align: middle;
}

.panel-sub {
  font-size: 12.5px;
  color: var(--text-dim);
  margin: -6px 0 12px 0;
  max-width: 720px;
}

.chart-box { width: 100%; height: 280px; }
.chart-box-short { height: 200px; }
.chart-box-tall { height: 340px; }
.chart-box-map { height: 460px; }
.chart-box-livemap { height: 380px; }
.chart-box svg text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }

.panel-headline {
  border-color: rgba(91, 141, 255, 0.35);
  box-shadow: 0 0 0 1px rgba(91, 141, 255, 0.06);
}

.compare-table-wrap { overflow-x: auto; }
table.compare-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13.5px;
  min-width: 480px;
}
table.compare-table th, table.compare-table td {
  padding: 12px 14px;
  text-align: left;
  border-bottom: 1px solid var(--panel-border);
}
table.compare-table th {
  color: var(--text-dim);
  font-weight: 600;
  font-size: 11.5px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
}
table.compare-table tr:last-child td { border-bottom: none; }

footer {
  text-align: center;
  color: var(--text-dim);
  font-size: 12px;
  padding: 20px;
}
