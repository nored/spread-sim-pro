'use strict';
// ═══════════════════════════════════════════════════════
//  backtest-potential.js — Full potential analysis
//
//  Answers: "What is the MAXIMUM this system could make?"
//
//  Mode 1: Oracle — knows which trades win. Takes only winners.
//  Mode 2: Unlimited — no position cap, takes every signal, unlimited capital
//  Mode 3: Every spread — tracks every single pair spread over 2 years,
//           measures total mean-reversion profit available in the universe
//
//  This shows the ceiling. Then we work backwards from there.
// ═══════════════════════════════════════════════════════

const { UNIVERSE, CONFIG, FETCH_DELAY_MS } = require('./scanner');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

function ols(y, x) {
  const n=y.length; let sx=0,sy=0,sxx=0,sxy=0;
  for(let i=0;i<n;i++){sx+=x[i];sy+=y[i];sxx+=x[i]*x[i];sxy+=x[i]*y[i]}
  const d=n*sxx-sx*sx; if(Math.abs(d)<1e-12)return null;
  const b=(n*sxy-sx*sy)/d, a=(sy-b*sx)/n;
  const r=y.map((yi,i)=>yi-a-b*x[i]);
  return {alpha:a,beta:b,residuals:r};
}

function ouFit(spread) {
  const fit=ols(spread.slice(1),spread.slice(0,-1));
  if(!fit||fit.beta<=0||fit.beta>=1)return null;
  const k=-Math.log(fit.beta),hl=Math.log(2)/k,th=fit.alpha/(1-fit.beta);
  const s2=fit.residuals.reduce((s,e)=>s+e*e,0)/(fit.residuals.length-1);
  return {kappa:k,halfLife:hl,theta:th,sigma:Math.sqrt(s2*252)};
}

