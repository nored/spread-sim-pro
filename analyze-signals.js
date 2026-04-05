'use strict';
// ═══════════════════════════════════════════════════════
//  analyze-signals.js — Signal Quality Analysis
//
//  Generates ALL mean-reversion signals over 12 months,
//  tracks their outcomes, then analyzes which features
//  predict winning trades. Outputs optimal filter config.
//
//  Usage: node analyze-signals.js
// ═══════════════════════════════════════════════════════

const { UNIVERSE, CONFIG, FETCH_DELAY_MS } = require('./scanner');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });
const fs = require('fs');

function ols(y, x) {
  const n=y.length; let sx=0,sy=0,sxx=0,sxy=0;
  for(let i=0;i<n;i++){sx+=x[i];sy+=y[i];sxx+=x[i]*x[i];sxy+=x[i]*y[i]}
  const d=n*sxx-sx*sx; if(Math.abs(d)<1e-12)return null;
  const b=(n*sxy-sx*sy)/d, a=(sy-b*sx)/n;
  const r=y.map((yi,i)=>yi-a-b*x[i]);
  const ym=sy/n, sst=y.reduce((a,yi)=>a+(yi-ym)**2,0), ssr=r.reduce((a,e)=>a+e*e,0);
  return {alpha:a,beta:b,residuals:r,r2:sst>0?1-ssr/sst:0};
}

function ouFit(spread) {
  const fit=ols(spread.slice(1),spread.slice(0,-1));
  if(!fit||fit.beta<=0||fit.beta>=1)return null;
  const k=-Math.log(fit.beta),hl=Math.log(2)/k,th=fit.alpha/(1-fit.beta);
  const s2=fit.residuals.reduce((s,e)=>s+e*e,0)/(fit.residuals.length-1);
  return {kappa:k,halfLife:hl,theta:th,sigma:Math.sqrt(s2*252),r2:fit.r2};
}

function hurstExponent(s) {
  const n=s.length,m=s.reduce((a,b)=>a+b,0)/n;
  let c=0,mx=-Infinity,mn=Infinity,v=0;
  for(let i=0;i<n;i++){c+=s[i]-m;if(c>mx)mx=c;if(c<mn)mn=c;v+=(s[i]-m)**2}
  const R=mx-mn,S=Math.sqrt(v/n);
  if(S<1e-10||R<=0)return 0.5;
  return Math.log(R/S)/Math.log(n);
}

async function fetchAllPrices() {
  const startDate = new Date(); startDate.setFullYear(startDate.getFullYear() - 3);
  const period1 = startDate.toISOString().split('T')[0];
  console.log(`Fetching ${UNIVERSE.length} tickers...`);
  const priceMap = {};
  let done = 0;
  for (const entry of UNIVERSE) {
    try {
      const chart = await yahooFinance.chart(entry.ticker, {
        period1, period2: new Date().toISOString().split('T')[0], interval: '1d',
      }, { validateResult: false });
      const data = (chart.quotes||[])
        .filter(q => q.date && (q.adjclose??q.close) > 0)
        .map(q => ({ date: q.date.toISOString().split('T')[0], close: q.adjclose ?? q.close }));
      if (data.length >= 120) priceMap[entry.ticker] = data;
    } catch {}
    done++;
    if (done % 10 === 0) process.stdout.write(`  ${done}/${UNIVERSE.length}\r`);
    await new Promise(r => setTimeout(r, FETCH_DELAY_MS));
  }
  console.log(`Fetched ${Object.keys(priceMap).length} tickers\n`);
  return priceMap;
}

function alignByDate(a, b) {
  const m = new Map(b.map(d => [d.date, d.close]));
  return a.filter(d => m.has(d.date)).map(d => ({ date: d.date, a: d.close, b: m.get(d.date) }));
}

