'use strict';
// ═══════════════════════════════════════════════════════
//  market-potential.js — Raw market pickup
//
//  Finds every mean-reversion event in 12 months of data.
//  No system, no filters, no entry/exit rules.
//  Just: spread dislocates → spread reverts → measure the profit.
//  Subtract round-trip costs. That's the market potential.
//
//  Usage: node market-potential.js
// ═══════════════════════════════════════════════════════

const fs = require('fs');
const { UNIVERSE, CONFIG, FETCH_DELAY_MS } = require('./scanner');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

function ols(y, x) {
  const n = y.length; let sx=0, sy=0, sxx=0, sxy=0;
  for (let i = 0; i < n; i++) { sx+=x[i]; sy+=y[i]; sxx+=x[i]*x[i]; sxy+=x[i]*y[i]; }
  const d = n*sxx - sx*sx;
  if (Math.abs(d) < 1e-12) return null;
  return { beta: (n*sxy - sx*sy) / d, alpha: (sy - ((n*sxy - sx*sy) / d) * sx) / n };
}

function alignByDate(a, b) {
  const m = new Map(b.map(d => [d.date, d.close]));
  return a.filter(d => m.has(d.date)).map(d => ({ date: d.date, a: d.close, b: m.get(d.date) }));
}

async function fetchAllPrices() {
  const startDate = new Date(); startDate.setFullYear(startDate.getFullYear() - 3);
  const period1 = startDate.toISOString().split('T')[0];
  console.log('Fetching...');
  const priceMap = {};
  let done = 0;
  for (const entry of UNIVERSE) {
    try {
      const chart = await yahooFinance.chart(entry.ticker, {
        period1, period2: new Date().toISOString().split('T')[0], interval: '1d',
      }, { validateResult: false });
      const data = (chart.quotes || [])
        .filter(q => q.date && (q.adjclose ?? q.close) > 0)
        .map(q => ({ date: q.date.toISOString().split('T')[0], close: q.adjclose ?? q.close }));
      if (data.length >= 120) priceMap[entry.ticker] = data;
    } catch {}
    done++;
    if (done % 20 === 0) process.stdout.write(done + '/' + UNIVERSE.length + '\r');
    await new Promise(r => setTimeout(r, FETCH_DELAY_MS));
  }
  console.log('Fetched ' + Object.keys(priceMap).length + ' tickers\n');
  return priceMap;
}

