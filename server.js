'use strict';
// ═══════════════════════════════════════════════════════════════
//  server.js  –  Pair Intelligence Scanner v5.2
//
//  node server.js            → Live IBKR (wenn konfiguriert)
//  IBKR_PAPER=true node server.js  → Paper Trading (sicher)
//
//  http://localhost:3000
//
//  Environment variables:
//    FRED_API_KEY   – FRED API key for VIX term structure regime filter
//    EIA_API_KEY    – EIA API key for petroleum inventory signal
//    CAPITAL        – Starting capital (default: 5000)
//    RISK_PCT       – Max risk per trade (default: 0.02)
//    VIX_THRESHOLD  – Flat VIX threshold fallback (default: 25)
//    BID_ASK_BPS    – Bid-ask spread cost in bps (default: 15)
//    SLIPPAGE_BPS   – Slippage cost in bps (default: 5)
// ═══════════════════════════════════════════════════════════════

const express    = require('express');
const path       = require('path');
const nodemailer = require('nodemailer');
const db         = require('./db');
const { scanAll } = require('./scanner');
const yahooFinance = require('yahoo-finance2').default;
// Direct Yahoo Finance v8 API
const https = require('https');
function yfFetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'Accept': 'application/json',
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}
async function yfQuote(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`;
  const data = await yfFetch(url);
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error('No data for ' + ticker);
  return meta.regularMarketPrice || meta.chartPreviousClose;
}

// Extended quote that also returns earningsTimestamp (Phase 3.4)
async function yfQuoteWithEarnings(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`;
  const data = await yfFetch(url);
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error('No data for ' + ticker);
  return {
    price: meta.regularMarketPrice || meta.chartPreviousClose,
    earningsTs: meta.earningsTimestamp || null,
  };
}

function isEarningsNear(earningsTs, daysWindow = 5) {
  if (!earningsTs) return false;
  const daysAway = (earningsTs * 1000 - Date.now()) / 86400000;
  return daysAway >= -1 && daysAway <= daysWindow;
}

// ── FX HELPERS (cross-currency P&L) ─────────────────────
const FX_MAP = { EUR: 'EURUSD=X', GBP: 'GBPUSD=X', NOK: 'NOKUSD=X' };

function getCurrency(ticker) {
  if (/\.(DE|PA|AS|MI|MC)$/.test(ticker)) return 'EUR';
  if (/\.L$/.test(ticker))                return 'GBP';
  if (/\.OL$/.test(ticker))               return 'NOK';
  return 'USD';
}

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

// ── EARNINGS FILTER (Phase 2.2) ──────────────────────────
async function nearEarnings(ticker, daysWindow = 5) {
  try {
    const q = await yahooFinance.quote(ticker, {}, { validateResult: false });
    const ts = q?.earningsTimestamp || q?.earningsTimestampStart;
    if (!ts) return false;
    const daysAway = (ts * 1000 - Date.now()) / 86400000;
    return daysAway >= -1 && daysAway <= daysWindow;
  } catch { return false; }
}

// ── KELLY FRACTION (Phase 2.3) ───────────────────────────
function kellyFraction(zScore, ouSigma, ouKappa, halfLife) {
  if (!ouSigma || !ouKappa || !halfLife) return db.MAX_RISK_PCT;
  const expectedDaily = Math.abs(zScore) * ouKappa * ouSigma;
  const varDaily = ouSigma * ouSigma * ouKappa;
  if (varDaily <= 0) return db.MAX_RISK_PCT;
  const kelly = expectedDaily / varDaily;
  return Math.min(db.MAX_RISK_PCT, Math.max(0.005, kelly * 0.25));
}