// ── Generate all signals with full metadata and track outcomes ──
function generateAndTrackSignals(pairs, priceMap, testDates) {
  const signals = [];

  for (const [entryA, entryB] of pairs) {
    const aligned = alignByDate(priceMap[entryA.ticker], priceMap[entryB.ticker]);
    if (aligned.length < 300) continue;

    const testStart = aligned.findIndex(d => d.date >= testDates[0]);
    if (testStart < 120) continue;

    // Training window: 252 days before test start
    const trainStart = Math.max(0, testStart - 252);
    const trainSlice = aligned.slice(trainStart, testStart);
    const logA = trainSlice.map(d => Math.log(d.a));
    const logB = trainSlice.map(d => Math.log(d.b));
    const fit = ols(logA, logB);
    if (!fit || fit.beta <= 0) continue;

    const trainSpread = logA.map((la, i) => la - fit.beta * logB[i]);
    const ou = ouFit(trainSpread);
    if (!ou || ou.halfLife < 2 || ou.halfLife > 120) continue;
    const ouStd = ou.sigma / Math.sqrt(252 * 2 * ou.kappa);
    if (ouStd < 1e-8) continue;

    const hurst = hurstExponent(trainSpread);
    const spreadMean = trainSpread.reduce((a,b)=>a+b,0) / trainSpread.length;
    const spreadStd = Math.sqrt(trainSpread.reduce((a,b)=>a+(b-spreadMean)**2,0) / trainSpread.length);

    // Walk through test period looking for entries
    const testSlice = aligned.slice(testStart);
    let inTrade = false, entryData = null;

    for (let t = 20; t < testSlice.length; t++) {
      const spread = Math.log(testSlice[t].a) - fit.beta * Math.log(testSlice[t].b);
      const window = testSlice.slice(Math.max(0, t - 20), t + 1)
        .map(d => Math.log(d.a) - fit.beta * Math.log(d.b));
      const mean = window.reduce((a,b)=>a+b,0) / window.length;
      const std = Math.sqrt(window.reduce((a,b)=>a+(b-mean)**2,0) / window.length);
      if (std < 1e-10) continue;
      const z = (spread - mean) / std;

      if (!inTrade && Math.abs(z) >= 1.5) {
        inTrade = true;
        entryData = {
          tickerA: entryA.ticker, tickerB: entryB.ticker,
          sector: entryA.sector, sameSector: entryA.sector === entryB.sector,
          entryDate: testSlice[t].date,
          entryZ: z, absEntryZ: Math.abs(z),
          halfLife: ou.halfLife, kappa: ou.kappa, sigma: ou.sigma, theta: ou.theta,
          ouR2: ou.r2, hurst, beta: fit.beta, olsR2: fit.r2,
          spreadStd, ouStd,
          entrySpread: spread, entryIdx: t,
          spotA: testSlice[t].a, spotB: testSlice[t].b,
        };
      } else if (inTrade) {
        const age = t - entryData.entryIdx;

        // Track multiple exit strategies
        const zMovement = Math.abs(entryData.entryZ) - Math.abs(z);
        const reverted05 = Math.abs(z) <= 0.5;
        const reverted10 = Math.abs(z) <= 1.0;
        const stopped15 = Math.abs(z) >= Math.abs(entryData.entryZ) * 1.5;
        const stopped13 = Math.abs(z) >= Math.abs(entryData.entryZ) * 1.3;
        const timeout1hl = age >= ou.halfLife;
        const timeout2hl = age >= 2 * ou.halfLife;
        const timeout3hl = age >= 3 * ou.halfLife;

        const shouldExit = reverted05 || stopped15 || timeout3hl;
        if (!shouldExit) continue;

        // Compute actual P&L on a $1000 notional
        const longA = entryData.entryZ < 0;
        const notional = 1000;
        const sharesA = notional / entryData.spotA;
        const sharesB = sharesA * fit.beta * entryData.spotA / entryData.spotB;
        const pnlA = sharesA * (testSlice[t].a - entryData.spotA) * (longA ? 1 : -1);
        const pnlB = sharesB * (testSlice[t].b - entryData.spotB) * (longA ? -1 : 1);
        const pnl = pnlA + pnlB;
        const pnlPct = (pnl / notional) * 100;
        const cost = notional * 2 * 20 / 10000;  // 20bps RT

        let exitReason = 'TIMEOUT';
        if (reverted05) exitReason = 'TP_Z05';
        else if (stopped15) exitReason = 'SL_Z15';

        signals.push({
          ...entryData,
          exitDate: testSlice[t].date,
          exitZ: z, age,
          exitReason,
          pnlPct: +pnlPct.toFixed(3),
          pnlNet: +(pnl - cost).toFixed(2),
          zMovement: +zMovement.toFixed(3),
          // Feature flags for analysis
          revertedBy05: reverted05,
          revertedBy10: reverted10 || reverted05,
          stoppedBy13: stopped13,
          stoppedBy15: stopped15,
          timeoutBy1hl: timeout1hl,
          timeoutBy2hl: timeout2hl,
        });

        inTrade = false;
      }
    }
  }
  return signals;
}

