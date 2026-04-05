'use strict';
// ═══════════════════════════════════════════════════════
//  analyze-gap.js — Bridge analysis between potential and backtest
//
//  The potential analysis sees 97% win rate. The backtest sees 53%.
//  This script finds EXACTLY where the signal breaks by testing
//  every combination of:
//    - Entry method: rolling z vs OU z
//    - Exit method: rolling z revert, OU z revert, time-based, hybrid
//    - Z thresholds: entry 1.5/2.0/2.5, TP 0.3/0.5/1.0, SL 1.3x/1.5x/2.0x
//    - Time limits: 5/10/15/20/30 days
//
//  Output: which combination captures the most edge
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

// Rolling z-score: simple mean/std over last N bars
function rollingZ(spreads, idx, window) {
  const start = Math.max(0, idx - window + 1);
  const slice = spreads.slice(start, idx + 1);
  const n = slice.length;
  if (n < 5) return null;
  const mean = slice.reduce((a,b)=>a+b,0) / n;
  const std = Math.sqrt(slice.reduce((a,b)=>a+(b-mean)**2,0) / n);
  if (std < 1e-10) return null;
  return (spreads[idx] - mean) / std;
}

// OU model z-score: (spread - theta) / ouStd
function ouZ(spread, ou) {
  const ouStd = ou.sigma / Math.sqrt(252 * 2 * ou.kappa);
  if (ouStd < 1e-8) return null;
  return (spread - ou.theta) / ouStd;
}