// ── CONFIG ──────────────────────────────────────────────
const CONFIG = {
  port:        3000,
  paperMode:   process.env.IBKR_PAPER !== 'false',  // default PAPER; set IBKR_PAPER=false for live

  email: {
    from:     process.env.SMTP_FROM     || '',
    password: process.env.SMTP_PASSWORD || '',
    to:       process.env.SMTP_TO       || process.env.SMTP_FROM || '',
  },

  ibkr: {
    host:      '127.0.0.1',
    paperPort: 7497,    // TWS Paper Trading
    livePort:  7496,    // TWS Live  ← nur wenn paperMode=false
    clientId:  1,
  },

  scanner: {
    intervalMinutes: 30,
    minScore:        65,    // Unter 65 → kein Trade
    autoTradeScore:  80,    // Ab 80 → automatisch traden
    maxOpenPositions: 6,    // Nie mehr als 6 gleichzeitig
    maxPerSector:     2,    // Nie mehr als 2 pro Sektor
    maxSpreadCorrelation: 0.65,
  },

  pnl: {
    pollMinutes: 15,
  },

  // Realistic paper trading costs.
  // Set via env: BID_ASK_BPS=10 SLIPPAGE_BPS=5 node server.js
  // Applied per leg per side (entry and exit separately).
  // Round-trip total = 4 × (bidAskBps + slippageBps) / 10000 × notional
  costs: {
    bidAskBps:   parseInt(process.env.BID_ASK_BPS  || '15'),
    slippageBps: parseInt(process.env.SLIPPAGE_BPS || '5'),
  },

  // VIX regime filter. No new positions opened when VIX exceeds this.
  // Set via env: VIX_THRESHOLD=30 node server.js
  vixThreshold: parseInt(process.env.VIX_THRESHOLD || '25'),
};

// ── DB INIT ─────────────────────────────────────────────
db.init();

// ── SCAN STATE ───────────────────────────────────────────
// Tracks live scanner progress; broadcast via SSE during scanning.
let scanState = {
  running:      false,
  phase:        'idle',        // idle | fetching | analyzing | complete
  tickersDone:  0,
  tickersTotal: 0,
  pairsTotal:   0,
  bhSurvived:   0,
  signalsFound: 0,
  startedAt:    null,
  completedAt:  null,
  nextScanAt:   null,
  lastDecisions: [],
  lastVix:      null,
};

// (Black-Scholes math and spread builder removed in v5.2 — options infrastructure deprecated)

// ── IBKR TRADER ─────────────────────────────────────────
let ibkrConnected = false;
let ibkrClient    = null;

async function connectIBKR() {
  try {
    const { IBApi, EventName, OrderAction, OrderType, SecType } = require('@stoqey/ib');
    const port = CONFIG.paperMode ? CONFIG.ibkr.paperPort : CONFIG.ibkr.livePort;

    ibkrClient = new IBApi({ host: CONFIG.ibkr.host, port, clientId: CONFIG.ibkr.clientId });

    ibkrClient.on(EventName.connected, () => {
      ibkrConnected = true;
      db.log('IBKR_CONNECTED', CONFIG.paperMode ? 'PAPER MODE' : '⚠ LIVE MODE');
    });

    ibkrClient.on(EventName.disconnected, () => {
      ibkrConnected = false;
      db.log('IBKR_DISCONNECTED');
    });

    ibkrClient.on(EventName.error, (err) => {
      db.log('IBKR_ERROR', err.message || String(err));
    });

    ibkrClient.connect();
  } catch(e) {
    db.log('IBKR_UNAVAILABLE', e.message);
    ibkrConnected = false;
  }
}

// (placeSpreadOrder removed in v5.2 — options infrastructure deprecated)

// ── EMAIL ────────────────────────────────────────────────
async function sendAlert(subject, body) {
  if (!CONFIG.email.from || !CONFIG.email.password) {
    db.log('EMAIL_SKIP', `No SMTP credentials configured – skipping: ${subject}`);
    return;
  }
  try {
    const t = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: CONFIG.email.from, pass: CONFIG.email.password },
    });
    await t.sendMail({ from: CONFIG.email.from, to: CONFIG.email.to, subject, text: body });
    db.log('EMAIL_SENT', subject);
  } catch(e) {
    db.log('EMAIL_ERR', e.message);
  }
}

// VIX is fetched inside scanAll() as the first request to avoid rate limiting.
// The vix value is returned as part of the scanAll result { signals, vix }.

// ── TRANSACTION COST ─────────────────────────────────────
// Returns the cost for one side (entry OR exit) on two legs.
// cost = notional × 2 legs × (bidAsk + slippage) in bps.
function calcTxCost(notional) {
  const bps = CONFIG.costs.bidAskBps + CONFIG.costs.slippageBps;
  return +(notional * 2 * bps / 10000).toFixed(4);
}

// ── GATE: Darf ein Trade geöffnet werden? ────────────────
// Returns { ok, reason } — reason is a human-readable explanation for the decision log.
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