// ── Analysis functions ──────────────────────────────────

function bucketAnalysis(signals, featureFn, buckets, label) {
  console.log(`\n  ${label}:`);
  for (const [name, filterFn] of buckets) {
    const subset = signals.filter(filterFn);
    if (subset.length < 5) continue;
    const wins = subset.filter(s => s.pnlPct > 0);
    const avgPnl = subset.reduce((a,s) => a + s.pnlPct, 0) / subset.length;
    const avgWin = wins.length > 0 ? wins.reduce((a,s)=>a+s.pnlPct,0)/wins.length : 0;
    const losses = subset.filter(s => s.pnlPct <= 0);
    const avgLoss = losses.length > 0 ? losses.reduce((a,s)=>a+s.pnlPct,0)/losses.length : 0;
    const wr = (wins.length / subset.length * 100).toFixed(0);
    const expectancy = (wins.length/subset.length * avgWin + losses.length/subset.length * avgLoss).toFixed(2);
    console.log(`    ${name.padEnd(22)} ${String(subset.length).padStart(5)} trades | ${wr}% win | avg ${avgPnl>=0?'+':''}${avgPnl.toFixed(2)}% | E[R]=${expectancy}% | avgW=${avgWin.toFixed(2)}% avgL=${avgLoss.toFixed(2)}%`);
  }
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a,b) => a-b);
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length-1)];
}

