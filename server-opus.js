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
const { scanAll, CONFIG: SCANNER_CONFIG } = require('./scanner');
const telegram     = require('./osint/telegram');
const { scoreSignal } = require('./scorer');
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
const FX_MAP = { EUR: 'EURUSD=X', GBP: 'GBPUSD=X', NOK: 'NOKUSD=X', CHF: 'CHFUSD=X' };

function getCurrency(ticker) {
  if (/\.(DE|PA|AS|MI|MC)$/.test(ticker)) return 'EUR';
  if (/\.L$/.test(ticker))                return 'GBP';
  if (/\.OL$/.test(ticker))               return 'NOK';
  if (/\.SW$/.test(ticker))               return 'CHF';
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

// ── ADAPTIVE RISK PHASES ─────────────────────────────────
// The edge is proven: 66% WR with live Kalman, 97.8% z-reversion.
// Phase 1 swings hard. As capital grows phases auto-harden.
function riskPhase() {
  const balance  = db.getBalance();
  const start    = db.getStartingCapital();
  const multiple = balance / start;

  if (multiple < 5) {
    // PHASE 1 — AGGRESSIVE: compound fast on proven edge
    return {
      name:            'AGGRESSIVE',
      maxRiskPct:      0.10,          // 10% per trade — edge is proven, size into it
      kellyMultiplier: 0.75,          // 3/4 Kelly — aggressive but not full Kelly
      maxPositions:    12,            // run 12 concurrent pairs
      maxPerSector:    4,             // best sectors produce clusters
      drawdownLimit:   0.35,          // 35% — aggressive
      tpMultiplier:    0.15,
      slMultiplier:    1.30,
    };
  }

  if (multiple < 20) {
    // PHASE 2 — GROWTH: capital is real, compound steadily
    return {
      name:            'GROWTH',
      maxRiskPct:      0.08,          // 8% per trade
      kellyMultiplier: 0.50,          // half-Kelly
      maxPositions:    10,
      maxPerSector:    3,
      drawdownLimit:   0.25,
      tpMultiplier:    0.20,
      slMultiplier:    1.60,
    };
  }

  // PHASE 3 — PROTECT: capital is meaningful, preserve it
  return {
    name:            'PROTECT',
    maxRiskPct:      0.04,
    kellyMultiplier: 0.35,
    maxPositions:    12,
    maxPerSector:    3,
    drawdownLimit:   0.15,
    tpMultiplier:    0.20,
    slMultiplier:    1.60,
  };
}

// ── KELLY FRACTION (Phase 2.3) ───────────────────────────
function kellyFraction(zScore, ouSigma, ouKappa, halfLife) {
  const phase = riskPhase();
  if (!ouSigma || !ouKappa || !halfLife) return phase.maxRiskPct;
  const expectedDaily = Math.abs(zScore) * ouKappa * ouSigma;
  const varDaily = ouSigma * ouSigma * ouKappa;
  if (varDaily <= 0) return phase.maxRiskPct;
  const kelly = expectedDaily / varDaily;
  return Math.min(phase.maxRiskPct, Math.max(0.005, kelly * phase.kellyMultiplier));
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
    minScore:        55,
    autoTradeScore:  65,
    maxOpenPositions: 12,    // run up to 12 concurrent pairs
    maxPerSector:     4,     // best sectors cluster — let them
    maxSpreadCorrelation: 0.65,
    maxHoldDays:     15,     // data: 1-10d = money, 10-15d = breakeven, >15d = death
  },

  pnl: {
    pollMinutes: 10,
  },

  // Leverage: pairs are hedged (long+short), leverage risk is reduced.
  // 3x default — the sweet spot from backtest data.
  leverage: parseFloat(process.env.LEVERAGE || '3'),

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
  const phase = riskPhase();
  const open = db.getOpenPairPositions();
  const maxPos = Math.min(CONFIG.scanner.maxOpenPositions, phase.maxPositions);
  if (open.length >= maxPos)
    return { ok: false, reason: `position cap ${open.length}/${maxPos} [${phase.name}]` };
  const maxSec = Math.min(CONFIG.scanner.maxPerSector, phase.maxPerSector);
  const sectorCount = open.filter(p => p.sector === signal.sector).length;
  if (sectorCount >= maxSec)
    return { ok: false, reason: `sector limit ${signal.sector} ${sectorCount}/${maxSec} [${phase.name}]` };
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
  const phase     = riskPhase();
  // Kelly-informed position sizing × leverage
  const riskFraction = kellyFraction(sig.z_score, sig.ou_sigma, sig.ou_kappa, sig.half_life);
  const notional  = +(balance * riskFraction * CONFIG.leverage).toFixed(4);
  db.log('KELLY_SIZE', `${sig.ticker_a}/${sig.ticker_b}: phase=${phase.name} fraction=${(riskFraction*100).toFixed(2)}% notional=€${notional.toFixed(2)}`);
  if (notional < 50) {
    db.log('GATE_BLOCK', `Insufficient capital: need €50, have €${notional}`);
    return null;
  }
  // Dollar-neutral sizing: buy shares_a of A, short shares_b of B
  const sharesA = +(notional / sig.spot_a).toFixed(6);
  const sharesB = +(sharesA * sig.hedge_ratio * sig.spot_a / sig.spot_b).toFixed(6);

  // TP/SL scaled by risk phase — aggressive phase takes profit faster, gives more SL room
  const tp_z = +(Math.max(0.3, Math.abs(sig.z_score) * phase.tpMultiplier)).toFixed(2);
  const sl_z = +(Math.min(6.0, Math.abs(sig.z_score) * phase.slMultiplier)).toFixed(2);

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
    `${sig.ticker_a}/${sig.ticker_b} [${sig.direction}] z=${sig.z_score} hl=${sig.half_life}d ML=${sig._mlGrade||'?'}(${sig._mlProb||'?'})`);

  telegram.tradeOpened(sig, notional, `${phase.name} ML:${sig._mlGrade||'?'}`).catch(() => {});
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

  // Drawdown circuit breaker — adaptive per risk phase
  const phase    = riskPhase();
  const peakBal  = db.getPeakBalance();
  const curBal   = db.getBalance();
  const drawdown = peakBal > 0 ? (peakBal - curBal) / peakBal : 0;

  if (drawdown >= phase.drawdownLimit) {
    db.log('DRAWDOWN_HALT',
      `${(drawdown*100).toFixed(1)}% from peak €${peakBal.toFixed(2)} — no new positions`);
    const strong = signals.filter(s => s.score >= CONFIG.scanner.autoTradeScore);
    const decisions = strong.map(sig => ({
      pair: `${sig.ticker_a}/${sig.ticker_b}`, sector: sig.sector,
      z: sig.z_score, score: sig.score, action: 'BLOCKED',
      reason: `drawdown ${(drawdown*100).toFixed(1)}% >= ${(phase.drawdownLimit*100).toFixed(0)}% limit [${phase.name}]`,
    }));
    scanState.lastDecisions = decisions;
    scanState = { ...scanState, running: false, phase: 'complete',
      completedAt: new Date().toISOString(),
      nextScanAt: new Date(Date.now() + CONFIG.scanner.intervalMinutes * 60000).toISOString() };
    broadcastScanProgress();
    broadcastState();
    return [];
  }

  // VIX regime filter (uses FRED if key set, otherwise falls back to scanner's Yahoo VIX)
  const regime = await require('./osint/fred').getRegimeScore(vix)
    .catch(() => ({ score: 0, blocked: false, vix: null, vix3m: null, hyOas: null }));
  const regOk  = !regime.blocked;
  if (!regOk) {
    db.log('REGIME_BLOCK', `score=${regime.score} vix=${regime.vix} hy=${regime.hyOas}`);
  }

  // OSINT: fetch all data sources in parallel before signal loop
  const [gdelt, eia, awards, cotData, yieldData] = await Promise.all([
    require('./osint/gdelt').getDefenseTensionIndex().catch(() => null),
    require('./osint/eia').getCrudeInventoryChange().catch(() => null),
    require('./osint/usaspending').getRecentLargeAwards().catch(() => null),
    require('./osint/cot').getCotPositioning().catch(() => null),
    require('./osint/yields').getYieldRegime().catch(() => null),
  ]);

  if (gdelt) db.log('GDELT_DATA', `tensionIndex=${gdelt.tensionIndex} articleCount=${gdelt.articleCount}`);
  if (eia)   db.log('EIA_DATA', `change=${eia.changeMMBbl}MMBbl latest=${eia.latestMMBbl} period=${eia.period}`);
  if (awards) db.log('USASPENDING_DATA', `winners=[${awards.winners.join(',')}] since=${awards.cutoffDate}`);
  if (cotData) {
    const cotSummary = Object.entries(cotData).map(([s,d]) => `${s}:${d.direction}${d.crowded?'!':''}(${d.netPct}%)`).join(' ');
    db.log('COT_DATA', cotSummary);
  }
  if (yieldData) {
    db.log('YIELD_DATA', `10Y-2Y=${yieldData.spread10y2y} HY=${yieldData.hySpread} score=${yieldData.score}` +
      (yieldData.banksWarning ? ' BANKS_WARN' : '') + (yieldData.creditStress ? ' CREDIT_STRESS' : ''));
  }

  // ML scorer: score every signal, only take those above threshold for current phase
  const currentPhase = riskPhase();
  const scored = signals.map(sig => {
    const ml = scoreSignal(sig, currentPhase.name);
    sig._mlProb  = ml.probability;
    sig._mlGrade = ml.grade;
    sig._mlTake  = ml.take;
    return sig;
  });

  // Sort by ML probability (best signals first), then filter
  scored.sort((a, b) => b._mlProb - a._mlProb);
  const strong = scored.filter(s => s._mlTake);

  // Log ML scoring summary
  const gradeCount = { A:0, B:0, C:0, D:0 };
  for (const s of scored) gradeCount[s._mlGrade]++;
  db.log('ML_SCORE', `${scored.length} signals → A=${gradeCount.A} B=${gradeCount.B} C=${gradeCount.C} D=${gradeCount.D} | ${strong.length} above threshold (${currentPhase.name})`);

  const decisions = [];

  if (!regOk) {
    for (const sig of strong) {
      decisions.push({ pair: `${sig.ticker_a}/${sig.ticker_b}`, sector: sig.sector, z: sig.z_score, score: sig.score,
        mlProb: sig._mlProb, action: 'BLOCKED', reason: `regime score=${regime.score}` });
    }
  }

  for (const sig of strong) {
    const pair = `${sig.ticker_a}/${sig.ticker_b}`;
    if (!regOk) continue;

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

    // COT positioning: warn on crowded speculative positions in related futures
    if (cotData && cotData[sig.sector]?.crowded) {
      const cot = cotData[sig.sector];
      sig.score = Math.max(50, sig.score - 10);
      db.log('COT_CROWDED', `${pair}: ${sig.sector} net speculative ${cot.netPct}% (${cot.direction}) → score=${sig.score}`);
    }

    // Yield curve regime: block bank/FX pairs when curve is inverted or credit is stressed
    if (yieldData) {
      if (yieldData.banksWarning && (sig.sector === 'BANKS' || sig.sector === 'US_BANKS')) {
        decisions.push({ pair, sector: sig.sector, z: sig.z_score, score: sig.score,
          action: 'BLOCKED', reason: `yield curve flat/inverted (10Y-2Y=${yieldData.spread10y2y}) — bank spreads unreliable` });
        db.log('YIELD_BLOCK', `${pair}: 10Y-2Y=${yieldData.spread10y2y} — banks blocked`);
        continue;
      }
      if (yieldData.creditStress) {
        sig.score = Math.max(50, sig.score - 8);
        db.log('CREDIT_WARN', `${pair}: HY spread ${yieldData.hySpread}bps → score=${sig.score}`);
      }
    }

    // Short interest: block pairs where one leg has extreme short crowding
    try {
      const si = await require('./osint/shortinterest').checkPairShortInterest(sig.ticker_a, sig.ticker_b);
      if (si?.blocked) {
        decisions.push({ pair, sector: sig.sector, z: sig.z_score, score: sig.score,
          action: 'BLOCKED', reason: `short interest crowded: ${si.reason}` });
        db.log('SI_BLOCK', `${pair}: ${si.reason}`);
        continue;
      }
    } catch { /* non-critical — SI data often unavailable */ }

    // Earnings proximity filter (5-day window around earnings dates)
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
      mlProb: sig._mlProb, mlGrade: sig._mlGrade,
      action: opened ? 'OPENED' : 'FAILED',
      reason: opened ? `z=${sig.z_score} hl=${sig.half_life}d ML:${sig._mlGrade}(${sig._mlProb})` : 'position insert failed' });
  }

  // Signals below ML threshold are monitored but not acted on
  for (const sig of scored.filter(s => !s._mlTake)) {
    decisions.push({ pair: `${sig.ticker_a}/${sig.ticker_b}`, sector: sig.sector,
      z: sig.z_score, score: sig.score, mlProb: sig._mlProb,
      action: 'WATCHING',
      reason: `ML grade ${sig._mlGrade} (P=${sig._mlProb}) below ${currentPhase.name} threshold` });
  }

  scanState.lastDecisions = decisions;
  scanState.lastVix = regime.vix ? +regime.vix.toFixed(1) : (vix ? +vix.toFixed(1) : null);

  // Telegram scan summary (only sends if there are signals or opened trades)
  telegram.scanSummary(signals.length, decisions, riskPhase().name, scanState.lastVix).catch(() => {});

  scanState = { ...scanState, running: false, phase: 'complete',
    completedAt: new Date().toISOString(),
    nextScanAt: new Date(Date.now() + CONFIG.scanner.intervalMinutes * 60000).toISOString() };
  broadcastScanProgress();
  broadcastState();
  return signals;
}

