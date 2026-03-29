# CLAUDE.md — spread-sim-pro repair and improvement plan

This file drives a full repair and improvement pass over spread-sim-pro v5.2.
Work through every section in order. Each task is self-contained and testable.
Do not skip sections. Do not refactor code that is not mentioned.

---

## Orientation

Files in scope:

```
server.js        — Express server, P&L updater, scanner orchestration
scanner.js       — Pair intelligence engine (statistical core)
db.js            — SQLite persistence layer
osint/fred.js    — FRED regime filter
osint/gdelt.js   — GDELT defense tension index
osint/eia.js     — EIA crude inventory
osint/usaspending.js — USASpending defense contract filter
dashboard.html   — Frontend (read-only unless a task explicitly says otherwise)
```

Run `node server.js` to verify the server starts cleanly after each section.
The server must start without errors and `GET http://localhost:3000/state` must
return valid JSON before moving to the next section.

---

## Section 1 — Critical bug fixes

### Task 1.1 — Fix broken SSE broadcast in server.js (C1)

**Problem:** `broadcastState()` and the initial write inside `GET /events` both
use escaped template literals. The actual strings sent over SSE contain a
literal backslash before the JSON and literal `\n` characters instead of
newline bytes. SSE clients never receive a valid message terminator, so the
pair positions panel, capital history, events log, and stats never update in
the dashboard.

**Locate** these two broken patterns in `server.js`:

Pattern A — inside `broadcastState()`:
```js
const data    = `data: \${JSON.stringify(payload)}\n\n`;
```

Pattern B — inside `app.get('/events', ...)`:
```js
res.write(`data: \${JSON.stringify(getStatePayload())}\n\n`);
```

**Fix both** by removing the backslash before `$`:
```js
// Pattern A fix:
const data = `data: ${JSON.stringify(payload)}\n\n`;

// Pattern B fix:
res.write(`data: ${JSON.stringify(getStatePayload())}\n\n`);
```

**Verify:** Start the server, open `http://localhost:3000/events` in curl with
`--no-buffer`. After a `POST /update` the SSE stream must emit a `data:`
line containing valid JSON with a `pairPositions` array.

---

### Task 1.2 — Fix z-score FX inconsistency in updatePairPnL (C2)

**Problem:** In `updatePairPnL()` the current spread is computed on raw log
prices, but the OU model (`ou_theta`, `ou_kappa`, `ou_sigma`) was fitted on
FX-adjusted USD log prices in the scanner. For cross-currency pairs the
equilibrium level is systematically offset, producing an incorrect z-score and
triggering spurious TP/SL exits.

**Locate** this line inside `updatePairPnL()` in `server.js`:
```js
const currentSpread = Math.log(spotA) - beta * Math.log(spotB);
```

**Replace it** with the FX-adjusted version. At this point in the function
`fxA` and `fxB` are already fetched. Use them:
```js
const currentSpread = (Math.log(spotA) + Math.log(fxA)) - beta * (Math.log(spotB) + Math.log(fxB));
```

This is a one-line change. The variables `fxA` and `fxB` already exist in scope
immediately above. Do not change anything else in the function.

**Verify:** For a same-currency pair (two USD tickers) `fxA = fxB = 1.0` so
`log(1.0) = 0` and the expression is identical to before. For a EUR/USD pair the
adjustment is non-zero. The z-score for a position that was opened near
equilibrium should be close to zero immediately after opening, not offset by a
constant.

---

## Section 2 — High severity fixes

### Task 2.1 — Guard concurrent scanner runs (H1)

**Problem:** `setInterval(runScanner, ...)` fires every 30 minutes regardless of
whether the previous scan is still running. A slow fetch cycle (59 tickers with
backoff) can exceed 30 minutes. Two concurrent scans can race through
`openPairPosition` for the same signal before the DB insert from the first scan
is visible to the leg-conflict gate in the second.

**Locate** the scheduler block near the bottom of `server.js`. It currently
reads:
```js
setInterval(async () => {
  const h = new Date().getUTCHours();
  if (h >= 7 && h <= 17) await runScanner();
}, CONFIG.scanner.intervalMinutes * 60 * 1000);
```

