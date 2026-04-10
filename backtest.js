'use strict';
// ═══════════════════════════════════════════════════════
//  backtest.js — Walk-forward backtest for spread signals
//
//  Usage:  node backtest.js [--months 24] [--capital 5000] [--leverage 3]
//
//  Fetches 3 years of daily prices (1yr lookback + 2yr test),
//  then walks forward week by week:
//    1. Build the cointegration model on trailing data
//    2. Generate signals using the same pipeline as scanner.js
//    3. Open/close paper positions with realistic costs
//    4. Track P&L, compute Sharpe, win rate, max drawdown
//
//  Output: console table + JSON results file.
// ═══════════════════════════════════════════════════════

const { UNIVERSE, CONFIG, FETCH_DELAY_MS } = require('./scanner');
const { scoreSignal } = require('./scorer');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

// ── Parse CLI args ──────────────────────────────────────
const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const TEST_MONTHS   = parseInt(arg('months', '24'));
const STARTING_CAP  = parseFloat(arg('capital', '5000'));
const LEVERAGE      = parseFloat(arg('leverage', '1'));
const COST_BPS      = 20;
const MAX_NEW_PER_SCAN = parseInt(arg('maxnew', '1'));  // stagger: max 1 new position per scan
const VERBOSE       = args.includes('--verbose');

// ── Reuse scanner internals ─────────────────────────────
// We re-implement the core analysis inline to avoid DB dependency,
// but use the same math functions from scanner.js.
// Import the module to get access to CONFIG thresholds.

function ols(y, x) {
  const n = y.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; sxx += x[i]*x[i]; sxy += x[i]*y[i]; }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const beta = (n * sxy - sx * sy) / denom;
  const alpha = (sy - beta * sx) / n;
  const resid = y.map((yi, i) => yi - alpha - beta * x[i]);
  const yMean = sy / n;
  const ssTot = y.reduce((a, yi) => a + (yi - yMean) ** 2, 0);
  const ssRes = resid.reduce((a, e) => a + e * e, 0);
  return { alpha, beta, residuals: resid, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0 };
}

function ouFit(spread) {
  const fit = ols(spread.slice(1), spread.slice(0, -1));
  if (!fit || fit.beta <= 0 || fit.beta >= 1) return null;
  const kappa = -Math.log(fit.beta);
  const halfLife = Math.log(2) / kappa;
  const theta = fit.alpha / (1 - fit.beta);
  const sigma2 = fit.residuals.reduce((s, e) => s + e * e, 0) / (fit.residuals.length - 1);
  return { kappa, halfLife, theta, sigma: Math.sqrt(sigma2 * 252), r2: fit.r2 };
}

function rollingZScore(spread, window) {
  const slice = spread.slice(-window);
  const n = slice.length;
  const mean = slice.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  if (std < 1e-10) return null;
  return (spread[spread.length - 1] - mean) / std;
}

function hurstExponent(series) {
  const n = series.length;
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

// ── Data fetching ───────────────────────────────────────
async function fetchAllPrices() {
  // Need lookback + test period: 3yr lookback + TEST_MONTHS
  const totalDays = Math.ceil((CONFIG.lookbackDays / 252 * 365) + TEST_MONTHS * 30 + 60);
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - totalDays);
  const period1 = startDate.toISOString().split('T')[0];

  console.log(`Fetching ${UNIVERSE.length} tickers from ${period1}...`);
  const priceMap = {};
  let done = 0;

  for (const entry of UNIVERSE) {
    try {
      const chart = await yahooFinance.chart(entry.ticker, {
        period1,
        period2: new Date().toISOString().split('T')[0],
        interval: '1d',
      }, { validateResult: false });

      const quotes = chart.quotes || [];
      const data = quotes
        .filter(q => q.date && (q.adjclose ?? q.close) > 0)
        .map(q => ({
          date: q.date.toISOString().split('T')[0],
          close: q.adjclose ?? q.close,
        }));

      if (data.length >= CONFIG.minObs) {
        priceMap[entry.ticker] = data;
      }
    } catch (e) {
      if (VERBOSE) console.log(`  SKIP ${entry.ticker}: ${e.message.slice(0, 50)}`);
    }

    done++;
    if (done % 10 === 0) process.stdout.write(`  ${done}/${UNIVERSE.length}\r`);
    await new Promise(r => setTimeout(r, FETCH_DELAY_MS));
  }

  console.log(`Fetched ${Object.keys(priceMap).length}/${UNIVERSE.length} tickers with sufficient data`);
  return priceMap;
}