// (Options updatePnL removed in v5.2 — options infrastructure deprecated)

// ── LIVE KALMAN HEDGE UPDATE ─────────────────────────────
// Single-step Kalman predict-update for the hedge ratio.
// State: [alpha_t, beta_t]. Persists on pos object between polls.
// Identical math to scanner.js kalmanHedgeRatio, but incremental.
function kalmanUpdate(pos, logA, logB) {
  const delta = 0.0001;  // matches scanner.js CONFIG.kalmanDelta
  const Ve = 0.001;

  if (!pos._kf_theta) {
    pos._kf_theta = [0, pos.kalman_beta ?? pos.hedge_ratio];
    pos._kf_P = [[1, 0], [0, 1]];
  }

  let theta = pos._kf_theta;
  let P = pos._kf_P;
  const F = [1, logB];

  const Pp = [[P[0][0] + delta, P[0][1]], [P[1][0], P[1][1] + delta]];
  const PF = [Pp[0][0] * F[0] + Pp[0][1] * F[1], Pp[1][0] * F[0] + Pp[1][1] * F[1]];
  const S = F[0] * PF[0] + F[1] * PF[1] + Ve;
  const K = [PF[0] / S, PF[1] / S];
  const innov = logA - (F[0] * theta[0] + F[1] * theta[1]);
  theta = [theta[0] + K[0] * innov, theta[1] + K[1] * innov];
  P = [[Pp[0][0] - K[0] * PF[0], Pp[0][1] - K[0] * PF[1]],
       [Pp[1][0] - K[1] * PF[0], Pp[1][1] - K[1] * PF[1]]];

  pos._kf_theta = theta;
  pos._kf_P = P;
  return theta[1]; // live beta
}