**Replace** with a guard on `scanState.running`:
```js
setInterval(async () => {
  const h = new Date().getUTCHours();
  if (h >= 7 && h <= 17 && !scanState.running) await runScanner();
}, CONFIG.scanner.intervalMinutes * 60 * 1000);
```

**Verify:** Set `intervalMinutes` to 1 in `CONFIG.scanner` temporarily, start
the server, and confirm in the logs that a second scan does not begin while the
first is still in the `fetching` phase. Restore `intervalMinutes` to 30.

---

### Task 2.2 — Fix Yahoo Finance fetch rate (H2)

**Problem:** `YAHOO_RPM = 50` implies one request per 1200ms, but the batch loop
fires `BATCH_SIZE = 5` requests in parallel via `Promise.all`. The effective rate
is 5/1.2s = ~250 req/min — five times the intended cap. The 1200ms delay starts
only after all five return, not before each fires.

**Locate** these constants near the top of `scanner.js`:
```js
const YAHOO_RPM       = 50;
const FETCH_DELAY_MS  = Math.ceil(60000 / YAHOO_RPM);  // 1200ms
const FETCH_RETRIES   = 3;
const BACKOFF_BASE_MS = 8000;
```

**And** the BATCH_SIZE constant in `scanAll()`:
```js
const BATCH_SIZE = 5;
```

**Fix** by reducing to sequential fetches. Change `BATCH_SIZE` to 1:
```js
const BATCH_SIZE = 1;
```

This makes the batch loop fire one request, wait, fire the next — matching the
intended 50 req/min rate. The `Promise.all` with a batch of 1 is safe and
functionally equivalent to a direct call.

**Do not** change `YAHOO_RPM`, `FETCH_DELAY_MS`, or the retry logic.

**Verify:** In a test run, confirm the log output shows one `FETCH_ERR` or
successful fetch per tick rather than clusters of 5. The total scan time will
increase from ~90s to ~90s (already rate-limited by the delay, not by
parallelism) — this is expected.

---

### Task 2.3 — Add authentication to control endpoints (H3)

**Problem:** `POST /scan`, `POST /capital/deposit`, `POST /capital/withdraw`, and
`PATCH /config` are unauthenticated. Anyone able to reach port 3000 can trigger
a scan or modify capital.

**Add** an API key check middleware. Place this near the top of `server.js`,
after `const app = express()`:

```js
const API_KEY = process.env.API_KEY || null;

function requireAuth(req, res, next) {
  if (!API_KEY) return next();  // auth disabled if env var not set
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}
```

**Apply** the middleware to the four control routes:
```js
app.post('/scan',              requireAuth, async (_req, res) => { ... });
app.post('/update',            requireAuth, async (_req, res) => { ... });
app.post('/capital/deposit',   requireAuth, (req, res) => { ... });
app.post('/capital/withdraw',  requireAuth, (req, res) => { ... });
app.patch('/config',           requireAuth, (req, res) => { ... });
```

Read-only routes (`GET /`, `GET /state`, `GET /events`, `GET /scan/status`,
`GET /config`) remain open.

**Verify:** With `API_KEY=secret node server.js`, a `POST /scan` without the
header returns 401. With `-H "x-api-key: secret"` it succeeds. Without the env
var set, all calls pass through unchanged.

---

## Section 3 — Medium fixes

### Task 3.1 — Fix P&L currency and naming (M1)

**Problem:** `pnl_eur` is computed as USD-equivalent (raw sum of FX-converted
USD P&L values) and mislabeled. For a EUR/EUR pair the values are in USD scaled
by the EUR rate, not in EUR. Email alerts display `€` signs on USD figures.

**Locate** the P&L calculation block in `updatePairPnL()` in `server.js`.
The current final computation:
```js
const pnlA    = pos.shares_a * (spotA_usd - entryA_usd) * (longA  ?  1 : -1);
const pnlB    = pos.shares_b * (spotB_usd - entryB_usd) * (longA  ? -1 :  1);
const pnlEur  = +(pnlA + pnlB).toFixed(4);
```