// ── SCANNER MAIN ─────────────────────────────────────────
async function openPairPosition(sig) {
  const balance   = db.getBalance();
  // Phase 2.3: Kelly-informed position sizing
  const riskFraction = kellyFraction(sig.z_score, sig.ou_sigma, sig.ou_kappa, sig.half_life);
  const notional  = +(balance * riskFraction).toFixed(4);
  db.log('KELLY_SIZE', `${sig.ticker_a}/${sig.ticker_b}: fraction=${(riskFraction*100).toFixed(2)}% notional=€${notional.toFixed(2)}`);
  if (notional < 50) {
    db.log('GATE_BLOCK', `Insufficient capital: need €50, have €${notional}`);
    return null;
  }
  // Dollar-neutral sizing: buy shares_a of A, short shares_b of B
  const sharesA = +(notional / sig.spot_a).toFixed(6);
  const sharesB = +(sharesA * sig.hedge_ratio * sig.spot_a / sig.spot_b).toFixed(6);

  // Phase 2.4: dynamic TP/SL based on entry z-score
  const tp_z = +(Math.max(0.3, Math.abs(sig.z_score) * 0.20)).toFixed(2);
  const sl_z = +(Math.min(6.0, Math.abs(sig.z_score) * 1.60)).toFixed(2);

  const posId = db.insertPairPosition({
    signal_id:    sig.id,
    ticker_a:     sig.ticker_a,
    ticker_b:     sig.ticker_b,
    name_a:       sig.name_a,
    name_b:       sig.name_b,
    sector:       sig.sector,
    direction:    sig.direction,
    opened_at:    new Date().toISOString(),
    spot_a_entry: sig.spot_a,
    spot_b_entry: sig.spot_b,
    hedge_ratio:  sig.hedge_ratio,
    notional_eur: notional,
    shares_a:     sharesA,
    shares_b:     sharesB,
    z_entry:      sig.z_score,
    half_life:    sig.half_life,
    ou_theta:     sig.ou_theta,
    ou_sigma:     sig.ou_sigma,
    ou_kappa:     sig.ou_kappa,
    tp_z,
    sl_z,
    kalman_beta:            sig.kalman_hedge_ratio || null,
    kalman_beta_updated_at: new Date().toISOString(),
  });

  db.bookCapital({ event: 'PAIR_OPEN', position_id: posId, amount: -notional,
    note: `OPEN ${sig.ticker_a}/${sig.ticker_b} [${sig.direction}] z=${sig.z_score}` });

  // Deduct entry transaction cost immediately (bid-ask + slippage on both legs)
  const entryCost = calcTxCost(notional);
  db.bookCapital({ event: 'TX_COST_ENTRY', position_id: posId, amount: -entryCost,
    note: `Entry cost ${sig.ticker_a}/${sig.ticker_b} (${CONFIG.costs.bidAskBps + CONFIG.costs.slippageBps}bps/leg × 2 legs)` });

  db.log('PAIR_OPENED',
    `${sig.ticker_a}/${sig.ticker_b} [${sig.direction}] z=${sig.z_score} hl=${sig.half_life}d`);

  await sendAlert(
    `[PAIR OPEN] ${sig.ticker_a}/${sig.ticker_b} ${sig.direction} score=${sig.score}`,
    `Pair:       ${sig.ticker_a} / ${sig.ticker_b}
Sector:     ${sig.sector}
Direction:  ${sig.direction}
Score:      ${sig.score}/100   Confidence: ${sig.confidence}
Z-score:    ${sig.z_score}   ADF lag: ${sig.adf_lag || 0}
Half-life:  ${sig.half_life} days
OU theta:   ${sig.ou_theta}   sigma: ${sig.ou_sigma}
Hedge beta: ${sig.hedge_ratio}   Coint p: ${sig.coint_pval}
Cross-FX:   ${sig.cross_currency ? 'YES (FX-adjusted)' : 'NO'}
Notional:   €${notional.toFixed(2)}
Shares A:   ${sharesA} × ${sig.ticker_a} @ ${sig.spot_a}
Shares B:   ${sharesB} × ${sig.ticker_b} @ ${sig.spot_b}
Mode:       ${CONFIG.paperMode ? 'PAPER' : '⚠ LIVE'}`
  );
  return posId;
}