async function run() {
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

  const NOTIONAL = 1000;
  const COST_PER_ROUNDTRIP = NOTIONAL * 4 * 20 / 10000; // 20bps × 2 legs × 2 sides
  const allReversions = [];

  for (const [entryA, entryB] of pairs) {
    const aligned = alignByDate(priceMap[entryA.ticker], priceMap[entryB.ticker]);
    if (aligned.length < 300) continue;
    const testStart = aligned.findIndex(d => d.date >= testDates[0]);
    if (testStart < 120) continue;

    // Train beta on pre-test data
    const train = aligned.slice(Math.max(0, testStart - 252), testStart);
    const lA = train.map(d => Math.log(d.a)), lB = train.map(d => Math.log(d.b));
    const fit = ols(lA, lB);
    if (!fit || fit.beta <= 0) continue;

    // Spread + rolling z over test period
    const test = aligned.slice(testStart);
    const spreads = test.map(d => Math.log(d.a) - fit.beta * Math.log(d.b));

    // Find every reversion cycle:
    //   |z| crosses above 1.5 → track peak → |z| drops below 0.5
    //   Profit = |peakSpread - exitSpread|
    let state = 'WAITING';
    let peakZ = 0, peakSpread = 0, peakIdx = 0, entrySpread = 0, entryIdx = 0;

    for (let t = 20; t < spreads.length; t++) {
      const window = spreads.slice(Math.max(0, t - 19), t + 1);
      const n = window.length;
      const mean = window.reduce((a, b) => a + b, 0) / n;
      const std = Math.sqrt(window.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
      if (std < 1e-10) continue;
      const z = (spreads[t] - mean) / std;

      if (state === 'WAITING') {
        if (Math.abs(z) >= 1.5) {
          state = 'DISLOCATED';
          peakZ = z; peakSpread = spreads[t]; peakIdx = t;
          entrySpread = spreads[t]; entryIdx = t;
        }
      } else if (state === 'DISLOCATED') {
        if (Math.abs(z) > Math.abs(peakZ)) {
          peakZ = z; peakSpread = spreads[t]; peakIdx = t;
        }
        if (Math.abs(z) < Math.abs(peakZ) * 0.8) {
          state = 'REVERTING';
        }
        if (t - entryIdx > 60) { state = 'WAITING'; }
      } else if (state === 'REVERTING') {
        if (Math.abs(z) < 0.5) {
          const spreadMove = Math.abs(peakSpread - spreads[t]);
          const dollarPnl = NOTIONAL * spreadMove;
          const netPnl = dollarPnl - COST_PER_ROUNDTRIP;
          const holdDays = t - entryIdx;

          allReversions.push({
            tickerA: entryA.ticker, tickerB: entryB.ticker, sector: entryA.sector,
            entryDate: test[entryIdx].date, peakDate: test[peakIdx].date, exitDate: test[t].date,
            peakZ: +peakZ.toFixed(4), exitZ: +z.toFixed(4),
            spreadMove: +spreadMove.toFixed(8),
            dollarPnl: +dollarPnl.toFixed(2),
            cost: +COST_PER_ROUNDTRIP.toFixed(2),
            netPnl: +netPnl.toFixed(2),
            holdDays,
          });
          state = 'WAITING';
        }
        if (Math.abs(z) > Math.abs(peakZ)) { state = 'WAITING'; }
        if (t - entryIdx > 60) { state = 'WAITING'; }
      }
    }
  }

  // Results
  allReversions.sort((a, b) => b.netPnl - a.netPnl);
  const totalGross = allReversions.reduce((a, r) => a + r.dollarPnl, 0);
  const totalCost = allReversions.reduce((a, r) => a + r.cost, 0);
  const totalNet = allReversions.reduce((a, r) => a + r.netPnl, 0);
  const profitable = allReversions.filter(r => r.netPnl > 0);

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  RAW MARKET POTENTIAL — every mean reversion event');
  console.log('  12 months, ' + pairs.length + ' same-sector pairs');
  console.log('  EUR ' + NOTIONAL + ' per event, ' + COST_PER_ROUNDTRIP.toFixed(0) + ' EUR cost per round trip');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('Total reversion events:  ' + allReversions.length);
  console.log('Profitable after costs:  ' + profitable.length + ' (' + (profitable.length / allReversions.length * 100).toFixed(0) + '%)');
  console.log('Gross pickup:            EUR ' + totalGross.toFixed(0));
  console.log('Total costs:             EUR ' + totalCost.toFixed(0));
  console.log('Net pickup:              EUR ' + totalNet.toFixed(0));
  console.log('Avg per event:           EUR ' + (totalNet / allReversions.length).toFixed(2));
  console.log('Avg hold:                ' + (allReversions.reduce((a, r) => a + r.holdDays, 0) / allReversions.length).toFixed(1) + ' days');

  console.log('\nAt EUR 5000 capital:');
  for (const lev of [1, 3, 5]) {
    const scale = 5000 * 0.06 * lev / NOTIONAL;
    console.log('  ' + lev + 'x leverage: EUR ' + (totalNet * scale).toFixed(0));
  }

  console.log('\nBy sector:');
  const sec = {};
  for (const r of allReversions) { if (!sec[r.sector]) sec[r.sector] = {n:0, gross:0, net:0}; sec[r.sector].n++; sec[r.sector].gross += r.dollarPnl; sec[r.sector].net += r.netPnl; }
  for (const [s, d] of Object.entries(sec).sort((a, b) => b[1].net - a[1].net))
    console.log('  ' + s.padEnd(16) + String(d.n).padStart(4) + ' events | gross EUR ' + d.gross.toFixed(0) + ' | net EUR ' + d.net.toFixed(0));

  console.log('\nBy hold time:');
  for (const [lo, hi, l] of [[1,4,'1-3d'],[4,8,'4-7d'],[8,15,'8-14d'],[15,30,'15-29d'],[30,999,'30d+']]) {
    const sub = allReversions.filter(r => r.holdDays >= lo && r.holdDays < hi);
    if (!sub.length) continue;
    console.log('  ' + l.padEnd(8) + String(sub.length).padStart(5) + ' | gross EUR ' + sub.reduce((a,r) => a+r.dollarPnl, 0).toFixed(0) + ' | net EUR ' + sub.reduce((a,r) => a+r.netPnl, 0).toFixed(0));
  }

  console.log('\nTop 15 events:');
  for (const r of allReversions.slice(0, 15))
    console.log('  ' + r.tickerA + '/' + r.tickerB + ' ' + r.sector.padEnd(14) + r.entryDate + ' → ' + r.exitDate + ' | ' + r.holdDays + 'd | peak z=' + r.peakZ + ' | net EUR ' + r.netPnl.toFixed(0));

  // Save CSV
  const header = 'tickerA,tickerB,sector,entryDate,peakDate,exitDate,peakZ,exitZ,spreadMove,dollarPnl,cost,netPnl,holdDays';
  const rows = allReversions.map(r => [r.tickerA, r.tickerB, r.sector, r.entryDate, r.peakDate, r.exitDate, r.peakZ, r.exitZ, r.spreadMove, r.dollarPnl, r.cost, r.netPnl, r.holdDays].join(','));
  fs.writeFileSync('market-potential.csv', header + '\n' + rows.join('\n'));
  console.log('\nSaved market-potential.csv: ' + allReversions.length + ' events');
}

run().catch(e => { console.error(e); process.exit(1); });