**Replace** with a EUR-normalized version. After computing `pnlA` and `pnlB` in
USD, convert back to EUR using the EUR/USD rate:

```js
const pnlA_usd = pos.shares_a * (spotA_usd - entryA_usd) * (longA ?  1 : -1);
const pnlB_usd = pos.shares_b * (spotB_usd - entryB_usd) * (longA ? -1 :  1);
const pnlUsd   = pnlA_usd + pnlB_usd;
// Convert total USD P&L to EUR using current EUR/USD rate
const eurUsd   = await getFxRate('EUR');   // already cached in memory or fetched fast
const pnlEur   = +(pnlUsd / (eurUsd || 1)).toFixed(4);
```

If the reporting currency preference is USD, change the variable name to
`pnlUsd` throughout and update email alerts to use `$` instead of `€`.
Pick one and be consistent. EUR is preferred given the server description.

**Also** rename the local variable `pnlEur` to be clear in its semantics
throughout the function, and update the email template string to match.

**Verify:** For a USD/USD pair with no FX movement, the P&L should match the
previous calculation. For a EUR/USD pair, the reported EUR value should differ
from the raw USD sum by approximately the EUR/USD rate.

---

### Task 3.2 — Extend ADF p-value table (M2)

**Problem:** `adfPvalue()` in `scanner.js` uses a lookup table that ends at
p=0.20 (tau=-2.646). Above that it extrapolates linearly. The true MacKinnon
distribution is nonlinear in this tail, and the extrapolation underestimates
p-values for non-cointegrated pairs (e.g. tau=0 returns ~0.73 instead of ~0.90).
This affects the walk-forward OOS check which uses an absolute p-value threshold.

**Locate** the `table` array inside `adfPvalue()` in `scanner.js`:
```js
const table = [
  { p: 0.001, cv: -4.730 },
  ...
  { p: 0.200, cv: -2.646 },
];
```

**Extend** the table with three additional rows covering the upper tail, and
update the extrapolation cap:
```js
const table = [
  { p: 0.001, cv: -4.730 },
  { p: 0.005, cv: -4.260 },
  { p: 0.010, cv: -3.900 },
  { p: 0.025, cv: -3.604 },
  { p: 0.050, cv: -3.338 },
  { p: 0.100, cv: -3.046 },
  { p: 0.200, cv: -2.646 },
  { p: 0.400, cv: -2.000 },
  { p: 0.700, cv: -1.000 },
  { p: 0.900, cv:  0.000 },
];
if (tau <= table[0].cv) return 0.001;
if (tau >= table[table.length - 1].cv) return 0.99;
```

Remove the existing extrapolation formula at the end of the out-of-bounds check
for the upper tail — replace it with a hard `return 0.99` since any tau at or
above 0 is essentially a unit root.

**Verify:** `adfPvalue(-2.646)` returns 0.20. `adfPvalue(0.0)` returns 0.99.
`adfPvalue(-3.338)` returns 0.05.

---

### Task 3.3 — Log FX fetch failures explicitly (M3)

**Problem:** `getFxRate()` silently returns 1.0 on fetch failure, which causes
P&L for EUR and GBP stocks to be computed at the wrong scale for the entire
poll cycle with no visible indicator.

**Locate** `getFxRate()` in `server.js`:
```js
async function getFxRate(currency) {
  if (currency === 'USD') return 1.0;
  const pair = FX_MAP[currency];
  if (!pair) return 1.0;
  try {
    return await yfQuote(pair);
  } catch {
    db.log('FX_WARN', `${pair}: fetch failed, using 1.0`);
    return 1.0;
  }
}
```

**Add** a module-level flag set that tracks which currencies have failed this
cycle, so the P&L loop can mark its results as unreliable:

```js
const fxFailed = new Set();

async function getFxRate(currency) {
  if (currency === 'USD') return 1.0;
  const pair = FX_MAP[currency];
  if (!pair) return 1.0;
  try {
    const rate = await yfQuote(pair);
    fxFailed.delete(currency);
    return rate;
  } catch {
    fxFailed.add(currency);
    db.log('FX_WARN', `${pair}: fetch failed – P&L for ${currency} positions unreliable this cycle`);
    return 1.0;
  }
}
```

