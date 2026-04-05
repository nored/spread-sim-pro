'use strict';
// ═══════════════════════════════════════════════════════
//  generate-report.js — Full per-trade data export
//
//  Generates every signal with daily tracking data:
//  entry features, daily z-score (both rolling and OU),
//  daily P&L, spread values, hedge drift — everything
//  needed to understand what happens inside each trade.
//
//  Output: report.json + report.csv
// ═══════════════════════════════════════════════════════

const { UNIVERSE, CONFIG, FETCH_DELAY_MS } = require('./scanner');
const { scoreSignal } = require('./scorer');
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

function rollingZ(arr, idx, w) {
  const s=Math.max(0,idx-w+1), sl=arr.slice(s,idx+1), n=sl.length;
  if(n<5)return null;
  const m=sl.reduce((a,b)=>a+b,0)/n, std=Math.sqrt(sl.reduce((a,b)=>a+(b-m)**2,0)/n);
  return std>1e-10?(arr[idx]-m)/std:null;
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
  console.log(`\nFetched ${Object.keys(priceMap).length} tickers\n`);
  return priceMap;
}

function alignByDate(a, b) {
  const m = new Map(b.map(d => [d.date, d.close]));
  return a.filter(d => m.has(d.date)).map(d => ({ date: d.date, a: d.close, b: m.get(d.date) }));
}