// ── Align two price series by date ──────────────────────
function alignByDate(dataA, dataB) {
  const mapB = new Map(dataB.map(d => [d.date, d.close]));
  const aligned = [];
  for (const d of dataA) {
    const bClose = mapB.get(d.date);
    if (bClose !== undefined) {
      aligned.push({ date: d.date, a: d.close, b: bClose });
    }
  }
  return aligned;
}

// ── Analyze a pair at a given point in time ─────────────
// funnel: optional object to count rejections per filter stage
function analyzePairAt(alignedData, endIdx, funnel) {
  const lookbackDays = 252;
  const lookback = Math.min(endIdx, Math.round(lookbackDays * 365 / 252));
  const startIdx = endIdx - lookback;
  if (lookback < CONFIG.minObs) { if (funnel) funnel.minObs++; return null; }

  const slice = alignedData.slice(startIdx, endIdx);
  const logA = slice.map(d => Math.log(d.a));
  const logB = slice.map(d => Math.log(d.b));

  const fit = ols(logA, logB);
  if (!fit || fit.beta <= 0) { if (funnel) funnel.ols++; return null; }

  const canonical = logA.map((la, i) => la - fit.beta * logB[i]);
  const hurst = hurstExponent(canonical);
  if (hurst >= CONFIG.hurstMax) { if (funnel) funnel.hurst++; return null; }

  const ou = ouFit(canonical);
  if (!ou) { if (funnel) funnel.ouFit++; return null; }
  if (ou.halfLife < CONFIG.halfLifeMin || ou.halfLife > CONFIG.halfLifeMax) { if (funnel) funnel.halfLife++; return null; }

  const zWindow = Math.max(20, Math.round(2 * ou.halfLife));
  const z = rollingZScore(canonical, zWindow);
  // Use scanner's z-score entry (currently 2.5 from analysis)
  if (z === null || Math.abs(z) < CONFIG.zScoreEntry) { if (funnel) funnel.zScore++; return null; }

  const direction = z > 0 ? 'SHORT_A_LONG_B' : 'LONG_A_SHORT_B';

  // Seed rolling z with last 20 spread values so exit z works from day 1
  const recentSpreads = canonical.slice(-20);

  return {
    hedgeRatio: fit.beta,
    z_score: z, z,
    half_life: ou.halfLife, halfLife: ou.halfLife,
    ou_theta: ou.theta, theta: ou.theta,
    ou_sigma: ou.sigma, sigma: ou.sigma,
    ou_kappa: ou.kappa, kappa: ou.kappa,
    ou_r2: fit.r2, hedge_ratio: fit.beta,
    hurst, direction,
    spotA: slice[slice.length - 1].a,
    spotB: slice[slice.length - 1].b,
    date: slice[slice.length - 1].date,
    _recentSpreads: recentSpreads,
  };
}

// ── Position tracker ────────────────────────────────────
class Portfolio {
  constructor(capital) {
    this.startingCapital = capital;
    this.balance = capital;
    this.peak = capital;
    this.positions = [];
    this.closedTrades = [];
    this.dailyReturns = [];
    this.prevBalance = capital;
    this.maxDrawdown = 0;
  }

  canOpen() {
    return this.positions.length < 8 && this.balance > 100;
  }

  hasLeg(tickerA, tickerB) {
    return this.positions.some(p =>
      p.tickerA === tickerA || p.tickerA === tickerB ||
      p.tickerB === tickerA || p.tickerB === tickerB
    );
  }