async function run() {
  console.log('═══════════════════════════════════════════');
  console.log('  SIGNAL QUALITY ANALYSIS');
  console.log('═══════════════════════════════════════════\n');

  const priceMap = await fetchAllPrices();
  const entries = UNIVERSE.filter(e => priceMap[e.ticker]);

  // Same-sector pairs
  const pairs = [];
  for (let i = 0; i < entries.length - 1; i++)
    for (let j = i + 1; j < entries.length; j++)
      if (entries[i].sector === entries[j].sector) pairs.push([entries[i], entries[j]]);

  const dateSet = new Set();
  for (const d of Object.values(priceMap)) for (const r of d) dateSet.add(r.date);
  const allDates = [...dateSet].sort();
  const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 12);
  const testDates = allDates.filter(d => d >= cutoff.toISOString().split('T')[0]);

  console.log(`Generating signals for ${pairs.length} pairs over ${testDates.length} days...\n`);
  const signals = generateAndTrackSignals(pairs, priceMap, testDates);

  console.log(`Total signals generated: ${signals.length}`);
  const wins = signals.filter(s => s.pnlPct > 0);
  console.log(`Win rate: ${(wins.length/signals.length*100).toFixed(1)}%`);
  console.log(`Avg P&L: ${(signals.reduce((a,s)=>a+s.pnlPct,0)/signals.length).toFixed(3)}%`);

  // ── Z-Score Entry Analysis ────────────────────────────
  bucketAnalysis(signals, s => s.absEntryZ, [
    ['z 1.5 - 2.0',    s => s.absEntryZ >= 1.5 && s.absEntryZ < 2.0],
    ['z 2.0 - 2.5',    s => s.absEntryZ >= 2.0 && s.absEntryZ < 2.5],
    ['z 2.5 - 3.0',    s => s.absEntryZ >= 2.5 && s.absEntryZ < 3.0],
    ['z 3.0 - 4.0',    s => s.absEntryZ >= 3.0 && s.absEntryZ < 4.0],
    ['z 4.0+',          s => s.absEntryZ >= 4.0],
  ], 'Z-SCORE AT ENTRY');

  // ── Half-Life Analysis ────────────────────────────────
  bucketAnalysis(signals, s => s.halfLife, [
    ['hl 2-5 days',     s => s.halfLife >= 2 && s.halfLife < 5],
    ['hl 5-10 days',    s => s.halfLife >= 5 && s.halfLife < 10],
    ['hl 10-20 days',   s => s.halfLife >= 10 && s.halfLife < 20],
    ['hl 20-40 days',   s => s.halfLife >= 20 && s.halfLife < 40],
    ['hl 40-60 days',   s => s.halfLife >= 40 && s.halfLife < 60],
    ['hl 60+ days',     s => s.halfLife >= 60],
  ], 'HALF-LIFE');

  // ── Sector Analysis ───────────────────────────────────
  const sectors = [...new Set(signals.map(s => s.sector))].sort();
  bucketAnalysis(signals, s => s.sector,
    sectors.map(sec => [sec, s => s.sector === sec]),
    'SECTOR');

  // ── OU R² Analysis ────────────────────────────────────
  bucketAnalysis(signals, s => s.ouR2, [
    ['r2 < 0.90',      s => s.ouR2 < 0.90],
    ['r2 0.90-0.95',   s => s.ouR2 >= 0.90 && s.ouR2 < 0.95],
    ['r2 0.95-0.98',   s => s.ouR2 >= 0.95 && s.ouR2 < 0.98],
    ['r2 0.98+',       s => s.ouR2 >= 0.98],
  ], 'OU MODEL FIT (R²)');

  // ── Hold Time Analysis ────────────────────────────────
  bucketAnalysis(signals, s => s.age, [
    ['hold 1-5 days',   s => s.age >= 1 && s.age <= 5],
    ['hold 5-10 days',  s => s.age > 5 && s.age <= 10],
    ['hold 10-20 days', s => s.age > 10 && s.age <= 20],
    ['hold 20-40 days', s => s.age > 20 && s.age <= 40],
    ['hold 40+ days',   s => s.age > 40],
  ], 'HOLDING PERIOD (OUTCOME)');

  // ── Exit Reason Analysis ──────────────────────────────
  bucketAnalysis(signals, s => s.exitReason, [
    ['TAKE_PROFIT',     s => s.exitReason === 'TP_Z05'],
    ['STOP_LOSS',       s => s.exitReason === 'SL_Z15'],
    ['TIMEOUT',         s => s.exitReason === 'TIMEOUT'],
  ], 'EXIT REASON');

  // ── OLS Beta Analysis ────────────────────────────────
  bucketAnalysis(signals, s => s.beta, [
    ['beta 0-0.5',      s => s.beta > 0 && s.beta < 0.5],
    ['beta 0.5-1.0',    s => s.beta >= 0.5 && s.beta < 1.0],
    ['beta 1.0-1.5',    s => s.beta >= 1.0 && s.beta < 1.5],
    ['beta 1.5-2.0',    s => s.beta >= 1.5 && s.beta < 2.0],
    ['beta 2.0+',       s => s.beta >= 2.0],
  ], 'HEDGE RATIO (BETA)');

  // ── Kappa (mean-reversion speed) ─────────────────────
  bucketAnalysis(signals, s => s.kappa, [
    ['kappa < 0.01',    s => s.kappa < 0.01],
    ['kappa 0.01-0.05', s => s.kappa >= 0.01 && s.kappa < 0.05],
    ['kappa 0.05-0.10', s => s.kappa >= 0.05 && s.kappa < 0.10],
    ['kappa 0.10-0.20', s => s.kappa >= 0.10 && s.kappa < 0.20],
    ['kappa 0.20+',     s => s.kappa >= 0.20],
  ], 'KAPPA (REVERSION SPEED)');

  // ── Composite: best signal profile ────────────────────
  console.log('\n  COMPOSITE — BEST vs WORST signal profiles:');

  const top20 = signals.filter(s => s.pnlPct >= percentile(signals.map(s=>s.pnlPct), 0.80));
  const bot20 = signals.filter(s => s.pnlPct <= percentile(signals.map(s=>s.pnlPct), 0.20));

  const avgFeature = (arr, fn) => arr.reduce((a,s) => a + fn(s), 0) / arr.length;

  console.log(`    Feature            TOP 20%         BOTTOM 20%      DELTA`);
  const features = [
    ['|z| at entry',     s => s.absEntryZ],
    ['half-life (days)', s => s.halfLife],
    ['kappa',            s => s.kappa],
    ['OU R²',            s => s.ouR2],
    ['OLS R²',           s => s.olsR2],
    ['beta',             s => s.beta],
    ['hurst',            s => s.hurst],
    ['spread std',       s => s.spreadStd],
    ['hold days',        s => s.age],
  ];
  for (const [name, fn] of features) {
    const topV = avgFeature(top20, fn);
    const botV = avgFeature(bot20, fn);
    console.log(`    ${name.padEnd(20)} ${topV.toFixed(4).padStart(12)}    ${botV.toFixed(4).padStart(12)}    ${(topV-botV>=0?'+':'') + (topV-botV).toFixed(4)}`);
  }

  // ── Generate recommended config ───────────────────────
  console.log('\n═══════════════════════════════════════════');
  console.log('  RECOMMENDED CONFIGURATION');
  console.log('═══════════════════════════════════════════');

  // Find optimal z-score: highest expectancy bucket
  const zBuckets = [1.5, 2.0, 2.5, 3.0];
  let bestZEntry = 2.0, bestZExpectancy = -Infinity;
  for (const z of zBuckets) {
    const sub = signals.filter(s => s.absEntryZ >= z);
    if (sub.length < 20) continue;
    const wr = sub.filter(s=>s.pnlPct>0).length / sub.length;
    const avgW = sub.filter(s=>s.pnlPct>0).reduce((a,s)=>a+s.pnlPct,0) / Math.max(1,sub.filter(s=>s.pnlPct>0).length);
    const avgL = sub.filter(s=>s.pnlPct<=0).reduce((a,s)=>a+s.pnlPct,0) / Math.max(1,sub.filter(s=>s.pnlPct<=0).length);
    const exp = wr * avgW + (1-wr) * avgL;
    if (exp > bestZExpectancy) { bestZExpectancy = exp; bestZEntry = z; }
  }

  // Find optimal half-life range
  const hlBuckets = [[2,10],[5,20],[10,40],[20,60],[5,60]];
  let bestHL = [5,60], bestHLExp = -Infinity;
  for (const [lo,hi] of hlBuckets) {
    const sub = signals.filter(s => s.halfLife >= lo && s.halfLife <= hi);
    if (sub.length < 20) continue;
    const exp = sub.reduce((a,s)=>a+s.pnlPct,0) / sub.length;
    if (exp > bestHLExp) { bestHLExp = exp; bestHL = [lo,hi]; }
  }

  // Best sectors
  const sectorExp = {};
  for (const s of signals) {
    if (!sectorExp[s.sector]) sectorExp[s.sector] = { sum: 0, n: 0 };
    sectorExp[s.sector].sum += s.pnlPct;
    sectorExp[s.sector].n++;
  }
  const goodSectors = Object.entries(sectorExp)
    .filter(([,v]) => v.n >= 10 && v.sum / v.n > 0)
    .sort((a,b) => b[1].sum/b[1].n - a[1].sum/a[1].n)
    .map(([k]) => k);

  console.log(`  zScoreEntry:   ${bestZEntry}  (expectancy: ${bestZExpectancy.toFixed(3)}%)`);
  console.log(`  halfLifeMin:   ${bestHL[0]}`);
  console.log(`  halfLifeMax:   ${bestHL[1]}`);
  console.log(`  goodSectors:   [${goodSectors.join(', ')}]`);
  console.log(`  total signals: ${signals.filter(s => s.absEntryZ >= bestZEntry && s.halfLife >= bestHL[0] && s.halfLife <= bestHL[1] && goodSectors.includes(s.sector)).length} (in 12 months)`);

  const filtered = signals.filter(s =>
    s.absEntryZ >= bestZEntry &&
    s.halfLife >= bestHL[0] && s.halfLife <= bestHL[1] &&
    goodSectors.includes(s.sector)
  );
  const fWins = filtered.filter(s => s.pnlPct > 0);
  console.log(`  filtered win rate: ${(fWins.length/filtered.length*100).toFixed(1)}%`);
  console.log(`  filtered avg P&L:  ${(filtered.reduce((a,s)=>a+s.pnlPct,0)/filtered.length).toFixed(3)}%`);
  console.log(`  filtered total P&L: ${filtered.reduce((a,s)=>a+s.pnlPct,0).toFixed(1)}% (sum across all trades)`);

  console.log('\n═══════════════════════════════════════════\n');

  // Save full signal data for further analysis
  fs.writeFileSync('signal-analysis.json', JSON.stringify({
    totalSignals: signals.length,
    signals: signals,
    recommended: { zScoreEntry: bestZEntry, halfLifeMin: bestHL[0], halfLifeMax: bestHL[1], goodSectors },
  }, null, 2));
  console.log('Full data saved to signal-analysis.json');
}

run().catch(e => { console.error(e); process.exit(1); });