// ── DATA-DRIVEN EXIT ────────────────────────────────────
// Five rules, each proven on 3,233+ trades. Live Kalman fixes the
// hedge drift. Parameters tuned from backtest data, not theory.
//
// Priority order:
// 1. REVERT  — z crossed back through zero (97.8% WR)
// 2. DIVERGE — dynamic SL tightens with age (cuts losers)
// 3. TRAIL   — protect captured gains (60% of peak)
// 4. STALL   — z-velocity flat for 3+ readings (cuts dying trades)
// 5. OVERTIME — hard time limit (15d cap, not 30)
function dataExit(pos, zRolling, pnlPct, ageDays) {
  const ageFrac = ageDays / Math.max(1, pos.half_life);
  const absZ = Math.abs(zRolling);
  const absEntryZ = Math.abs(pos.z_entry);

  // Track peaks
  if (pos._maxPnlPct === undefined) pos._maxPnlPct = -Infinity;
  if (pos._peakAgeFrac === undefined) pos._peakAgeFrac = 0;
  if (pnlPct >= pos._maxPnlPct) {
    pos._maxPnlPct = pnlPct;
    pos._peakAgeFrac = ageFrac;
  }

  // Track z-velocity (rate of |z| decrease toward zero)
  if (!pos._zHist) pos._zHist = [];
  pos._zHist.push(absZ);
  if (pos._zHist.length > 8) pos._zHist.shift();

  // 1. REVERT: z-score has crossed back through zero band
  if (absZ < 0.5) return 'REVERT';

  // 2. DIVERGE: z moving away. SL tightens from 1.5× to 1.0× entry z
  //    over one half-life. New trade gets room; aged trade gets cut.
  const slMult = 1.5 - 0.5 * Math.min(ageFrac, 1.0);
  if (absZ > absEntryZ * slMult) return 'DIVERGE';

  // 3. TRAIL: once P&L exceeds +1.5%, protect gains.
  //    Floor starts at 60% of peak (not 40% — data showed 40% lets
  //    gains evaporate). Decays to 40% over one ageFrac unit.
  if (pos._maxPnlPct > 1.5 && ageDays >= 2) {
    const ageSincePeak = ageFrac - pos._peakAgeFrac;
    const floorPct = Math.max(0.40, 0.60 - 0.20 * Math.min(ageSincePeak, 1.0));
    const floor = pos._maxPnlPct * floorPct;
    if (pnlPct < floor) return 'TRAIL';
  }

  // 4. STALL: z is not reverting. If |z| has not decreased for
  //    3 consecutive readings after day 3, the trade is dead.
  //    Data: catches 74% of TIME_CUT trades, saves avg 6.2% per trade.
  if (pos._zHist.length >= 4 && ageDays >= 3) {
    const h = pos._zHist;
    const last4 = h.slice(-4);
    let stalling = true;
    for (let i = 1; i < last4.length; i++) {
      if (last4[i-1] - last4[i] > 0.05) { stalling = false; break; }
    }
    if (stalling) return 'STALL';
  }

  // 5. OVERTIME: hard cap. Data: trades held >10d lose money.
  //    Use min(2× halfLife, 15) — fast pairs get 10d, slow pairs 15d max.
  const maxHold = Math.min(2.0 * pos.half_life, 15);
  if (ageDays > maxHold) return 'OVERTIME';

  return null; // hold
}

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

      // Live Kalman hedge ratio — updates beta on every poll
      const logA_now = Math.log(spotA) + Math.log(fxA);
      const logB_now = Math.log(spotB) + Math.log(fxB);
      const liveBeta = kalmanUpdate(pos, logA_now, logB_now);

      // ── HEDGE REBALANCING ─────────────────────────────────
      // THIS IS THE FIX: when Kalman beta changes, ACTUALLY adjust
      // shares_b so the P&L follows the z-score. Without this,
      // z reverts (97.8%) but dollars don't follow (49-66% WR).
      //
      // The z-score uses liveBeta for spread calculation.
      // The P&L must use the SAME hedge — otherwise they diverge.
      const longA = pos.direction === 'LONG_A_SHORT_B';

      if (pos._rebalPnl === undefined) {
        // First poll: initialize rebalance tracking
        pos._rebalPnl = 0;         // accumulated P&L from completed intervals
        pos._rebalCost = 0;        // accumulated rebalance costs
        pos._activeBeta = pos.kalman_beta ?? pos.hedge_ratio;
        pos._refSpotB = pos.spot_b_entry;
        pos._refFxB = fxB;
        pos._rebalCount = 0;
      }

      // Check if rebalance needed (10% drift from active beta)
      const betaDrift = Math.abs(liveBeta - pos._activeBeta) / Math.abs(pos._activeBeta || 1);
      if (betaDrift > 0.10 && pos._rebalCount < 20) {
        // Close current leg B interval — lock in P&L on old shares
        const refB_usd = pos._refSpotB * pos._refFxB;
        const intervalPnlB = pos.shares_b * (spotB_usd - refB_usd) * (longA ? -1 : 1);
        pos._rebalPnl += intervalPnlB;

        // Compute new shares_b to match live beta (dollar-neutral)
        const oldSharesB = pos.shares_b;
        const newSharesB = +(Math.abs(pos.shares_a * liveBeta * spotA / spotB)).toFixed(6);

        // Rebalance cost: trade the delta on leg B only (~10bps one-way)
        const sharesDelta = Math.abs(newSharesB - oldSharesB);
        const rebalCost = +(sharesDelta * spotB * 0.001).toFixed(4);
        pos._rebalCost += rebalCost;

        db.log('REBALANCE',
          `${pos.ticker_a}/${pos.ticker_b}: β ${pos._activeBeta.toFixed(4)}→${liveBeta.toFixed(4)} ` +
          `sharesB ${oldSharesB.toFixed(4)}→${newSharesB.toFixed(4)} cost €${rebalCost.toFixed(2)}`);

        // Update position to new hedge
        pos.shares_b = newSharesB;
        pos._activeBeta = liveBeta;
        pos._refSpotB = spotB;
        pos._refFxB = fxB;
        pos._rebalCount++;
      }

      const currentSpread = logA_now - liveBeta * logB_now;

      // ── Rolling z-score ────────────────────────────────────
      const pnlHistory = db.getPairPnlHistory(pos.id);
      const spreadHistory = pnlHistory.map(r => {
        const sa = r.spot_a, sb = r.spot_b;
        return (Math.log(sa) + Math.log(fxA)) - liveBeta * (Math.log(sb) + Math.log(fxB));
      });
      spreadHistory.push(currentSpread);
      const zWindow = spreadHistory.slice(-20);
      const zMean = zWindow.reduce((a,b) => a+b, 0) / zWindow.length;
      const zStd = Math.sqrt(zWindow.reduce((a,b) => a+(b-zMean)**2, 0) / zWindow.length);
      const rollingZ = zStd > 1e-10 ? (currentSpread - zMean) / zStd : 0;

      // Keep OU z for logging/diagnostics only
      const ouStd = pos.ou_sigma / Math.sqrt(252 * 2 * pos.ou_kappa);
      const ouZ = ouStd > 1e-8 ? (currentSpread - pos.ou_theta) / ouStd : 0;

      const zCurrent = rollingZ;

      // ── P&L: leg A from entry + leg B from last rebalance + accumulated ──
      const pnlA_usd = pos.shares_a * (spotA_usd - entryA_usd) * (longA ?  1 : -1);
      const refB_usd = pos._refSpotB * pos._refFxB;
      const pnlB_usd = pos.shares_b * (spotB_usd - refB_usd) * (longA ? -1 :  1);
      const pnlUsd   = pnlA_usd + pnlB_usd + pos._rebalPnl - pos._rebalCost;
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

      // ── DATA-DRIVEN EXIT ─────────────────────────────────────
      // Five proven rules + live Kalman hedge. No theory that doesn't work.
      const ageDays = (Date.now() - new Date(pos.opened_at).getTime()) / 86400000;
      const exitReason = dataExit(pos, zCurrent, pnlPct, ageDays);

      if (exitReason) {
        const exitCost = calcTxCost(pos.notional_eur);
        db.bookCapital({ event: 'TX_COST_EXIT', position_id: pos.id, amount: -exitCost,
          note: `Exit cost ${pos.ticker_a}/${pos.ticker_b}` });
        db.closePairPosition(pos.id, exitReason, pnlEur);
        db.log('PAIR_CLOSED',
          `${pos.ticker_a}/${pos.ticker_b} [${exitReason}] ${pnlPct >= 0 ? '+' : ''}${pnlPct}%`);
        telegram.tradeClosed(pos, exitReason, pnlEur, pnlPct).catch(() => {});
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

  const phase = riskPhase();
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
    riskPhase: {
      name:          phase.name,
      maxRiskPct:    phase.maxRiskPct,
      maxPositions:  phase.maxPositions,
      drawdownLimit: phase.drawdownLimit,
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
  // SSE keepalive: send a comment every 25s to prevent browsers/proxies from dropping the connection
  const heartbeat = setInterval(() => {
    try { res.write(`: heartbeat ${Date.now()}\n\n`); } catch(_) { clearInterval(heartbeat); }
  }, 25000);
  req.on('close', () => { clearInterval(heartbeat); clients.delete(res); });
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
  // Scanner filter params (runtime-tunable)
  hurstMax:         SCANNER_CONFIG.hurstMax,
  maxBetaDrift:     SCANNER_CONFIG.maxBetaDrift,
  minSpreadIR:      SCANNER_CONFIG.minSpreadIR,
  minVolumeUSD:     SCANNER_CONFIG.minVolumeUSD,
  zScoreEntry:      SCANNER_CONFIG.zScoreEntry,
  halfLifeMin:      SCANNER_CONFIG.halfLifeMin,
  halfLifeMax:      SCANNER_CONFIG.halfLifeMax,
  oosAlpha:         SCANNER_CONFIG.oosAlpha,
  hlCvMax:          SCANNER_CONFIG.hlCvMax,
  maxHoldDays:      CONFIG.scanner.maxHoldDays,
  leverage:         CONFIG.leverage,
}));

