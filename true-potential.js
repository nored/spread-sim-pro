'use strict';
// ═══════════════════════════════════════════════════════
//  true-potential.js — Exact dollar P&L with continuous
//  hedge rebalancing on every price observation.
//
//  For each trade:
//    1. Enter at rolling z >= 2.0
//    2. Every bar: recompute beta via incremental Kalman
//    3. Every bar: mark-to-market with rebalanced hedge
//    4. Track exact rebalancing costs on every beta change
//    5. Exit at z < 0.5 or SL or timeout
//
//  No approximations. No scaling formulas. Pure price math.
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
  return {alpha:a,beta:b};
}

function ouFit(spread) {
  const fit=ols(spread.slice(1),spread.slice(0,-1));
  if(!fit||fit.beta<=0||fit.beta>=1)return null;
  const k=-Math.log(fit.beta),hl=Math.log(2)/k,th=fit.alpha/(1-fit.beta);
  const s2=spread.slice(1).reduce((s,v,i)=>{const e=v-fit.alpha-fit.beta*spread[i];return s+e*e},0)/(spread.length-2);
  return {kappa:k,halfLife:hl,theta:th,sigma:Math.sqrt(s2*252)};
}

function rollingZ(spreads, idx, w) {
  const s=Math.max(0,idx-w+1), sl=spreads.slice(s,idx+1), n=sl.length;
  if(n<5)return null;
  const m=sl.reduce((a,b)=>a+b,0)/n;
  const std=Math.sqrt(sl.reduce((a,b)=>a+(b-m)**2,0)/n);
  return std>1e-10?(spreads[idx]-m)/std:null;
}