async function run() {
  console.log('═══════════════════════════════════════════');
  console.log('  GAP ANALYSIS: potential vs backtest');
  console.log('═══════════════════════════════════════════\n');

  const priceMap = await fetchAllPrices();
  const entries = UNIVERSE.filter(e => priceMap[e.ticker]);
  const pairs = [];
  for (let i = 0; i < entries.length - 1; i++)
    for (let j = i + 1; j < entries.length; j++)
      if (entries[i].sector === entries[j].sector) pairs.push([entries[i], entries[j]]);

  const dateSet = new Set();
  for (const d of Object.values(priceMap)) for (const r of d) dateSet.add(r.date);
  const allDates = [...dateSet].sort();
  const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 12);
  const testDates = allDates.filter(d => d >= cutoff.toISOString().split('T')[0]);

  console.log(`Test: ${testDates[0]} → ${testDates[testDates.length-1]} (${testDates.length} days)`);
  console.log(`Pairs: ${pairs.length}\n`);

  // Strategy configurations to test
  const strategies = [
    // Entry method, exit method, entry_z, tp_z, sl_mult, max_days, label
    { entry: 'rolling', exit: 'rolling', ez: 2.0, tp: 0.5, sl: 1.5, maxD: 999, label: 'POTENTIAL (rolling z, no time limit)' },
    { entry: 'rolling', exit: 'rolling', ez: 2.0, tp: 0.5, sl: 1.5, maxD: 10,  label: 'Rolling z + 10d cap' },
    { entry: 'rolling', exit: 'rolling', ez: 2.0, tp: 0.5, sl: 1.5, maxD: 20,  label: 'Rolling z + 20d cap' },
    { entry: 'rolling', exit: 'rolling', ez: 2.5, tp: 0.5, sl: 1.5, maxD: 10,  label: 'Rolling z>=2.5 + 10d cap' },
    { entry: 'rolling', exit: 'rolling', ez: 2.0, tp: 1.0, sl: 1.5, maxD: 10,  label: 'Rolling z, TP@1.0 + 10d' },
    { entry: 'rolling', exit: 'rolling', ez: 2.0, tp: 0.5, sl: 1.3, maxD: 10,  label: 'Rolling z, SL@1.3x + 10d' },
    { entry: 'ou',      exit: 'ou',      ez: 2.0, tp: 0.5, sl: 1.5, maxD: 999, label: 'OU z entry+exit (no time limit)' },
    { entry: 'ou',      exit: 'ou',      ez: 2.0, tp: 0.5, sl: 1.5, maxD: 10,  label: 'OU z + 10d cap (current backtest)' },
    { entry: 'rolling', exit: 'ou',      ez: 2.0, tp: 0.5, sl: 1.5, maxD: 10,  label: 'Entry: rolling, Exit: OU + 10d' },
    { entry: 'ou',      exit: 'rolling', ez: 2.0, tp: 0.5, sl: 1.5, maxD: 10,  label: 'Entry: OU, Exit: rolling + 10d' },
    { entry: 'rolling', exit: 'pnl',     ez: 2.0, tp: 1.5, sl: 2.0, maxD: 10,  label: 'Rolling entry, P&L% exit (1.5%TP -2%SL) 10d' },
    { entry: 'rolling', exit: 'pnl',     ez: 2.0, tp: 1.0, sl: 1.5, maxD: 10,  label: 'Rolling entry, P&L% exit (1%TP -1.5%SL) 10d' },
    { entry: 'rolling', exit: 'pnl',     ez: 2.0, tp: 2.0, sl: 1.0, maxD: 5,   label: 'Rolling entry, P&L% exit (2%TP -1%SL) 5d' },
  ];

  // Run all strategies
  for (const strat of strategies) {
    let trades = 0, wins = 0, totalPnlPct = 0;

    for (const [entryA, entryB] of pairs) {
      const aligned = alignByDate(priceMap[entryA.ticker], priceMap[entryB.ticker]);
      if (aligned.length < 300) continue;

      const testStart = aligned.findIndex(d => d.date >= testDates[0]);
      if (testStart < 120) continue;

      // Train OU model on pre-test data
      const trainSlice = aligned.slice(Math.max(0, testStart - 252), testStart);
      const logA = trainSlice.map(d => Math.log(d.a));
      const logB = trainSlice.map(d => Math.log(d.b));
      const fit = ols(logA, logB);
      if (!fit || fit.beta <= 0) continue;
      const trainSpread = logA.map((la, i) => la - fit.beta * logB[i]);
      const ou = ouFit(trainSpread);
      if (!ou || ou.halfLife < 3 || ou.halfLife > 80) continue;

      // Build full spread series for test period
      const testSlice = aligned.slice(testStart);
      const spreads = testSlice.map(d => Math.log(d.a) - fit.beta * Math.log(d.b));

      let inTrade = false, entryIdx = 0, entryZVal = 0, entryPrice = 0;

      for (let t = 20; t < testSlice.length; t++) {
        // Compute both z-scores
        const rz = rollingZ(spreads, t, 20);
        const oz = ouZ(spreads[t], ou);
        if (rz === null) continue;

        const entryZ = strat.entry === 'rolling' ? rz : oz;
        const exitZ  = strat.exit === 'rolling' ? rz : (strat.exit === 'ou' ? oz : null);

        if (!inTrade && entryZ !== null && Math.abs(entryZ) >= strat.ez) {
          inTrade = true;
          entryIdx = t;
          entryZVal = entryZ;
          entryPrice = spreads[t];
          continue;
        }

        if (inTrade) {
          const age = t - entryIdx;
          let exit = false;

          if (strat.exit === 'pnl') {
            // P&L-based exit
            const pnlPct = Math.abs(entryPrice) > 1e-10
              ? ((entryZVal > 0 ? -1 : 1) * (spreads[t] - entryPrice) / Math.abs(entryPrice)) * 100
              : 0;
            if (pnlPct >= strat.tp) exit = true;        // TP hit
            else if (pnlPct <= -strat.sl) exit = true;  // SL hit
            else if (age >= strat.maxD) exit = true;     // time cut

            if (exit) {
              trades++;
              if (pnlPct > 0) wins++;
              totalPnlPct += pnlPct;
            }
          } else {
            // Z-based exit
            if (exitZ !== null && Math.abs(exitZ) <= strat.tp) exit = true;
            else if (exitZ !== null && Math.abs(exitZ) >= Math.abs(entryZVal) * strat.sl) exit = true;
            else if (age >= strat.maxD) exit = true;

            if (exit) {
              const zMove = Math.abs(entryZVal) - Math.abs(exitZ || entryZVal);
              trades++;
              if (zMove > 0) wins++;
              totalPnlPct += zMove;
            }
          }

          if (exit) inTrade = false;
        }
      }
    }

    // Output
    const wr = trades > 0 ? (wins / trades * 100).toFixed(1) : '0';
    const avgPnl = trades > 0 ? (totalPnlPct / trades).toFixed(3) : '0';
    console.log(
      `${strat.label.padEnd(50)} | ${String(trades).padStart(5)} trades | ${wr.padStart(5)}% win | avg ${avgPnl.padStart(7)} | total ${totalPnlPct.toFixed(0).padStart(7)}`
    );
  }

  console.log('\n═══════════════════════════════════════════\n');
}

run().catch(e => { console.error(e); process.exit(1); });