app.patch('/config', requireAuth, (req, res) => {
  const b = req.body;
  // Server-level config
  if (b.autoTradeScore   != null && b.autoTradeScore   >= 50 && b.autoTradeScore   <= 100) { CONFIG.scanner.autoTradeScore  = +b.autoTradeScore;   db.log('CONFIG_CHANGE', `autoTradeScore → ${b.autoTradeScore}`);   }
  if (b.vixThreshold     != null && b.vixThreshold     >= 10 && b.vixThreshold     <= 80)  { CONFIG.vixThreshold            = +b.vixThreshold;     db.log('CONFIG_CHANGE', `vixThreshold → ${b.vixThreshold}`);       }
  if (b.maxOpenPositions != null && b.maxOpenPositions >=  1 && b.maxOpenPositions <= 20)  { CONFIG.scanner.maxOpenPositions= +b.maxOpenPositions;  db.log('CONFIG_CHANGE', `maxOpenPositions → ${b.maxOpenPositions}`);}
  if (b.maxPerSector     != null && b.maxPerSector     >=  1 && b.maxPerSector     <= 10)  { CONFIG.scanner.maxPerSector    = +b.maxPerSector;      db.log('CONFIG_CHANGE', `maxPerSector → ${b.maxPerSector}`);       }
  // Scanner filter config (writes directly to scanner.js CONFIG object)
  if (b.hurstMax         != null && b.hurstMax         >= 0.3 && b.hurstMax        <= 0.8) { SCANNER_CONFIG.hurstMax        = +b.hurstMax;         db.log('CONFIG_CHANGE', `hurstMax → ${b.hurstMax}`);               }
  if (b.maxBetaDrift     != null && b.maxBetaDrift     >= 0.2 && b.maxBetaDrift    <= 5.0) { SCANNER_CONFIG.maxBetaDrift    = +b.maxBetaDrift;     db.log('CONFIG_CHANGE', `maxBetaDrift → ${b.maxBetaDrift}`);       }
  if (b.minSpreadIR      != null && b.minSpreadIR      >= 0   && b.minSpreadIR     <= 1.0) { SCANNER_CONFIG.minSpreadIR     = +b.minSpreadIR;      db.log('CONFIG_CHANGE', `minSpreadIR → ${b.minSpreadIR}`);         }
  if (b.minVolumeUSD     != null && b.minVolumeUSD     >= 0   && b.minVolumeUSD    <= 1e9) { SCANNER_CONFIG.minVolumeUSD    = +b.minVolumeUSD;     db.log('CONFIG_CHANGE', `minVolumeUSD → ${b.minVolumeUSD}`);       }
  if (b.zScoreEntry      != null && b.zScoreEntry      >= 1.0 && b.zScoreEntry     <= 4.0) { SCANNER_CONFIG.zScoreEntry     = +b.zScoreEntry;      db.log('CONFIG_CHANGE', `zScoreEntry → ${b.zScoreEntry}`);         }
  if (b.halfLifeMin      != null && b.halfLifeMin      >= 1   && b.halfLifeMin     <= 30)  { SCANNER_CONFIG.halfLifeMin     = +b.halfLifeMin;      db.log('CONFIG_CHANGE', `halfLifeMin → ${b.halfLifeMin}`);         }
  if (b.halfLifeMax      != null && b.halfLifeMax      >= 20  && b.halfLifeMax     <= 200) { SCANNER_CONFIG.halfLifeMax     = +b.halfLifeMax;      db.log('CONFIG_CHANGE', `halfLifeMax → ${b.halfLifeMax}`);         }
  if (b.oosAlpha         != null && b.oosAlpha         >= 0.01&& b.oosAlpha        <= 0.5) { SCANNER_CONFIG.oosAlpha        = +b.oosAlpha;         db.log('CONFIG_CHANGE', `oosAlpha → ${b.oosAlpha}`);               }
  if (b.hlCvMax          != null && b.hlCvMax          >= 0.1 && b.hlCvMax         <= 2.0) { SCANNER_CONFIG.hlCvMax         = +b.hlCvMax;          db.log('CONFIG_CHANGE', `hlCvMax → ${b.hlCvMax}`);                 }
  if (b.maxHoldDays      != null && b.maxHoldDays      >= 3   && b.maxHoldDays     <= 60)  { CONFIG.scanner.maxHoldDays     = +b.maxHoldDays;      db.log('CONFIG_CHANGE', `maxHoldDays → ${b.maxHoldDays}`);         }
  if (b.leverage         != null && b.leverage         >= 1   && b.leverage        <= 10)  { CONFIG.leverage                = +b.leverage;         db.log('CONFIG_CHANGE', `leverage → ${b.leverage}`);               }
  broadcastState();
  res.json({ ok: true });
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
    'VIX',        // Yahoo Finance (always on)
    'Yields',     // Yahoo Finance: treasury yields + HYG/LQD credit
    'GDELT',
    'USASpend',
    'ShortInt',   // Yahoo Finance: short % of float
    'COT*',       // CFTC.gov: may fail if Cloudflare blocks
    process.env.FRED_API_KEY ? 'FRED(enhanced)' : null,
    process.env.EIA_API_KEY  ? 'EIA'            : null,
  ].filter(Boolean).join(', ');
  const osintOff = [
    process.env.EIA_API_KEY  ? null : 'EIA',
  ].filter(Boolean);
  const osintLine = `ON: ${osintActive}` + (osintOff.length ? `  OFF: ${osintOff.join(',')}` : '');
  const emailStatus = CONFIG.email.from ? `ON (${CONFIG.email.from})` : 'OFF (set SMTP_FROM + SMTP_PASSWORD)';
  const tgStatus = telegram.isConfigured() ? 'ON' : 'OFF (set TELEGRAM_KEY + TELEGRAM_CHAT_ID)';

  console.log(`
╔═══════════════════════════════════════════════╗
║  PAIR INTELLIGENCE SCANNER  v5.2              ║
║  http://localhost:${String(CONFIG.port).padEnd(28)}║
║  ${(CONFIG.paperMode ? 'Mode: PAPER (safe)' : 'Mode: LIVE – REAL MONEY').padEnd(44)}║
║  OSINT: ${osintLine.padEnd(38)}║
║  Email: ${emailStatus.padEnd(38)}║
║  TG: ${tgStatus.padEnd(41)}║
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

  // Telegram daily summary — sends at 18:00 UTC (after market close)
  setInterval(() => {
    const h = new Date().getUTCHours();
    const m = new Date().getUTCMinutes();
    if (h === 18 && m < 15 && telegram.isConfigured()) {
      const pairPositions = db.getOpenPairPositions().map(p => {
        const hist = db.getPairPnlHistory(p.id);
        return { ...p, latest: hist[hist.length - 1] || null };
      });
      telegram.dailySummary(db.getStats(), pairPositions, riskPhase().name).catch(() => {});
    }
  }, 15 * 60 * 1000);
});