In `updatePairPnL()`, after computing `pnlEur`, add a reliability flag to the
`db.insertPairPnl()` call when either leg's currency failed. First add a column
to the schema migration in `db.js`:

```js
try { db.exec('ALTER TABLE pair_pnl ADD COLUMN fx_ok INTEGER DEFAULT 1'); } catch(_) {}
```

Then pass `fx_ok: (fxFailed.has(curA) || fxFailed.has(curB)) ? 0 : 1` to
`insertPairPnl`. Update the `insertPairPnl` prepared statement in `db.js` to
include the column.

**Verify:** Temporarily make `getFxRate` throw for EUR. The event log must show
the warning. The inserted `pair_pnl` row must have `fx_ok = 0`.

---

### Task 3.4 — Move email credentials to environment variables (M4)

**Problem:** Email credentials are hardcoded as object values. When filled in,
they live in source.

**Locate** the `CONFIG.email` block in `server.js`:
```js
email: {
  from:     'DEINE@gmail.com',
  password: 'DEIN_APP_PASSWORT',
  to:       'DEINE@gmail.com',
},
```

**Replace** with environment variable reads:
```js
email: {
  from:     process.env.SMTP_FROM     || '',
  password: process.env.SMTP_PASSWORD || '',
  to:       process.env.SMTP_TO       || process.env.SMTP_FROM || '',
},
```

**Update** `sendAlert()` to skip silently if `CONFIG.email.from` is empty
rather than attempting a send that will fail authentication:

```js
async function sendAlert(subject, body) {
  if (!CONFIG.email.from || !CONFIG.email.password) {
    db.log('EMAIL_SKIP', `No SMTP credentials configured – skipping: ${subject}`);
    return;
  }
  // ... existing nodemailer code unchanged
}
```

**Update** the startup banner to show whether email alerts are active:
```js
const emailStatus = CONFIG.email.from ? `ON (${CONFIG.email.from})` : 'OFF (set SMTP_FROM + SMTP_PASSWORD)';
```

Include `emailStatus` in the console output block.

**Verify:** Start without env vars. Server starts cleanly. A scan trigger must
log `EMAIL_SKIP` instead of an auth error. With `SMTP_FROM=x@x.com
SMTP_PASSWORD=y` set, the skip log must not appear.

---

## Section 4 — Cleanup

### Task 4.1 — Remove dead code: bidirectionalEG and buildKalmanSpread (L1)

**In `scanner.js`**, remove the following two functions entirely. They are never
called — `rawPairAnalysis` calls `olsBidirectional` directly:

- `buildKalmanSpread(logA, logB)`
- `bidirectionalEG(logA_usd, logB_usd)`

Before removing, confirm with a text search that neither function name appears
anywhere other than its own definition and any JSDoc-style comment above it.
Remove the functions and any associated block comment headers.

**Verify:** `node -e "require('./scanner')"` exits without error.

---

### Task 4.2 — Remove dead code: tradeAllowed (L2)

**In `server.js`**, remove the `tradeAllowed()` function. The scanner loop calls
`tradeGate()` directly. `tradeAllowed` is a wrapper that adds a log call that is
never reached.

Confirm with a text search that `tradeAllowed` appears only in its own
definition. Remove it.

**Verify:** Server starts cleanly.

---

### Task 4.3 — Remove dead code: sizePosition (L3)

**In `db.js`**, remove the `sizePosition()` function and the `CONTRACT_SIZE`
constant. Both are options-era artifacts. The `CONTRACT_SIZE` export is not
referenced anywhere in the current codebase.

**Also remove** `CONTRACT_SIZE` from the `module.exports` line at the bottom of
`db.js`.

Retain the `MAX_RISK_PCT` constant and export — it is used in `server.js` for
Kelly sizing.

**Verify:** `node -e "require('./db').init()"` succeeds. `node server.js` starts
cleanly.

---

## Section 5 — Signal quality improvements

### Task 5.1 — Use adjusted closes for dividend-paying tickers