  open(signal, entryA, entryB) {
    const multiple = this.balance / this.startingCapital;
    const riskPct = multiple < 3 ? 0.06 : multiple < 10 ? 0.04 : 0.02;
    const notional = this.balance * riskPct * LEVERAGE;
    if (notional < 50) return null;

    const sharesA = notional / entryA.close;
    const sharesB = sharesA * signal.hedgeRatio * entryA.close / entryB.close;
    const cost = notional * 2 * COST_BPS / 10000;

    this.balance -= notional + cost;

    const pos = {
      tickerA: entryA.ticker, tickerB: entryB.ticker,
      sector: entryA.sector,
      direction: signal.direction,
      openDate: signal.date,
      spotAEntry: entryA.close, spotBEntry: entryB.close,
      hedgeRatio: signal.hedgeRatio,
      _spreadHist: signal._recentSpreads || [],  // seed with pre-open spread history
      sharesA, sharesB, notional,
      zEntry: signal.z,
      halfLife: signal.halfLife,
      theta: signal.theta, sigma: signal.sigma, kappa: signal.kappa,
      tpZ: Math.max(0.3, Math.abs(signal.z) * 0.15),
      slZ: Math.min(4.0, Math.abs(signal.z) * 1.30),  // tighter SL — cut losers faster
    };
    this.positions.push(pos);
    return pos;
  }

  update(date, priceMap) {
    const toClose = [];

    for (let i = this.positions.length - 1; i >= 0; i--) {
      const pos = this.positions[i];
      const prA = priceMap[pos.tickerA]?.find(d => d.date === date);
      const prB = priceMap[pos.tickerB]?.find(d => d.date === date);
      if (!prA || !prB) continue;

      const spotA = prA.close;
      const spotB = prB.close;
      const currentSpread = Math.log(spotA) - pos.hedgeRatio * Math.log(spotB);

      // Rolling z-score (gap analysis: rolling z = 97.8% WR, OU z = 28% WR)
      pos._spreadHist.push(currentSpread);
      const window = pos._spreadHist.slice(-20);
      const wMean = window.reduce((a,b)=>a+b,0) / window.length;
      const wStd = Math.sqrt(window.reduce((a,b)=>a+(b-wMean)**2,0) / window.length);
      const zCurrent = wStd > 1e-10 ? (currentSpread - wMean) / wStd : 0;

      const longA = pos.direction === 'LONG_A_SHORT_B';
      const pnlA = pos.sharesA * (spotA - pos.spotAEntry) * (longA ? 1 : -1);
      const pnlB = pos.sharesB * (spotB - pos.spotBEntry) * (longA ? -1 : 1);
      const pnlUsd = pnlA + pnlB;

      const ageDays = (new Date(date) - new Date(pos.openDate)) / 86400000;
      const pnlPctNow = pos.notional > 0 ? (pnlUsd / pos.notional) * 100 : 0;

      // Dynamic sliding window exit — one unified function
      const ageFrac = ageDays / Math.max(1, pos.halfLife);
      const absZ = Math.abs(zCurrent);
      const absEntryZ = Math.abs(pos.zEntry);
      const expectedZ = absEntryZ * Math.exp(-(pos.kappa || 0.05) * ageDays);

      if (pos._maxPnlPct === undefined) pos._maxPnlPct = -Infinity;
      if (pos._peakAgeFrac === undefined) pos._peakAgeFrac = 0;
      if (pnlPctNow >= pos._maxPnlPct) { pos._maxPnlPct = pnlPctNow; pos._peakAgeFrac = ageFrac; }

      let exitReason = null;
      // 1. REVERT
      if (absZ < 0.5) exitReason = 'REVERT';
      // 2. DIVERGE
      if (!exitReason) {
        const slMult = 1.5 - 0.5 * Math.min(ageFrac, 1.0);
        if (absZ > absEntryZ * slMult) exitReason = 'DIVERGE';
      }
      // 3. TRAIL
      if (!exitReason && pos._maxPnlPct > 1.0 && ageDays >= 1) {
        const ageSincePeak = ageFrac - pos._peakAgeFrac;
        const floorPct = Math.max(0.5, 0.8 - 0.3 * Math.min(ageSincePeak, 1.0));
        if (pnlPctNow < pos._maxPnlPct * floorPct) exitReason = 'TRAIL';
      }
      // 4. STALL
      if (!exitReason && ageFrac > 0.5 && absZ > expectedZ * 1.2) exitReason = 'STALL';
      // 5. OVERTIME
      if (!exitReason && ageDays > Math.min(2.0 * pos.halfLife, 20)) exitReason = 'OVERTIME';

      if (exitReason) {
        const exitCost = pos.notional * 2 * COST_BPS / 10000;
        const returned = pos.notional + pnlUsd - exitCost;
        this.balance += returned;

        this.closedTrades.push({
          ...pos,
          closeDate: date,
          exitReason,
          pnl: +pnlUsd.toFixed(2),
          pnlPct: +((pnlUsd / pos.notional) * 100).toFixed(2),
          ageDays: +ageDays.toFixed(1),
          zExit: +zCurrent.toFixed(3),
        });
        this.positions.splice(i, 1);
      }
    }

    // Track daily return
    const dailyRet = this.prevBalance > 0 ? (this.balance - this.prevBalance) / this.prevBalance : 0;
    this.dailyReturns.push(dailyRet);
    this.prevBalance = this.balance;

    // Drawdown
    if (this.balance > this.peak) this.peak = this.balance;
    const dd = this.peak > 0 ? (this.peak - this.balance) / this.peak : 0;
    if (dd > this.maxDrawdown) this.maxDrawdown = dd;
  }