async function runScanner() {
  scanState = { ...scanState, running: true, phase: 'fetching', startedAt: new Date().toISOString(),
    tickersDone: 0, tickersTotal: 0, pairsTotal: 0, bhSurvived: 0, signalsFound: 0, lastDecisions: [] };
  broadcastScanProgress();

  const { signals, vix } = await scanAll({
    onProgress: (update) => {
      if (update.vix !== undefined) scanState.lastVix = update.vix;
      Object.assign(scanState, update, { running: true });
      broadcastScanProgress();
    },
  });

  // Phase 3: Drawdown circuit breaker
  const DRAWDOWN_LIMIT = parseFloat(process.env.DRAWDOWN_LIMIT || '0.15');
  const peakBal  = db.getPeakBalance();
  const curBal   = db.getBalance();
  const drawdown = peakBal > 0 ? (peakBal - curBal) / peakBal : 0;

  if (drawdown >= DRAWDOWN_LIMIT) {
    db.log('DRAWDOWN_HALT',
      `${(drawdown*100).toFixed(1)}% from peak €${peakBal.toFixed(2)} — no new positions`);
    const strong = signals.filter(s => s.score >= CONFIG.scanner.autoTradeScore);
    const decisions = strong.map(sig => ({
      pair: `${sig.ticker_a}/${sig.ticker_b}`, sector: sig.sector,
      z: sig.z_score, score: sig.score, action: 'BLOCKED',
      reason: `drawdown ${(drawdown*100).toFixed(1)}% >= ${(DRAWDOWN_LIMIT*100).toFixed(0)}% limit`,
    }));
    scanState.lastDecisions = decisions;
    scanState = { ...scanState, running: false, phase: 'complete',
      completedAt: new Date().toISOString(),
      nextScanAt: new Date(Date.now() + CONFIG.scanner.intervalMinutes * 60000).toISOString() };
    broadcastScanProgress();
    broadcastState();
    return [];
  }

  // Phase 2.5: multi-factor regime filter (replaces flat VIX threshold)
  const regime = await require('./osint/fred').getRegimeScore()
    .catch(() => ({ score: 0, blocked: false, vix: null, vix3m: null, hyOas: null }));
  const regOk  = !regime.blocked;
  if (!regOk) {
    db.log('REGIME_BLOCK', `score=${regime.score} vix=${regime.vix} hy=${regime.hyOas}`);
  }

  // Phase 3 OSINT: fetch once before signal loop
  const gdelt  = await require('./osint/gdelt').getDefenseTensionIndex()
    .catch(() => null);
  const eia    = await require('./osint/eia').getCrudeInventoryChange()
    .catch(() => null);
  const awards = await require('./osint/usaspending').getRecentLargeAwards()
    .catch(() => null);

  if (gdelt) db.log('GDELT_DATA', `tensionIndex=${gdelt.tensionIndex} articleCount=${gdelt.articleCount}`);
  if (eia)   db.log('EIA_DATA', `change=${eia.changeMMBbl}MMBbl latest=${eia.latestMMBbl} period=${eia.period}`);
  if (awards) db.log('USASPENDING_DATA', `winners=[${awards.winners.join(',')}] since=${awards.cutoffDate}`);

  const strong = signals.filter(s => s.score >= CONFIG.scanner.autoTradeScore);
  const decisions = [];

  if (!regOk) {
    for (const sig of strong) {
      decisions.push({ pair: `${sig.ticker_a}/${sig.ticker_b}`, sector: sig.sector, z: sig.z_score, score: sig.score,
        action: 'BLOCKED', reason: `regime score=${regime.score}` });
    }
  }

  for (const sig of strong) {
    const pair = `${sig.ticker_a}/${sig.ticker_b}`;
    if (!regOk) continue; // already logged above

    // Phase 3.1: GDELT defense tension boost
    if (gdelt && gdelt.tensionIndex > 5 && sig.sector === 'DEFENSE') {
      sig.score = Math.min(100, sig.score + 10);
      db.log('GDELT_BOOST', `${pair}: tensionIndex=${gdelt.tensionIndex} → score=${sig.score}`);
    }

    // Phase 3.2: EIA inventory signal for ENERGY/SHIPPING
    if (eia && (sig.sector === 'ENERGY' || sig.sector === 'SHIPPING')) {
      if (sig.sector === 'ENERGY') {
        if (eia.changeMMBbl > 3)       { sig.score = Math.max(50, sig.score - 8); db.log('INVENTORY_BUILD', `${pair}: ${eia.changeMMBbl}MMBbl → score=${sig.score}`); }
        else if (eia.changeMMBbl < -3) { sig.score = Math.min(100, sig.score + 8); db.log('INVENTORY_DRAW', `${pair}: ${eia.changeMMBbl}MMBbl → score=${sig.score}`); }
      }
      if (sig.sector === 'SHIPPING' && eia.changeMMBbl > 3) {
        sig.score = Math.max(50, sig.score - 5);
        db.log('INVENTORY_BUILD', `${pair}: shipping suppressed by build ${eia.changeMMBbl}MMBbl → score=${sig.score}`);
      }
    }

    // Phase 3.3: USASpending defense contract block
    if (awards && (awards.winners.includes(sig.ticker_a) || awards.winners.includes(sig.ticker_b))) {
      decisions.push({ pair, action: 'BLOCKED', reason: `recent large DoD award to ${awards.winners.join(',')}` });
      db.log('AWARD_BLOCK', `${pair}: recent large DoD contract award disrupts cointegration`);
      continue;
    }

    // Phase 2.2: earnings proximity filter
    const [eA, eB] = await Promise.all([nearEarnings(sig.ticker_a), nearEarnings(sig.ticker_b)]);
    if (eA || eB) {
      decisions.push({ pair, action: 'BLOCKED', reason: `earnings within 5d: ${eA ? sig.ticker_a : sig.ticker_b}` });
      db.log('EARNINGS_BLOCK', `${pair}: earnings proximity`);
      continue;
    }

    // Phase 3.4: extended earnings check via yfQuoteWithEarnings
    try {
      const [qA, qB] = await Promise.all([
        yfQuoteWithEarnings(sig.ticker_a).catch(() => null),
        yfQuoteWithEarnings(sig.ticker_b).catch(() => null),
      ]);
      if (isEarningsNear(qA?.earningsTs) || isEarningsNear(qB?.earningsTs)) {
        decisions.push({ pair, action: 'BLOCKED', reason: 'earnings within 5d window' });
        db.log('EARNINGS_BLOCK', `${pair}`);
        continue;
      }
    } catch { /* non-critical */ }

    const gate = tradeGate(sig);
    if (!gate.ok) {
      db.log('GATE_BLOCK', `${pair}: ${gate.reason}`);
      decisions.push({ pair, sector: sig.sector, z: sig.z_score, score: sig.score,
        action: 'BLOCKED', reason: gate.reason });
      continue;
    }
    const opened = await openPairPosition(sig);
    decisions.push({ pair, sector: sig.sector, z: sig.z_score, score: sig.score,
      action: opened ? 'OPENED' : 'FAILED',
      reason: opened ? `z=${sig.z_score} hl=${sig.half_life}d score=${sig.score}` : 'position insert failed' });
  }

  // Signals below autoTradeScore are monitored but not acted on
  for (const sig of signals.filter(s => s.score < CONFIG.scanner.autoTradeScore)) {
    decisions.push({ pair: `${sig.ticker_a}/${sig.ticker_b}`, sector: sig.sector,
      z: sig.z_score, score: sig.score, action: 'WATCHING',
      reason: `score ${sig.score} < ${CONFIG.scanner.autoTradeScore} threshold` });
  }

  scanState.lastDecisions = decisions;
  scanState.lastVix = regime.vix ? +regime.vix.toFixed(1) : (vix ? +vix.toFixed(1) : null);

  scanState = { ...scanState, running: false, phase: 'complete',
    completedAt: new Date().toISOString(),
    nextScanAt: new Date(Date.now() + CONFIG.scanner.intervalMinutes * 60000).toISOString() };
  broadcastScanProgress();
  broadcastState();
  return signals;
}