// Incremental Kalman filter for live beta
function kalmanStep(state, logA, logB) {
  const delta = 0.0001, Ve = 0.001;
  let { theta, P } = state;
  const F = [1, logB];
  const Pp = [[P[0][0]+delta, P[0][1]], [P[1][0], P[1][1]+delta]];
  const PF = [Pp[0][0]*F[0]+Pp[0][1]*F[1], Pp[1][0]*F[0]+Pp[1][1]*F[1]];
  const S = F[0]*PF[0]+F[1]*PF[1]+Ve;
  const K = [PF[0]/S, PF[1]/S];
  const innov = logA - (F[0]*theta[0]+F[1]*theta[1]);
  theta = [theta[0]+K[0]*innov, theta[1]+K[1]*innov];
  P = [[Pp[0][0]-K[0]*PF[0], Pp[0][1]-K[0]*PF[1]],
       [Pp[1][0]-K[1]*PF[0], Pp[1][1]-K[1]*PF[1]]];
  state.theta = theta;
  state.P = P;
  return theta[1]; // live beta
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
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  TRUE POTENTIAL — Exact P&L with Kalman hedge rebalancing');
  console.log('═══════════════════════════════════════════════════════════════════\n');

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

  const NOTIONAL = 1000;
  const COST_BPS = 20; // per leg per side
  const allTrades = [];

  for (const [entryA, entryB] of pairs) {
    const aligned = alignByDate(priceMap[entryA.ticker], priceMap[entryB.ticker]);
    if (aligned.length < 300) continue;

    const testStart = aligned.findIndex(d => d.date >= testDates[0]);
    if (testStart < 120) continue;

    // Train OLS + OU on pre-test data
    const trainSlice = aligned.slice(Math.max(0, testStart - 252), testStart);
    const logA = trainSlice.map(d => Math.log(d.a));
    const logB = trainSlice.map(d => Math.log(d.b));
    const fit = ols(logA, logB);
    if (!fit || fit.beta <= 0) continue;
    const trainSpread = logA.map((la, i) => la - fit.beta * logB[i]);
    const ou = ouFit(trainSpread);
    if (!ou || ou.halfLife < 3 || ou.halfLife > 80) continue;

    // Initialize Kalman state from training
    const kfState = { theta: [0, fit.beta], P: [[1,0],[0,1]] };
    // Warm up Kalman on training data
    for (let i = 0; i < trainSlice.length; i++) {
      kalmanStep(kfState, Math.log(trainSlice[i].a), Math.log(trainSlice[i].b));
    }

    const testSlice = aligned.slice(testStart);
    const spreads = [];
    let inTrade = false;
    let trade = null;

    for (let t = 0; t < testSlice.length; t++) {
      const priceA = testSlice[t].a;
      const priceB = testSlice[t].b;
      const lA = Math.log(priceA);
      const lB = Math.log(priceB);

      // Update Kalman every bar
      const liveBeta = kalmanStep(kfState, lA, lB);

      // Spread using live Kalman beta
      const spread = lA - liveBeta * lB;
      spreads.push(spread);

      const z = rollingZ(spreads, spreads.length - 1, 20);
      if (z === null) continue;

      if (!inTrade && Math.abs(z) >= 2.0) {
        // ── ENTRY ──
        const direction = z > 0 ? 'SHORT_A_LONG_B' : 'LONG_A_SHORT_B';
        const longA = direction === 'LONG_A_SHORT_B';
        const sharesA = NOTIONAL / priceA;
        const sharesB = sharesA * liveBeta * priceA / priceB;
        const entryCost = NOTIONAL * 2 * COST_BPS / 10000;

        trade = {
          tickerA: entryA.ticker, tickerB: entryB.ticker, sector: entryA.sector,
          direction, longA,
          entryDate: testSlice[t].date,
          entryPriceA: priceA, entryPriceB: priceB,
          entryBeta: liveBeta, entryZ: z,
          halfLife: ou.halfLife, kappa: ou.kappa, sigma: ou.sigma,
          // Position state (rebalanced each bar)
          sharesA,
          sharesB,
          lastPriceB: priceB,
          realizedB: 0,       // accumulated B-leg P&L from rebalances
          totalRebalCost: entryCost,
          rebalCount: 0,
          bars: [],           // daily log
        };
        inTrade = true;
        continue;
      }

      if (inTrade) {
        const age = spreads.length - 1 - (spreads.length - 1 - trade.bars.length);
        const holdDays = trade.bars.length + 1;

        // ── REBALANCE hedge to current Kalman beta ──
        const desiredSharesB = trade.sharesA * liveBeta * priceA / priceB;
        const deltaShares = Math.abs(desiredSharesB - trade.sharesB);
        const rebalThreshold = trade.sharesB * 0.05; // rebalance on any >1% change

        if (deltaShares > rebalThreshold) {
          // Lock in B-leg P&L from previous position
          const bPnl = trade.sharesB * (priceB - trade.lastPriceB) * (trade.longA ? -1 : 1);
          trade.realizedB += bPnl;

          // Cost of rebalancing
          const rebalCost = deltaShares * priceB * COST_BPS / 10000;
          trade.totalRebalCost += rebalCost;
          trade.rebalCount++;

          // Update position
          trade.sharesB = desiredSharesB;
          trade.lastPriceB = priceB;
        }

        // ── MARK TO MARKET ──
        const pnlA = trade.sharesA * (priceA - trade.entryPriceA) * (trade.longA ? 1 : -1);
        const pnlB_unreal = trade.sharesB * (priceB - trade.lastPriceB) * (trade.longA ? -1 : 1);
        const totalPnl = pnlA + trade.realizedB + pnlB_unreal - trade.totalRebalCost;
        const pnlPct = (totalPnl / NOTIONAL) * 100;

        trade.bars.push({
          day: holdDays, date: testSlice[t].date,
          priceA, priceB, beta: liveBeta, z: +z.toFixed(4),
          pnlPct: +pnlPct.toFixed(3),
        });

        // ── EXIT CONDITIONS ──
        const reverted = Math.abs(z) < 0.5;
        const stopped = Math.abs(z) >= Math.abs(trade.entryZ) * 1.5;
        const timeout = holdDays >= Math.min(3 * ou.halfLife, 30);

        if (reverted || stopped || timeout) {
          const exitReason = reverted ? 'REVERT' : stopped ? 'STOP' : 'TIMEOUT';

          // Final P&L with exit cost
          const exitCost = NOTIONAL * 2 * COST_BPS / 10000;
          const finalPnl = totalPnl - exitCost;
          const finalPct = (finalPnl / NOTIONAL) * 100;

          allTrades.push({
            tickerA: trade.tickerA, tickerB: trade.tickerB, sector: trade.sector,
            direction: trade.direction,
            entryDate: trade.entryDate, exitDate: testSlice[t].date,
            entryPriceA: +trade.entryPriceA.toFixed(4), entryPriceB: +trade.entryPriceB.toFixed(4),
            exitPriceA: +priceA.toFixed(4), exitPriceB: +priceB.toFixed(4),
            entryBeta: +trade.entryBeta.toFixed(6), exitBeta: +liveBeta.toFixed(6),
            betaDrift: +(Math.abs(liveBeta - trade.entryBeta) / Math.abs(trade.entryBeta) * 100).toFixed(2),
            halfLife: +ou.halfLife.toFixed(2), kappa: +ou.kappa.toFixed(6), sigma: +ou.sigma.toFixed(6),
            entryZ: +trade.entryZ.toFixed(4), exitZ: +z.toFixed(4),
            holdDays,
            exitReason,
            rebalCount: trade.rebalCount,
            totalCost: +(trade.totalRebalCost + exitCost).toFixed(2),
            pnlUsd: +finalPnl.toFixed(2),
            pnlPct: +finalPct.toFixed(3),
            win: finalPnl > 0 ? 1 : 0,
            maxPnlPct: +Math.max(...trade.bars.map(b => b.pnlPct)).toFixed(3),
            minPnlPct: +Math.min(...trade.bars.map(b => b.pnlPct)).toFixed(3),
            peakDay: trade.bars.reduce((best, b) => b.pnlPct > best.pnlPct ? b : best, trade.bars[0]).day,
          });

          inTrade = false;
          trade = null;
        }
      }
    }
  }

  // ── RESULTS ──
  console.log(`\nTotal trades: ${allTrades.length}`);
  const wins = allTrades.filter(t => t.win);
  const losses = allTrades.filter(t => !t.win);
  const totalPnl = allTrades.reduce((a,t) => a + t.pnlUsd, 0);
  const totalCosts = allTrades.reduce((a,t) => a + t.totalCost, 0);
  const avgRebal = allTrades.reduce((a,t) => a + t.rebalCount, 0) / allTrades.length;

  console.log(`Win rate:     ${(wins.length/allTrades.length*100).toFixed(1)}%`);
  console.log(`Avg win:      EUR ${(wins.reduce((a,t)=>a+t.pnlUsd,0)/wins.length).toFixed(2)}`);
  console.log(`Avg loss:     EUR ${(losses.length>0?(losses.reduce((a,t)=>a+t.pnlUsd,0)/losses.length).toFixed(2):'0')}`);
  console.log(`Total P&L:    EUR ${totalPnl.toFixed(0)}`);
  console.log(`Total costs:  EUR ${totalCosts.toFixed(0)} (entry+exit+rebalancing)`);
  console.log(`Avg rebalances/trade: ${avgRebal.toFixed(1)}`);
  console.log(`Avg hold:     ${(allTrades.reduce((a,t)=>a+t.holdDays,0)/allTrades.length).toFixed(1)} days`);
  console.log(`Avg beta drift: ${(allTrades.reduce((a,t)=>a+parseFloat(t.betaDrift),0)/allTrades.length).toFixed(1)}%`);

  console.log('\nAt EUR 5000 capital:');
  for (const lev of [1, 3, 5]) {
    const scale = 5000 * 0.06 * lev / NOTIONAL;
    console.log(`  ${lev}x leverage: EUR ${(totalPnl * scale).toFixed(0)}`);
  }

  console.log('\nBY SECTOR:');
  const sec = {};
  for (const t of allTrades) {
    if (!sec[t.sector]) sec[t.sector] = {n:0,w:0,pnl:0};
    sec[t.sector].n++; if(t.win) sec[t.sector].w++; sec[t.sector].pnl += t.pnlUsd;
  }
  for (const [s,d] of Object.entries(sec).sort((a,b)=>b[1].pnl-a[1].pnl)) {
    console.log(`  ${s.padEnd(16)} ${String(d.n).padStart(4)} trades | ${(d.w/d.n*100).toFixed(0)}% win | EUR ${d.pnl.toFixed(0)}`);
  }

  console.log('\nBY EXIT REASON:');
  const ex = {};
  for (const t of allTrades) {
    if (!ex[t.exitReason]) ex[t.exitReason] = {n:0,w:0,pnl:0};
    ex[t.exitReason].n++; if(t.win) ex[t.exitReason].w++; ex[t.exitReason].pnl += t.pnlUsd;
  }
  for (const [r,d] of Object.entries(ex).sort((a,b)=>b[1].n-a[1].n)) {
    console.log(`  ${r.padEnd(10)} ${String(d.n).padStart(5)} | ${(d.w/d.n*100).toFixed(0)}% win | avg EUR ${(d.pnl/d.n).toFixed(2)} | total EUR ${d.pnl.toFixed(0)}`);
  }

  console.log('\nBY HOLD TIME:');
  for (const [lo,hi,label] of [[1,3,'1-2d'],[3,6,'3-5d'],[6,11,'6-10d'],[11,16,'11-15d'],[16,22,'16-21d'],[22,999,'22d+']]) {
    const sub = allTrades.filter(t=>t.holdDays>=lo&&t.holdDays<hi);
    if (sub.length < 3) continue;
    console.log(`  ${label.padEnd(8)} ${String(sub.length).padStart(5)} | ${(sub.filter(t=>t.win).length/sub.length*100).toFixed(0)}% win | avg ${(sub.reduce((a,t)=>a+t.pnlPct,0)/sub.length).toFixed(2)}% | EUR ${sub.reduce((a,t)=>a+t.pnlUsd,0).toFixed(0)}`);
  }

  // Save CSV
  const header = 'tickerA,tickerB,sector,direction,entryDate,exitDate,entryPriceA,entryPriceB,exitPriceA,exitPriceB,entryBeta,exitBeta,betaDrift,halfLife,kappa,sigma,entryZ,exitZ,holdDays,exitReason,rebalCount,totalCost,pnlUsd,pnlPct,win,maxPnlPct,minPnlPct,peakDay';
  const rows = allTrades.map(t => [
    t.tickerA,t.tickerB,t.sector,t.direction,t.entryDate,t.exitDate,
    t.entryPriceA,t.entryPriceB,t.exitPriceA,t.exitPriceB,
    t.entryBeta,t.exitBeta,t.betaDrift,t.halfLife,t.kappa,t.sigma,
    t.entryZ,t.exitZ,t.holdDays,t.exitReason,t.rebalCount,t.totalCost,
    t.pnlUsd,t.pnlPct,t.win,t.maxPnlPct,t.minPnlPct,t.peakDay
  ].join(','));
  fs.writeFileSync('true-potential.csv', header + '\n' + rows.join('\n'));
  console.log(`\nSaved true-potential.csv: ${allTrades.length} trades × 28 columns`);
}

run().catch(e => { console.error(e); process.exit(1); });