  stats() {
    const trades = this.closedTrades;
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);

    // Sharpe (annualized daily returns)
    const dr = this.dailyReturns;
    const meanR = dr.reduce((a, b) => a + b, 0) / (dr.length || 1);
    const stdR = Math.sqrt(dr.reduce((a, r) => a + (r - meanR) ** 2, 0) / (dr.length || 1));
    const sharpe = stdR > 0 ? (meanR / stdR) * Math.sqrt(252) : 0;

    // By sector
    const sectors = {};
    for (const t of trades) {
      if (!sectors[t.sector]) sectors[t.sector] = { trades: 0, wins: 0, totalPnl: 0 };
      sectors[t.sector].trades++;
      if (t.pnl > 0) sectors[t.sector].wins++;
      sectors[t.sector].totalPnl += t.pnl;
    }

    return {
      totalTrades:    trades.length,
      wins:           wins.length,
      losses:         losses.length,
      winRate:        trades.length > 0 ? +(wins.length / trades.length * 100).toFixed(1) : 0,
      avgWin:         wins.length > 0 ? +(wins.reduce((a, t) => a + t.pnl, 0) / wins.length).toFixed(2) : 0,
      avgLoss:        losses.length > 0 ? +(losses.reduce((a, t) => a + t.pnl, 0) / losses.length).toFixed(2) : 0,
      totalPnl:       +trades.reduce((a, t) => a + t.pnl, 0).toFixed(2),
      finalBalance:   +this.balance.toFixed(2),
      totalReturn:    +(((this.balance - this.startingCapital) / this.startingCapital) * 100).toFixed(2),
      maxDrawdown:    +(this.maxDrawdown * 100).toFixed(1),
      sharpe:         +sharpe.toFixed(3),
      avgHoldDays:    trades.length > 0 ? +(trades.reduce((a, t) => a + t.ageDays, 0) / trades.length).toFixed(1) : 0,
      sectors,
    };
  }
}