async function run() {
  console.log('Generating full per-trade report...\n');
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

  console.log(`Test: ${testDates[0]} → ${testDates[testDates.length-1]}`);
  console.log(`Pairs: ${pairs.length}\n`);

  const allTrades = [];
  let tradeId = 0;

  for (const [entryA, entryB] of pairs) {
    const aligned = alignByDate(priceMap[entryA.ticker], priceMap[entryB.ticker]);
    if (aligned.length < 300) continue;

    const testStart = aligned.findIndex(d => d.date >= testDates[0]);
    if (testStart < 120) continue;

    // Train
    const trainSlice = aligned.slice(Math.max(0, testStart - 252), testStart);
    const logA = trainSlice.map(d => Math.log(d.a));
    const logB = trainSlice.map(d => Math.log(d.b));
    const fit = ols(logA, logB);
    if (!fit || fit.beta <= 0) continue;
    const trainSpread = logA.map((la, i) => la - fit.beta * logB[i]);
    const ou = ouFit(trainSpread);
    if (!ou || ou.halfLife < 3 || ou.halfLife > 80) continue;
    const ouStd = ou.sigma / Math.sqrt(252 * 2 * ou.kappa);
    if (ouStd < 1e-8) continue;

    // Build full spread series
    const testSlice = aligned.slice(testStart);
    const spreads = testSlice.map(d => Math.log(d.a) - fit.beta * Math.log(d.b));

    // ML score for this pair
    const mlInput = {
      sector: entryA.sector, z_score: 0, half_life: ou.halfLife,
      ou_kappa: ou.kappa, ou_sigma: ou.sigma, ou_r2: ou.r2,
      hedge_ratio: fit.beta,
    };

    let inTrade = false, entryIdx = 0, entryData = null;

    for (let t = 20; t < testSlice.length; t++) {
      const rz = rollingZ(spreads, t, 20);
      const oz = ouStd > 1e-8 ? (spreads[t] - ou.theta) / ouStd : null;
      if (rz === null) continue;

      if (!inTrade && Math.abs(rz) >= 2.0) {
        inTrade = true;
        entryIdx = t;
        mlInput.z_score = rz;
        const ml = scoreSignal(mlInput, 'AGGRESSIVE');

        entryData = {
          tradeId: ++tradeId,
          tickerA: entryA.ticker,
          tickerB: entryB.ticker,
          sector: entryA.sector,
          entryDate: testSlice[t].date,
          entryPriceA: +testSlice[t].a.toFixed(4),
          entryPriceB: +testSlice[t].b.toFixed(4),
          beta: +fit.beta.toFixed(6),
          olsR2: +fit.r2.toFixed(4),
          halfLife: +ou.halfLife.toFixed(2),
          kappa: +ou.kappa.toFixed(6),
          sigma: +ou.sigma.toFixed(6),
          theta: +ou.theta.toFixed(6),
          ouR2: +ou.r2.toFixed(4),
          entryRollingZ: +rz.toFixed(4),
          entryOuZ: oz !== null ? +oz.toFixed(4) : null,
          entrySpread: +spreads[t].toFixed(8),
          mlScore: ml.score,
          mlGrade: ml.grade,
          mlProb: ml.probability,
          mlBreakdown: ml.breakdown,
          direction: rz > 0 ? 'SHORT_A_LONG_B' : 'LONG_A_SHORT_B',
          dailyLog: [],
        };
        continue;
      }

      if (inTrade) {
        const age = t - entryIdx;
        const longA = entryData.direction === 'LONG_A_SHORT_B';
        const notional = 1000; // standardized for comparison
        const sharesA = notional / entryData.entryPriceA;
        const sharesB = sharesA * fit.beta * entryData.entryPriceA / entryData.entryPriceB;
        const pnlA = sharesA * (testSlice[t].a - entryData.entryPriceA) * (longA ? 1 : -1);
        const pnlB = sharesB * (testSlice[t].b - entryData.entryPriceB) * (longA ? -1 : 1);
        const pnlUsd = pnlA + pnlB;
        const pnlPct = (pnlUsd / notional) * 100;

        // Compute what beta SHOULD be now (re-estimate on recent data)
        let currentBeta = fit.beta;
        if (t > 20) {
          const recentA = aligned.slice(Math.max(0, testStart + t - 20), testStart + t + 1).map(d => Math.log(d.a));
          const recentB = aligned.slice(Math.max(0, testStart + t - 20), testStart + t + 1).map(d => Math.log(d.b));
          if (recentA.length > 5) {
            const recentFit = ols(recentA, recentB);
            if (recentFit && recentFit.beta > 0) currentBeta = recentFit.beta;
          }
        }
        const betaDrift = +((currentBeta - fit.beta) / fit.beta * 100).toFixed(2);

        // Daily log entry
        entryData.dailyLog.push({
          day: age,
          date: testSlice[t].date,
          priceA: +testSlice[t].a.toFixed(4),
          priceB: +testSlice[t].b.toFixed(4),
          spread: +spreads[t].toFixed(8),
          rollingZ: +rz.toFixed(4),
          ouZ: oz !== null ? +oz.toFixed(4) : null,
          pnlUsd: +pnlUsd.toFixed(2),
          pnlPct: +pnlPct.toFixed(3),
          currentBeta: +currentBeta.toFixed(6),
          betaDriftPct: betaDrift,
        });

        // v2 exit logic — matches server.js priority order
        const stopped = Math.abs(rz) >= Math.abs(entryData.entryRollingZ) * 1.5;
        const earlyExit = age >= 3 && pnlPct < -3.0;

        // Trailing P&L stop
        entryData._maxPnl = Math.max(entryData._maxPnl || 0, pnlPct);
        const trailExit = age >= 2 && entryData._maxPnl >= 1.5 && pnlPct < entryData._maxPnl * 0.4;

        // Velocity stall
        entryData._zHist = entryData._zHist || [];
        entryData._zHist.push(rz);
        let stallExit = false;
        if (entryData._zHist.length >= 4 && age >= 3) {
          const recent = entryData._zHist.slice(-4);
          const vels = [];
          for (let k = 1; k < recent.length; k++) vels.push(Math.abs(recent[k-1]) - Math.abs(recent[k]));
          stallExit = vels.slice(-3).every(v => v < 0.05);
        }

        const reverted = Math.abs(rz) <= 0.5;
        const timeCut = age >= 20;

        const shouldExit = stopped || earlyExit || trailExit || stallExit || reverted || timeCut;
        if (shouldExit) {
          const exitReason = stopped ? 'STOP' : earlyExit ? 'EARLY_EXIT' : trailExit ? 'TRAIL_EXIT' : stallExit ? 'STALL_EXIT' : reverted ? 'REVERT' : 'TIME_CUT';
          const cost = notional * 4 * 20 / 10000;

          entryData.exitDate = testSlice[t].date;
          entryData.exitReason = exitReason;
          entryData.exitRollingZ = +rz.toFixed(4);
          entryData.exitOuZ = oz !== null ? +oz.toFixed(4) : null;
          entryData.holdDays = age;
          entryData.pnlUsd = +pnlUsd.toFixed(2);
          entryData.pnlPct = +pnlPct.toFixed(3);
          entryData.pnlAfterCost = +(pnlUsd - cost).toFixed(2);
          entryData.cost = +cost.toFixed(2);
          entryData.zReverted = Math.abs(entryData.entryRollingZ) > Math.abs(rz);
          entryData.betaDriftAtExit = betaDrift;
          entryData.maxPnlPct = +Math.max(...entryData.dailyLog.map(d => d.pnlPct)).toFixed(3);
          entryData.minPnlPct = +Math.min(...entryData.dailyLog.map(d => d.pnlPct)).toFixed(3);
          entryData.maxBetaDrift = +Math.max(...entryData.dailyLog.map(d => Math.abs(d.betaDriftPct))).toFixed(2);

          allTrades.push(entryData);
          inTrade = false;
        }
      }
    }
  }

  console.log(`\nGenerated ${allTrades.length} trades with daily tracking\n`);

  // Summary stats
  const wins = allTrades.filter(t => t.pnlAfterCost > 0);
  const losses = allTrades.filter(t => t.pnlAfterCost <= 0);
  const zRevertedButLost = allTrades.filter(t => t.zReverted && t.pnlAfterCost <= 0);

  console.log(`Win rate: ${(wins.length/allTrades.length*100).toFixed(1)}%`);
  console.log(`Z reverted but lost money: ${zRevertedButLost.length} (${(zRevertedButLost.length/allTrades.length*100).toFixed(1)}%)`);
  console.log(`Avg beta drift at exit: ${(allTrades.reduce((a,t)=>a+Math.abs(t.betaDriftAtExit),0)/allTrades.length).toFixed(2)}%`);
  console.log(`Avg max beta drift during trade: ${(allTrades.reduce((a,t)=>a+t.maxBetaDrift,0)/allTrades.length).toFixed(2)}%`);

  // Save JSON (full data with daily logs)
  fs.writeFileSync('report.json', JSON.stringify({
    generated: new Date().toISOString(),
    testPeriod: `${testDates[0]} to ${testDates[testDates.length-1]}`,
    totalTrades: allTrades.length,
    winRate: +(wins.length/allTrades.length*100).toFixed(1),
    hedgeLeakRate: +(zRevertedButLost.length/allTrades.length*100).toFixed(1),
    trades: allTrades,
  }, null, 2));

  // Save CSV (flat, without daily logs — one row per trade)
  const csvHeader = [
    'tradeId','tickerA','tickerB','sector','entryDate','exitDate','direction',
    'entryPriceA','entryPriceB','beta','olsR2','halfLife','kappa','sigma','theta','ouR2',
    'entryRollingZ','entryOuZ','exitRollingZ','exitOuZ',
    'mlScore','mlGrade','mlProb',
    'holdDays','exitReason','pnlUsd','pnlPct','pnlAfterCost','cost',
    'zReverted','betaDriftAtExit','maxBetaDrift','maxPnlPct','minPnlPct',
  ].join(',');

  const csvRows = allTrades.map(t =>
    [t.tradeId,t.tickerA,t.tickerB,t.sector,t.entryDate,t.exitDate,t.direction,
     t.entryPriceA,t.entryPriceB,t.beta,t.olsR2,t.halfLife,t.kappa,t.sigma,t.theta,t.ouR2,
     t.entryRollingZ,t.entryOuZ,t.exitRollingZ,t.exitOuZ,
     t.mlScore,t.mlGrade,t.mlProb,
     t.holdDays,t.exitReason,t.pnlUsd,t.pnlPct,t.pnlAfterCost,t.cost,
     t.zReverted?1:0,t.betaDriftAtExit,t.maxBetaDrift,t.maxPnlPct,t.minPnlPct,
    ].join(',')
  );

  fs.writeFileSync('report.csv', csvHeader + '\n' + csvRows.join('\n'));

  console.log(`\nSaved: report.json (${(fs.statSync('report.json').size/1024/1024).toFixed(1)}MB) + report.csv`);
  console.log('report.json includes daily price/z/pnl/betaDrift log per trade');
  console.log('report.csv is flat — one row per trade, all features + outcome');
}

run().catch(e => { console.error(e); process.exit(1); });