**Problem:** The scanner fetches unadjusted `d.close` values. Stocks with
material dividends (ENERGY, BANKS, SHIPPING, INFRA sectors) show discrete price
drops at each ex-dividend date that look like structural breaks, poisoning both
the ADF test and OU fit.

**Locate** `fetchPrices()` in `scanner.js`. The chart call:
```js
const chart = await yahooFinance.chart(ticker, {
  period1:  lookback,
  period2:  new Date().toISOString().split('T')[0],
  interval: '1d',
}, { validateResult: false });
const closes = (chart.quotes || []).map(d => d.close).filter(v => v != null && v > 0);
```

**Replace** the closes extraction to prefer `adjclose` over `close`:
```js
const closes = (chart.quotes || [])
  .map(d => d.adjclose ?? d.close)
  .filter(v => v != null && v > 0);
```

No change to the chart request parameters is needed — `yahoo-finance2` returns
`adjclose` in the quotes array by default when available.

**Verify:** Fetch prices for `SHEL.L` (Shell, heavy dividend payer). The price
series should show smooth long-term price action without step-drops on known
ex-dividend dates (Shell pays quarterly).

---

### Task 5.2 — Add Hurst exponent filter

**Add** the following function to `scanner.js`, placed just before `ouFit`:

```js
// Rescaled-range Hurst exponent.
// H < 0.5 = mean-reverting, H = 0.5 = random walk, H > 0.5 = trending.
// Reject pairs where H >= 0.48 — they are not genuinely mean-reverting.
function hurstExponent(series) {
  const n    = series.length;
  const mean = series.reduce((a, b) => a + b, 0) / n;
  let cumDev = 0, maxDev = -Infinity, minDev = Infinity, varSum = 0;
  for (let i = 0; i < n; i++) {
    cumDev += series[i] - mean;
    if (cumDev > maxDev) maxDev = cumDev;
    if (cumDev < minDev) minDev = cumDev;
    varSum += (series[i] - mean) ** 2;
  }
  const R = maxDev - minDev;
  const S = Math.sqrt(varSum / n);
  if (S < 1e-10 || R <= 0) return 0.5;
  return Math.log(R / S) / Math.log(n);
}
```

**Add** a `hurstMax` threshold to `CONFIG` in `scanner.js`:
```js
hurstMax: 0.48,
```

**Apply** the filter in `completePairAnalysis()`, immediately before the `ouFit`
call:
```js
const hurst = hurstExponent(canonical);
if (hurst >= CONFIG.hurstMax) return null;
```

**Also store** the Hurst value in the returned signal object:
```js
hurst: +hurst.toFixed(4),
```

**Add** a migration for the column in `db.js`:
```js
try { db.exec('ALTER TABLE spread_signals ADD COLUMN hurst REAL'); } catch(_) {}
```

**Update** `insertSpreadSignal` in `db.js` to include `@hurst` in the INSERT
statement.

**Verify:** After a scan, `SELECT ticker_a, ticker_b, hurst FROM spread_signals
ORDER BY ts DESC LIMIT 10` should show Hurst values between 0.3 and 0.48 for
all returned signals.

---

### Task 5.3 — Add spread information ratio filter

**Add** the following function to `scanner.js`, placed after `hurstExponent`:

```js
// Annualized information ratio of the canonical spread.
// A low IR means the spread has weak signal relative to its noise —
// it will not cover transaction costs reliably.
function spreadIR(canonical) {
  const n    = canonical.length;
  const mean = canonical.reduce((a, b) => a + b, 0) / n;
  const std  = Math.sqrt(canonical.reduce((a, c) => a + (c - mean) ** 2, 0) / n);
  if (std < 1e-10) return 0;
  return (mean / std) * Math.sqrt(252);
}
```

**Add** a `minSpreadIR` threshold to `CONFIG`:
```js
minSpreadIR: 0.20,
```

**Apply** the filter in `completePairAnalysis()`, after the Hurst check and
before `ouFit`:
```js
if (Math.abs(spreadIR(canonical)) < CONFIG.minSpreadIR) return null;
```

**Verify:** A flat canonical spread (all zeros) returns IR = 0 and is rejected.
A canonical spread with a consistent drift returns a non-zero IR.