async function fetchAllPrices() {
  const startDate = new Date();
  startDate.setFullYear(startDate.getFullYear() - 3);
  const period1 = startDate.toISOString().split('T')[0];
  console.log(`Fetching ${UNIVERSE.length} tickers from ${period1}...`);
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

async function run() {
  console.log('═══════════════════════════════════════════');
  console.log('  FULL POTENTIAL ANALYSIS');
  console.log('═══════════════════════════════════════════\n');

  const priceMap = await fetchAllPrices();
  const entries = UNIVERSE.filter(e => priceMap[e.ticker]);

  // Build same-sector pairs
  const pairs = [];
  for (let i = 0; i < entries.length - 1; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[i].sector === entries[j].sector)
        pairs.push([entries[i], entries[j]]);
    }
  }
  console.log(`Analyzing ${pairs.length} same-sector pairs...\n`);

  // Test period: last 12 months
  const dateSet = new Set();
  for (const d of Object.values(priceMap)) for (const r of d) dateSet.add(r.date);
  const allDates = [...dateSet].sort();
  const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 12);
  const testDates = allDates.filter(d => d >= cutoff.toISOString().split('T')[0]);

  console.log(`Test: ${testDates[0]} → ${testDates[testDates.length-1]} (${testDates.length} days)\n`);

  // For every pair: compute the spread, find every z > 2 entry, track if it reverts
  const allTrades = [];
  let entryData = null;
  let totalOpportunities = 0;
  let totalWins = 0;
  let totalProfitPct = 0;
  let totalLossPct = 0;
  let bestTrade = { pct: 0, pair: '' };
  let worstTrade = { pct: 0, pair: '' };
  const sectorStats = {};

  for (const [entryA, entryB] of pairs) {
    const aligned = alignByDate(priceMap[entryA.ticker], priceMap[entryB.ticker]);
    if (aligned.length < 252) continue;

    // Use first 252 points as training, rest as test
    const trainEnd = aligned.length - testDates.length;
    if (trainEnd < 120) continue;

    const trainSlice = aligned.slice(Math.max(0, trainEnd - 252), trainEnd);
    const logA = trainSlice.map(d => Math.log(d.a));
    const logB = trainSlice.map(d => Math.log(d.b));
    const fit = ols(logA, logB);
    if (!fit || fit.beta <= 0) continue;

    const trainSpread = logA.map((la, i) => la - fit.beta * logB[i]);
    const ou = ouFit(trainSpread);
    if (!ou || ou.halfLife < 3 || ou.halfLife > 80) continue;
    const ouStd = ou.sigma / Math.sqrt(252 * 2 * ou.kappa);
    if (ouStd < 1e-8) continue;

    // Now walk through test period
    const testSlice = aligned.slice(trainEnd);
    let inTrade = false;
    let entryZ = 0, entrySpread = 0, entryIdx = 0;

    for (let t = 20; t < testSlice.length; t++) {
      const spread = Math.log(testSlice[t].a) - fit.beta * Math.log(testSlice[t].b);
      // Rolling z-score using last 20 points
      const window = testSlice.slice(Math.max(0, t - 20), t + 1).map(d => Math.log(d.a) - fit.beta * Math.log(d.b));
      const mean = window.reduce((a,b) => a+b, 0) / window.length;
      const std = Math.sqrt(window.reduce((a,b) => a+(b-mean)**2, 0) / window.length);
      if (std < 1e-10) continue;
      const z = (spread - mean) / std;

      if (!inTrade && Math.abs(z) >= 2.0) {
        inTrade = true;
        entryZ = z;
        entrySpread = spread;
        entryIdx = t;
        // Also compute actual dollar P&L at entry for comparison
        entryData = {
          tickerA: entryA.ticker, tickerB: entryB.ticker, sector: entryA.sector,
          entryDate: testSlice[t].date, entryPriceA: testSlice[t].a, entryPriceB: testSlice[t].b,
          beta: fit.beta, halfLife: ou.halfLife, kappa: ou.kappa, sigma: ou.sigma, ouR2: ou.r2,
          entryZ: z, entrySpread: spread,
        };
      } else if (inTrade) {
        const age = t - entryIdx;
        const reverted = Math.abs(z) <= 0.5;
        const stopped = Math.abs(z) >= Math.abs(entryZ) * 1.5;
        const timeout = age >= 3 * ou.halfLife;

        if (reverted || stopped || timeout) {
          totalOpportunities++;
          // Z-score P&L (what potential measures)
          const pnlZ = Math.abs(entryZ) - Math.abs(z);
          const pnlPctZ = pnlZ * ouStd / Math.abs(entrySpread) * 100;

          // Actual dollar P&L on fixed shares (what backtest measures)
          const notional = 1000;
          const longA = entryZ < 0;
          const sharesA = notional / entryData.entryPriceA;
          const sharesB = sharesA * fit.beta * entryData.entryPriceA / entryData.entryPriceB;
          const dollarPnlA = sharesA * (testSlice[t].a - entryData.entryPriceA) * (longA ? 1 : -1);
          const dollarPnlB = sharesB * (testSlice[t].b - entryData.entryPriceB) * (longA ? -1 : 1);
          const dollarPnl = dollarPnlA + dollarPnlB;
          const dollarPnlPct = (dollarPnl / notional) * 100;
          const cost = notional * 4 * 20 / 10000;

          const exitReason = reverted ? 'REVERT' : stopped ? 'STOP' : 'TIMEOUT';
          const win = pnlPctZ > 0;

          if (win) { totalWins++; totalProfitPct += pnlPctZ; }
          else { totalLossPct += Math.abs(pnlPctZ); }

          if (pnlPctZ > bestTrade.pct) bestTrade = { pct: pnlPctZ, pair: `${entryA.ticker}/${entryB.ticker}`, z: entryZ, age };
          if (pnlPctZ < worstTrade.pct) worstTrade = { pct: pnlPctZ, pair: `${entryA.ticker}/${entryB.ticker}`, z: entryZ, age };

          const sector = entryA.sector;
          if (!sectorStats[sector]) sectorStats[sector] = { trades: 0, wins: 0, totalPct: 0 };
          sectorStats[sector].trades++;
          if (win) sectorStats[sector].wins++;
          sectorStats[sector].totalPct += pnlPctZ;

          // Save per-trade data
          allTrades.push({
            tickerA: entryData.tickerA, tickerB: entryData.tickerB, sector: entryData.sector,
            entryDate: entryData.entryDate, exitDate: testSlice[t].date,
            entryPriceA: +entryData.entryPriceA.toFixed(4), entryPriceB: +entryData.entryPriceB.toFixed(4),
            exitPriceA: +testSlice[t].a.toFixed(4), exitPriceB: +testSlice[t].b.toFixed(4),
            beta: +fit.beta.toFixed(6), halfLife: +ou.halfLife.toFixed(2),
            kappa: +ou.kappa.toFixed(6), sigma: +ou.sigma.toFixed(6), ouR2: +(ou.r2 || 0).toFixed(4),
            entryZ: +entryZ.toFixed(4), exitZ: +z.toFixed(4), holdDays: age,
            exitReason,
            zPnlPct: +pnlPctZ.toFixed(3),
            dollarPnlPct: +dollarPnlPct.toFixed(3),
            dollarPnlAfterCost: +(dollarPnl - cost).toFixed(2),
            zWin: pnlPctZ > 0 ? 1 : 0,
            dollarWin: dollarPnl - cost > 0 ? 1 : 0,
            gap: +(pnlPctZ - dollarPnlPct).toFixed(3),
          });

          inTrade = false;
        }
      }
    }
  }

  // Results
  console.log('═══════════════════════════════════════════');
  console.log('  TOTAL MEAN-REVERSION POTENTIAL (12 months)');
  console.log('═══════════════════════════════════════════');
  console.log(`  Total opportunities:  ${totalOpportunities}`);
  console.log(`  Winning trades:       ${totalWins} (${totalOpportunities>0?(totalWins/totalOpportunities*100).toFixed(1):0}%)`);
  console.log(`  Gross profit (sum %): ${totalProfitPct.toFixed(1)}%`);
  console.log(`  Gross loss (sum %):   ${totalLossPct.toFixed(1)}%`);
  console.log(`  Net edge (sum %):     ${(totalProfitPct - totalLossPct).toFixed(1)}%`);
  console.log(`  Avg win:              ${totalWins>0?(totalProfitPct/totalWins).toFixed(2):0}%`);
  console.log(`  Avg loss:             ${(totalOpportunities-totalWins)>0?(-totalLossPct/(totalOpportunities-totalWins)).toFixed(2):0}%`);
  console.log(`  Best trade:           ${bestTrade.pair} +${bestTrade.pct.toFixed(2)}% (z=${bestTrade.z?.toFixed(1)}, ${bestTrade.age}d)`);
  console.log(`  Worst trade:          ${worstTrade.pair} ${worstTrade.pct.toFixed(2)}% (z=${worstTrade.z?.toFixed(1)}, ${worstTrade.age}d)`);

  console.log('\n  PER SECTOR:');
  const sorted = Object.entries(sectorStats).sort((a,b) => b[1].totalPct - a[1].totalPct);
  for (const [sector, s] of sorted) {
    const wr = s.trades > 0 ? (s.wins/s.trades*100).toFixed(0) : 0;
    console.log(`    ${sector.padEnd(14)} ${String(s.trades).padStart(4)} trades | ${wr}% win | net ${s.totalPct>=0?'+':''}${s.totalPct.toFixed(1)}%`);
  }

  // What this means for €5000
  const netPct = totalProfitPct - totalLossPct;
  console.log('\n  WHAT THIS MEANS:');
  console.log(`  If you could take EVERY opportunity with €5000:`);
  for (const lev of [1, 3, 5, 10]) {
    const perTrade = 5000 * 0.06 * lev;
    const totalPnl = totalOpportunities > 0 ? netPct / 100 * perTrade * totalOpportunities / totalOpportunities : 0;
    // Actually: sum of (perTrade * individual_pct/100) for each trade
    const grossProfit = totalProfitPct / 100 * perTrade;
    const grossLoss = totalLossPct / 100 * perTrade;
    const net = grossProfit - grossLoss;
    const costs = totalOpportunities * perTrade * 2 * 20 / 10000;  // 20bps RT
    console.log(`    ${lev}x leverage: gross +€${grossProfit.toFixed(0)} / -€${grossLoss.toFixed(0)} = net €${(net-costs).toFixed(0)} (after €${costs.toFixed(0)} costs)`);
  }

  console.log('═══════════════════════════════════════════\n');

  // Save per-trade CSV with both z-score P&L and dollar P&L
  const fs = require('fs');
  const csvHeader = 'tickerA,tickerB,sector,entryDate,exitDate,entryPriceA,entryPriceB,exitPriceA,exitPriceB,beta,halfLife,kappa,sigma,ouR2,entryZ,exitZ,holdDays,exitReason,zPnlPct,dollarPnlPct,dollarPnlAfterCost,zWin,dollarWin,gap';
  const csvRows = allTrades.map(t => [
    t.tickerA,t.tickerB,t.sector,t.entryDate,t.exitDate,
    t.entryPriceA,t.entryPriceB,t.exitPriceA,t.exitPriceB,
    t.beta,t.halfLife,t.kappa,t.sigma,t.ouR2,
    t.entryZ,t.exitZ,t.holdDays,t.exitReason,
    t.zPnlPct,t.dollarPnlPct,t.dollarPnlAfterCost,
    t.zWin,t.dollarWin,t.gap
  ].join(','));
  fs.writeFileSync('potential-trades.csv', csvHeader + '\n' + csvRows.join('\n'));

  // Summary comparison
  const zWins = allTrades.filter(t => t.zWin).length;
  const dollarWins = allTrades.filter(t => t.dollarWin).length;
  const bothWin = allTrades.filter(t => t.zWin && t.dollarWin).length;
  const zWinDollarLose = allTrades.filter(t => t.zWin && !t.dollarWin).length;
  console.log(`Saved potential-trades.csv: ${allTrades.length} trades`);
  console.log(`  Z-score wins: ${zWins} (${(zWins/allTrades.length*100).toFixed(1)}%)`);
  console.log(`  Dollar wins:  ${dollarWins} (${(dollarWins/allTrades.length*100).toFixed(1)}%)`);
  console.log(`  Z win + dollar win:  ${bothWin}`);
  console.log(`  Z win + dollar LOSE: ${zWinDollarLose} ← THE GAP`);
  console.log(`  Avg gap (zPnl - dollarPnl): ${(allTrades.reduce((a,t)=>a+t.gap,0)/allTrades.length).toFixed(3)}%`);
}

run().catch(e => { console.error(e); process.exit(1); });