// (Options updatePnL removed in v5.2 — options infrastructure deprecated)

// ── PAIR P&L UPDATER ─────────────────────────────────────
// v5.2: FX-adjusted P&L, Kalman beta preference, rolling spread mean for z-score
async function updatePairPnL() {
  const open = db.getOpenPairPositions();
  for (const pos of open) {
    try {
      const spotA = await yfQuote(pos.ticker_a);
      await new Promise(r => setTimeout(r, 300));
      const spotB = await yfQuote(pos.ticker_b);
      if (!spotA || !spotB) continue;

      // Phase 1.1: FX-adjust non-USD legs to USD before computing P&L
      const curA = getCurrency(pos.ticker_a);
      const curB = getCurrency(pos.ticker_b);
      const fxA  = await getFxRate(curA);
      const fxB  = await getFxRate(curB);
      const spotA_usd = spotA * fxA;
      const spotB_usd = spotB * fxB;
      const entryA_usd = pos.spot_a_entry * fxA;
      const entryB_usd = pos.spot_b_entry * fxB;

      // Phase 1.3C: prefer kalman_beta over static hedge_ratio
      const beta = pos.kalman_beta ?? pos.hedge_ratio;
      if (pos.kalman_beta != null) {
        const drift = Math.abs(pos.kalman_beta - pos.hedge_ratio) / Math.abs(pos.hedge_ratio);
        if (drift > 0.20) {
          db.log('PAIR_HEDGE_DRIFT', `${pos.ticker_a}/${pos.ticker_b}: kalman=${pos.kalman_beta.toFixed(4)} ols=${pos.hedge_ratio.toFixed(4)} drift=${(drift*100).toFixed(1)}%`);
        }
      }

      const ouStd = pos.ou_sigma / Math.sqrt(252 * 2 * pos.ou_kappa);
      const currentSpread = (Math.log(spotA) + Math.log(fxA)) - beta * (Math.log(spotB) + Math.log(fxB));

      // Phase 1.4: use rolling spread mean instead of frozen ou_theta when enough data
      const rollingMean = db.getRecentSpreadMean(pos.id);
      const equilibrium = rollingMean !== null ? rollingMean : pos.ou_theta;
      const zCurrent = ouStd > 1e-8
        ? (currentSpread - equilibrium) / ouStd
        : 0;

      // Phase 3.4: earnings proximity warning for open positions
      try {
        const [qA, qB] = await Promise.all([
          yfQuoteWithEarnings(pos.ticker_a).catch(() => null),
          yfQuoteWithEarnings(pos.ticker_b).catch(() => null),
        ]);
        if (isEarningsNear(qA?.earningsTs, 2) || isEarningsNear(qB?.earningsTs, 2)) {
          db.log('EARNINGS_EXIT_WARN', `${pos.ticker_a}/${pos.ticker_b}: earnings within 2d`);
        }
      } catch { /* non-critical */ }

      // P&L in USD, then convert to EUR
      const longA    = pos.direction === 'LONG_A_SHORT_B';
      const pnlA_usd = pos.shares_a * (spotA_usd - entryA_usd) * (longA ?  1 : -1);
      const pnlB_usd = pos.shares_b * (spotB_usd - entryB_usd) * (longA ? -1 :  1);
      const pnlUsd   = pnlA_usd + pnlB_usd;
      const eurUsd   = await getFxRate('EUR');
      const pnlEur   = +(pnlUsd / (eurUsd || 1)).toFixed(4);
      const pnlPct   = +((pnlEur / pos.notional_eur) * 100).toFixed(2);

      db.insertPairPnl({
        position_id: pos.id,
        ts:          new Date().toISOString(),
        spot_a:      +spotA.toFixed(4),
        spot_b:      +spotB.toFixed(4),
        z_current:   +zCurrent.toFixed(4),
        pnl_eur:     pnlEur,
        pnl_pct:     pnlPct,
        fx_ok:       (fxFailed.has(curA) || fxFailed.has(curB)) ? 0 : 1,
      });

      const ageDays      = (Date.now() - new Date(pos.opened_at).getTime()) / 86400000;
      const ageFraction  = ageDays / Math.max(1, pos.half_life);
      // SL tightens by 10% for each half-life beyond the first, flooring at 70% of entry SL
      const dynamicSL    = pos.sl_z * Math.max(0.70, 1 - 0.10 * Math.max(0, ageFraction - 1));

      let exitReason = null;
      if (Math.abs(zCurrent) <= pos.tp_z)          exitReason = 'TAKE_PROFIT';
      else if (Math.abs(zCurrent) >= dynamicSL)    exitReason = 'STOP_LOSS';
      else if (ageDays >= 3 * pos.half_life)       exitReason = 'TIMEOUT';

      if (exitReason) {
        const exitCost = calcTxCost(pos.notional_eur);
        db.bookCapital({ event: 'TX_COST_EXIT', position_id: pos.id, amount: -exitCost,
          note: `Exit cost ${pos.ticker_a}/${pos.ticker_b}` });
        db.closePairPosition(pos.id, exitReason, pnlEur);
        db.log('PAIR_CLOSED',
          `${pos.ticker_a}/${pos.ticker_b} [${exitReason}] ${pnlPct >= 0 ? '+' : ''}${pnlPct}%`);
        await sendAlert(
          `[${exitReason}] ${pos.ticker_a}/${pos.ticker_b} ${pnlPct >= 0 ? '+' : ''}${pnlPct}%`,
          `EXIT: ${exitReason}
Pair:      ${pos.ticker_a} / ${pos.ticker_b}
Direction: ${pos.direction}
Z entry:   ${pos.z_entry}   Z now: ${zCurrent.toFixed(3)}
P&L:       €${pnlEur.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct}%)
Age:       ${ageDays.toFixed(1)} days  Half-life: ${pos.half_life}d`
        );
      }
    } catch (e) {
      db.log('PAIR_PNL_ERR', `${pos.ticker_a}/${pos.ticker_b}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  broadcastState();
}

// ── SSE ──────────────────────────────────────────────────
const clients = new Set();

function broadcastScanProgress() {
  if (clients.size === 0) return;
  const data = `data: ${JSON.stringify({ scanState })}

`;
  for (const res of clients) {
    try { res.write(data); } catch(_) { clients.delete(res); }
  }
}

function broadcastState() {
  if (clients.size === 0) return;
  const payload = getStatePayload();
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try { res.write(data); } catch(_) { clients.delete(res); }
  }
}

function getStatePayload() {
  const pairPositions = db.getAllPairPositions().slice(0, 20).map(p => {
    const hist   = db.getPairPnlHistory(p.id).slice(-60);
    const latest = hist[hist.length - 1] || null;
    return { ...p, latest, history: hist };
  });

  return {
    positions:      [],
    pairPositions,
    signals:        db.getRecentSpreadSignals(30),
    events:         db.getRecentEvents(40),
    orders:         [],
    stats:          db.getStats(),
    config: {
      paperMode:      CONFIG.paperMode,
      autoTradeScore: CONFIG.scanner.autoTradeScore,
      minScore:       CONFIG.scanner.minScore,
      pollMinutes:    CONFIG.pnl.pollMinutes,
    },
    scanState,
    ts: new Date().toISOString(),
  };
}

// ── EXPRESS ──────────────────────────────────────────────
const app = express();
app.use(express.json());

const API_KEY = process.env.API_KEY || null;

function requireAuth(req, res, next) {
  if (!API_KEY) return next();  // auth disabled if env var not set
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/state',  (_req, res) => res.json(getStatePayload()));

app.get('/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();
  clients.add(res);
  // Send current state immediately
  res.write(`data: ${JSON.stringify(getStatePayload())}\n\n`);
  req.on('close', () => clients.delete(res));
});

app.get('/scan/status', (_req, res) => res.json(scanState));

// Config introspection and runtime tuning.
// Values set here override env vars for the current process lifetime.
app.get('/config', (_req, res) => res.json({
  autoTradeScore:   CONFIG.scanner.autoTradeScore,
  vixThreshold:     CONFIG.vixThreshold,
  maxOpenPositions: CONFIG.scanner.maxOpenPositions,
  maxPerSector:     CONFIG.scanner.maxPerSector,
  intervalMinutes:  CONFIG.scanner.intervalMinutes,
  bidAskBps:        CONFIG.costs.bidAskBps,
  slippageBps:      CONFIG.costs.slippageBps,
  riskPct:          +(db.MAX_RISK_PCT * 100).toFixed(1),
  paperMode:        CONFIG.paperMode,
}));

app.patch('/config', requireAuth, (req, res) => {
  const { autoTradeScore, vixThreshold, maxOpenPositions, maxPerSector } = req.body;
  if (autoTradeScore    != null && autoTradeScore    >= 50 && autoTradeScore    <= 100) { CONFIG.scanner.autoTradeScore   = +autoTradeScore;    db.log('CONFIG_CHANGE', `autoTradeScore → ${autoTradeScore}`);    }
  if (vixThreshold      != null && vixThreshold      >= 10 && vixThreshold      <= 80)  { CONFIG.vixThreshold             = +vixThreshold;      db.log('CONFIG_CHANGE', `vixThreshold → ${vixThreshold}`);        }
  if (maxOpenPositions  != null && maxOpenPositions  >=  1 && maxOpenPositions  <= 20)  { CONFIG.scanner.maxOpenPositions = +maxOpenPositions;  db.log('CONFIG_CHANGE', `maxOpenPositions → ${maxOpenPositions}`);  }
  if (maxPerSector      != null && maxPerSector      >=  1 && maxPerSector      <= 10)  { CONFIG.scanner.maxPerSector     = +maxPerSector;      db.log('CONFIG_CHANGE', `maxPerSector → ${maxPerSector}`);          }
  broadcastState();
  res.json({ ok: true, config: { autoTradeScore: CONFIG.scanner.autoTradeScore, vixThreshold: CONFIG.vixThreshold, maxOpenPositions: CONFIG.scanner.maxOpenPositions, maxPerSector: CONFIG.scanner.maxPerSector } });
});

app.post('/scan', requireAuth, async (_req, res) => {
  const sigs = await runScanner();
  res.json({ ok: true, signals: sigs.length });
});

app.post('/update', requireAuth, async (_req, res) => {
  await updatePairPnL();
  res.json({ ok: true });
});

// Deposit or withdraw capital.
// POST /capital/deposit  { amount: 10000, note: 'Top up' }
// POST /capital/withdraw { amount: 2000,  note: 'Withdrawal' }
// Amount must be positive in both cases.
app.post('/capital/deposit', requireAuth, (req, res) => {
  const { amount, note } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ ok: false, error: 'amount must be > 0' });
  const balance = db.bookCapital({ event: 'DEPOSIT', position_id: null, amount: +amount, note: note || '' });
  db.log('CAPITAL_DEPOSIT', `+€${amount.toFixed ? amount.toFixed(2) : amount} → balance €${balance.toFixed(2)}`);
  res.json({ ok: true, balance });
});

app.post('/capital/withdraw', requireAuth, (req, res) => {
  const { amount, note } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ ok: false, error: 'amount must be > 0' });
  const current = db.getBalance();
  if (amount > current) return res.status(400).json({ ok: false, error: `Insufficient balance: €${current.toFixed(2)}` });
  const balance = db.bookCapital({ event: 'WITHDRAWAL', position_id: null, amount: -amount, note: note || '' });
  db.log('CAPITAL_WITHDRAW', `-€${amount.toFixed ? amount.toFixed(2) : amount} → balance €${balance.toFixed(2)}`);
  res.json({ ok: true, balance });
});

// ── START ────────────────────────────────────────────────
app.listen(CONFIG.port, async () => {
  const osintActive = [
    process.env.FRED_API_KEY ? 'FRED' : null,
    'GDELT',
    process.env.EIA_API_KEY  ? 'EIA'  : null,
    'USASpend',
  ].filter(Boolean).join(', ');
  const osintOff = [
    process.env.FRED_API_KEY ? null : 'FRED',
    process.env.EIA_API_KEY  ? null : 'EIA',
  ].filter(Boolean);
  const osintLine = `ON: ${osintActive}` + (osintOff.length ? `  OFF: ${osintOff.join(',')}` : '');
  const emailStatus = CONFIG.email.from ? `ON (${CONFIG.email.from})` : 'OFF (set SMTP_FROM + SMTP_PASSWORD)';

  console.log(`
╔═══════════════════════════════════════════════╗
║  PAIR INTELLIGENCE SCANNER  v5.2              ║
║  http://localhost:${String(CONFIG.port).padEnd(28)}║
║  ${(CONFIG.paperMode ? 'Mode: PAPER (safe)' : 'Mode: LIVE – REAL MONEY').padEnd(44)}║
║  OSINT: ${osintLine.padEnd(38)}║
║  Email: ${emailStatus.padEnd(38)}║
╚═══════════════════════════════════════════════╝

  CAPITAL=50000 node server.js        → custom capital
  IBKR_PAPER=false node server.js     → live mode
  FRED_API_KEY=xxx node server.js     → enable VIX regime filter
  EIA_API_KEY=xxx node server.js      → enable petroleum inventory

  curl -X POST http://localhost:${CONFIG.port}/scan
  curl -X POST http://localhost:${CONFIG.port}/update
  curl -X POST http://localhost:${CONFIG.port}/capital/deposit -H 'Content-Type: application/json' -d '{"amount":1000}'
`);

  // IBKR verbinden
  await connectIBKR();

  // Initial pair P&L update
  await updatePairPnL();

  // Auto-start first scan shortly after boot
  setTimeout(runScanner, 8000);

  // Pair position P&L polling
  setInterval(updatePairPnL, CONFIG.pnl.pollMinutes * 60 * 1000);

  // Scanner – runs every intervalMinutes during market hours (UTC 07-17)
  setInterval(async () => {
    const h = new Date().getUTCHours();
    if (h >= 7 && h <= 17 && !scanState.running) await runScanner();
  }, CONFIG.scanner.intervalMinutes * 60 * 1000);
});