---

### Task 5.4 — Add daily volume liquidity filter

**Problem:** Tickers like HAG.DE, LDO.MI, NAT, TRMD have much lower daily
turnover than US names. Thin pairs will experience wider realized bid-ask than
the flat 15 bps assumption.

**Modify** `fetchPrices()` in `scanner.js` to also return median daily volume in
USD, and return `null` if the ticker is below the liquidity floor.

Add a `minVolumeUSD` threshold to `CONFIG`:
```js
minVolumeUSD: 20_000_000,   // $20M median daily turnover
```

**Update** `fetchPrices` to compute and check volume:
```js
const quotes  = chart.quotes || [];
const closes  = quotes.map(d => d.adjclose ?? d.close).filter(v => v != null && v > 0);
const volumes = quotes.map(d => (d.volume || 0) * (d.close || 0)).filter(v => v > 0);

if (closes.length < CONFIG.minObs) return null;

// Median daily dollar volume check
const sorted = [...volumes].sort((a, b) => a - b);
const medVol = sorted[Math.floor(sorted.length / 2)] || 0;
if (medVol < CONFIG.minVolumeUSD) {
  db.log('LIQUIDITY_SKIP', `${ticker}: median vol $${(medVol / 1e6).toFixed(1)}M < $${CONFIG.minVolumeUSD / 1e6}M threshold`);
  return null;
}

return closes;
```

**Verify:** Run a test fetch on `NAT` (Nordic American, thin shipping stock).
Confirm it logs `LIQUIDITY_SKIP` or passes depending on its actual volume. Run
on `LMT` (Lockheed) — it must pass.

---

## Section 6 — Position management improvements

### Task 6.1 — Time-decaying stop loss

**Problem:** The static SL at `sl_z` is appropriate at entry but should tighten
as the position ages beyond one half-life without reverting, since the OU model
is no longer predictive.

**Locate** the exit condition block in `updatePairPnL()` in `server.js`:
```js
const ageDays = (Date.now() - new Date(pos.opened_at).getTime()) / 86400000;
let exitReason = null;
if (Math.abs(zCurrent) <= pos.tp_z)    exitReason = 'TAKE_PROFIT';
else if (Math.abs(zCurrent) >= pos.sl_z) exitReason = 'STOP_LOSS';
else if (ageDays >= 3 * pos.half_life) exitReason = 'TIMEOUT';
```

**Replace** the static SL check with a time-decaying version:
```js
const ageDays      = (Date.now() - new Date(pos.opened_at).getTime()) / 86400000;
const ageFraction  = ageDays / Math.max(1, pos.half_life);
// SL tightens by 10% for each half-life beyond the first, flooring at 70% of entry SL
const dynamicSL    = pos.sl_z * Math.max(0.70, 1 - 0.10 * Math.max(0, ageFraction - 1));

let exitReason = null;
if (Math.abs(zCurrent) <= pos.tp_z)          exitReason = 'TAKE_PROFIT';
else if (Math.abs(zCurrent) >= dynamicSL)    exitReason = 'STOP_LOSS';
else if (ageDays >= 3 * pos.half_life)       exitReason = 'TIMEOUT';
```

**Verify:** For a new position (`ageDays = 0`), `dynamicSL = sl_z` (no change).
For a position at 2× half-life, `dynamicSL = sl_z * 0.90`. For a position at
5× half-life, `dynamicSL = sl_z * 0.70` (floor).

---

### Task 6.2 — Spread correlation gate before opening new positions

**Problem:** The sector cap (max 2 per sector) does not prevent opening two
highly correlated pairs in the same sector (e.g. LMT/RTX and NOC/GD both react
identically to defense budget news). This doubles effective factor exposure.

**Add** the following function to `server.js`, placed before `openPairPosition`:

```js
// Returns the Pearson correlation between the z-score series of two positions.
// Uses the last 30 pnl_history rows. Returns 0 if insufficient data.
function spreadCorrelation(histA, histB) {
  const n = Math.min(histA.length, histB.length, 30);
  if (n < 10) return 0;
  const za = histA.slice(-n).map(r => r.z_current);
  const zb = histB.slice(-n).map(r => r.z_current);
  const ma = za.reduce((a, b) => a + b, 0) / n;
  const mb = zb.reduce((a, b) => a + b, 0) / n;
  const num = za.reduce((s, v, i) => s + (v - ma) * (zb[i] - mb), 0);
  const den = Math.sqrt(
    za.reduce((s, v) => s + (v - ma) ** 2, 0) *
    zb.reduce((s, v) => s + (v - mb) ** 2, 0)
  );
  return den < 1e-8 ? 0 : num / den;
}
```

**Add** a `maxSpreadCorrelation` threshold to `CONFIG.scanner`:
```js
maxSpreadCorrelation: 0.65,
```

**Update** `tradeGate()` to check correlation against all open positions:
```js
function tradeGate(signal) {
  const open = db.getOpenPairPositions();
  if (open.length >= CONFIG.scanner.maxOpenPositions)
    return { ok: false, reason: `position cap ${open.length}/${CONFIG.scanner.maxOpenPositions}` };
  const sectorCount = open.filter(p => p.sector === signal.sector).length;
  if (sectorCount >= CONFIG.scanner.maxPerSector)
    return { ok: false, reason: `sector limit ${signal.sector} ${sectorCount}/${CONFIG.scanner.maxPerSector}` };
  const lc = open.find(p =>
    p.ticker_a===signal.ticker_a || p.ticker_b===signal.ticker_a ||
    p.ticker_a===signal.ticker_b || p.ticker_b===signal.ticker_b
  );
  if (lc) return { ok: false, reason: `leg conflict with ${lc.ticker_a}/${lc.ticker_b}` };

  // Spread correlation check
  for (const pos of open) {
    const histPos = db.getPairPnlHistory(pos.id);
    if (histPos.length < 10) continue;
    // Build a synthetic z-score history for the new signal using recent spread signals
    // Compare using the open position's recorded z_current history
    const recentSignalHist = db.getRecentSpreadSignals(30).filter(
      s => s.ticker_a === signal.ticker_a && s.ticker_b === signal.ticker_b
    ).map(s => ({ z_current: s.z_score }));
    if (recentSignalHist.length < 5) continue;
    const corr = spreadCorrelation(histPos, recentSignalHist);
    if (Math.abs(corr) > CONFIG.scanner.maxSpreadCorrelation)
      return { ok: false, reason: `spread correlation ${corr.toFixed(2)} with ${pos.ticker_a}/${pos.ticker_b}` };
  }

  return { ok: true, reason: null };
}
```

**Verify:** Open two positions manually in the DB with correlated z-score
histories. Confirm that a third strongly correlated signal is blocked with a
`GATE_BLOCK: spread correlation` log entry.

---

## Section 7 — Final verification

After all sections are complete, perform a full integration check:

1. `node server.js` starts without any errors or warnings.
2. `GET http://localhost:3000/state` returns JSON with `pairPositions`,
   `signals`, `stats`, and `scanState` fields.
3. `GET http://localhost:3000/events` streams SSE. After `POST /update` (with
   API key if set), a new `data:` line arrives containing valid JSON.
4. `POST /scan` triggers a scan. The event log shows `SCAN_START`, ticker
   fetches, `BH_CORRECTION`, and `SCAN_DONE` in sequence. No concurrent scan
   starts while this one runs.
5. Any signal in the scan results has `hurst`, `adf_stat`, `coint_pval`,
   `half_life`, and `z_score` fields populated.
6. `SELECT fx_ok, COUNT(*) FROM pair_pnl GROUP BY fx_ok` shows only `fx_ok=1`
   rows when FX fetches succeed.

If any check fails, fix the issue before considering the pass complete.

---

## Notes

- All fixes are surgical. Do not restructure functions that are not mentioned.
- The SQLite schema migrations use `try/catch ALTER TABLE` — they are safe to
  run on an existing database.
- Paper mode (`IBKR_PAPER=true`) is the default. Do not change this.
- The dashboard HTML is read-only in this pass unless a task explicitly says
  to modify it.