// ── Main backtest loop ──────────────────────────────────
async function run() {
  console.log(`\n=== BACKTEST: ${TEST_MONTHS}m, €${STARTING_CAP}, ${LEVERAGE}x leverage, ${COST_BPS}bps, max ${MAX_NEW_PER_SCAN} new/scan ===\n`);

  const priceMap = await fetchAllPrices();
  const tickers = Object.keys(priceMap);

  // Build date index (union of all dates)
  const dateSet = new Set();
  for (const data of Object.values(priceMap)) {
    for (const d of data) dateSet.add(d.date);
  }
  const allDates = [...dateSet].sort();

  // Test period: last TEST_MONTHS months
  const testStart = new Date();
  testStart.setMonth(testStart.getMonth() - TEST_MONTHS);
  const testStartStr = testStart.toISOString().split('T')[0];
  const testDates = allDates.filter(d => d >= testStartStr);

  console.log(`Test period: ${testDates[0]} → ${testDates[testDates.length - 1]} (${testDates.length} trading days)`);
  console.log(`Universe: ${tickers.length} tickers\n`);

  // Generate same-sector pairs (most likely to cointegrate)
  // Exclude sectors that historically lose money in pairs trading
  // Only sectors with proven backtest edge
  // Let the ML scorer decide — no static sector filter
  const { SECTOR_WHITELIST } = require('./scanner');
  const entries = UNIVERSE.filter(e => priceMap[e.ticker] && SECTOR_WHITELIST.has(e.sector));
  const pairs = [];
  for (let i = 0; i < entries.length - 1; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[i].sector === entries[j].sector) pairs.push([entries[i], entries[j]]);
    }
  }
  console.log(`Testing ${pairs.length} same-sector pairs\n`);

  const portfolio = new Portfolio(STARTING_CAP);

  // Pre-align all pairs
  const alignedPairs = pairs.map(([a, b]) => ({
    a, b,
    aligned: alignByDate(priceMap[a.ticker], priceMap[b.ticker]),
  }));

  // Walk forward: check signals every 5 trading days (weekly)
  let lastScanIdx = -999;
  const SCAN_INTERVAL = 3;  // scan every 3 trading days
  const totalFunnel = { minObs:0, ols:0, hurst:0, ouFit:0, halfLife:0, zScore:0, total:0 };
  let firstDiag = true;

  for (let di = 0; di < testDates.length; di++) {
    const date = testDates[di];

    // Update existing positions daily
    portfolio.update(date, priceMap);

    // Scan for new signals weekly
    if (di - lastScanIdx < SCAN_INTERVAL) continue;
    if (!portfolio.canOpen()) continue;
    lastScanIdx = di;

    // Find the date index in allDates for lookback
    const globalIdx = allDates.indexOf(date);
    if (globalIdx < CONFIG.minObs) continue;

    const signals = [];
    const scanFunnel = { minObs:0, ols:0, hurst:0, ouFit:0, halfLife:0, zScore:0 };

    for (const { a, b, aligned } of alignedPairs) {
      // Find end index in aligned data for this date
      let endIdx = -1;
      for (let k = aligned.length - 1; k >= 0; k--) {
        if (aligned[k].date <= date) { endIdx = k + 1; break; }
      }
      if (endIdx < CONFIG.minObs) continue;

      const signal = analyzePairAt(aligned, endIdx, scanFunnel);
      if (!signal) continue;

      signal.tickerA = a.ticker;
      signal.tickerB = b.ticker;
      signal.sector = a.sector;

      // ML scorer: only take signals above threshold
      const mult = portfolio.balance / portfolio.startingCapital;
      const ml = scoreSignal(signal, mult < 3 ? 'AGGRESSIVE' : mult < 10 ? 'GROWTH' : 'PROTECT');
      if (!ml.take) { if (scanFunnel) scanFunnel.mlReject = (scanFunnel.mlReject||0) + 1; continue; }
      signal._mlScore = ml.score;
      signal._mlGrade = ml.grade;
      signals.push({ signal, a, b });
    }

    // Diagnostic: show filter funnel on first scan
    if (firstDiag) {
      firstDiag = false;
      const tested = Object.values(scanFunnel).reduce((a,b)=>a+b,0) + signals.length;
      console.log(`\nDiagnostic scan on ${date}: ${tested} pairs tested`);
      console.log(`  Filter funnel: ${Object.entries(scanFunnel).filter(([,v])=>v>0).map(([k,v])=>k+'='+v).join(' ')} → ${signals.length} signals\n`);
    }
    // Accumulate
    for (const k of Object.keys(scanFunnel)) totalFunnel[k] = (totalFunnel[k]||0) + scanFunnel[k];
    totalFunnel.total += signals.length;

    // Sort by ML score descending (best signals first)
    signals.sort((a, b) => (b.signal._mlScore || 0) - (a.signal._mlScore || 0));

    let openedThisScan = 0;
    for (const { signal, a, b } of signals) {
      if (!portfolio.canOpen()) break;
      if (openedThisScan >= MAX_NEW_PER_SCAN) break;  // stagger entries
      if (portfolio.hasLeg(a.ticker, b.ticker)) continue;

      const entryA = { ticker: a.ticker, sector: a.sector, close: signal.spotA };
      const entryB = { ticker: b.ticker, sector: b.sector, close: signal.spotB };
      const pos = portfolio.open(signal, entryA, entryB);

      if (pos) {
        openedThisScan++;
        if (VERBOSE) console.log(`  ${date} OPEN ${a.ticker}/${b.ticker} z=${signal.z.toFixed(2)} hl=${signal.halfLife.toFixed(0)}d`);
      }
    }

    // Progress
    if (di % 20 === 0) {
      process.stdout.write(`  Day ${di}/${testDates.length} | Balance: €${portfolio.balance.toFixed(0)} | Open: ${portfolio.positions.length} | Closed: ${portfolio.closedTrades.length}\r`);
    }
  }

  // Close remaining open positions at last price
  const lastDate = testDates[testDates.length - 1];
  for (const pos of [...portfolio.positions]) {
    const prA = priceMap[pos.tickerA]?.find(d => d.date === lastDate);
    const prB = priceMap[pos.tickerB]?.find(d => d.date === lastDate);
    if (prA && prB) {
      const longA = pos.direction === 'LONG_A_SHORT_B';
      const pnl = pos.sharesA * (prA.close - pos.spotAEntry) * (longA ? 1 : -1) +
                  pos.sharesB * (prB.close - pos.spotBEntry) * (longA ? -1 : 1);
      portfolio.balance += pos.notional + pnl;
      portfolio.closedTrades.push({
        ...pos, closeDate: lastDate, exitReason: 'END_OF_TEST',
        pnl: +pnl.toFixed(2), pnlPct: +((pnl / pos.notional) * 100).toFixed(2),
        ageDays: +((new Date(lastDate) - new Date(pos.openDate)) / 86400000).toFixed(1),
        zExit: 0,
      });
    }
  }
  portfolio.positions = [];

  // ── Results ───────────────────────────────────────────
  const st = portfolio.stats();
  console.log('\n\n═══════════════════════════════════════════');
  console.log('  BACKTEST RESULTS');
  console.log('═══════════════════════════════════════════');
  console.log(`  Period:        ${testDates[0]} → ${testDates[testDates.length - 1]}`);
  console.log(`  Starting:      €${STARTING_CAP}`);
  console.log(`  Final:         €${st.finalBalance}`);
  console.log(`  Return:        ${st.totalReturn >= 0 ? '+' : ''}${st.totalReturn}%`);
  console.log(`  Sharpe:        ${st.sharpe}`);
  console.log(`  Max Drawdown:  ${st.maxDrawdown}%`);
  console.log(`  Total Trades:  ${st.totalTrades}`);
  console.log(`  Win Rate:      ${st.winRate}%`);
  console.log(`  Avg Win:       €${st.avgWin}`);
  console.log(`  Avg Loss:      €${st.avgLoss}`);
  console.log(`  Avg Hold:      ${st.avgHoldDays} days`);
  console.log('───────────────────────────────────────────');
  console.log('  BY SECTOR:');
  for (const [sector, s] of Object.entries(st.sectors)) {
    console.log(`    ${sector.padEnd(14)} ${s.trades} trades | ${s.wins} wins | €${s.totalPnl.toFixed(2)}`);
  }
  console.log('═══════════════════════════════════════════\n');

  // Save detailed results
  const fs = require('fs');
  const output = {
    config: { months: TEST_MONTHS, capital: STARTING_CAP, costBps: COST_BPS, ...CONFIG },
    summary: st,
    trades: portfolio.closedTrades,
  };
  fs.writeFileSync('backtest-results.json', JSON.stringify(output, null, 2));
  console.log('Detailed results saved to backtest-results.json');
}

run().catch(e => { console.error('Backtest failed:', e); process.exit(1); });
