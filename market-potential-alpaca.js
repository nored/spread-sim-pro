'use strict';
// market-potential-alpaca.js — Raw market pickup via Alpaca data
// Same logic as market-potential.js but using Alpaca API

require('dotenv').config();
const fs = require('fs');
const { getAllDailyBars } = require('./alpaca-client');
const { UNIVERSE } = require('./scanner');

function ols(y, x) {
  const n=y.length; let sx=0,sy=0,sxx=0,sxy=0;
  for(let i=0;i<n;i++){sx+=x[i];sy+=y[i];sxx+=x[i]*x[i];sxy+=x[i]*y[i]}
  const d=n*sxx-sx*sx; if(Math.abs(d)<1e-12)return null;
  return{beta:(n*sxy-sx*sy)/d, alpha:(sy-((n*sxy-sx*sy)/d)*sx)/n};
}

function alignByDate(a, b) {
  const m=new Map(b.map(d=>[d.date,d.close]));
  return a.filter(d=>m.has(d.date)).map(d=>({date:d.date,a:d.close,b:m.get(d.date)}));
}

async function run() {
  const startDate = new Date(); startDate.setFullYear(startDate.getFullYear() - 3);
  const endDate = new Date().toISOString().split('T')[0];
  const symbols = UNIVERSE.map(e => e.ticker);

  console.log('Fetching ' + symbols.length + ' tickers via Alpaca...');
  const priceMap = await getAllDailyBars(symbols, startDate.toISOString().split('T')[0], endDate);

  const entries = UNIVERSE.filter(e => priceMap[e.ticker]);
  const pairs = [];
  for (let i=0;i<entries.length-1;i++)
    for (let j=i+1;j<entries.length;j++)
      if (entries[i].sector===entries[j].sector) pairs.push([entries[i],entries[j]]);

  const dateSet = new Set();
  for (const d of Object.values(priceMap)) for (const r of d) dateSet.add(r.date);
  const allDates = [...dateSet].sort();
  const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 12);
  const testDates = allDates.filter(d => d >= cutoff.toISOString().split('T')[0]);

  console.log('Test: ' + testDates[0] + ' → ' + testDates[testDates.length-1] + ' (' + testDates.length + ' days)');
  console.log('Pairs: ' + pairs.length + '\n');

  const NOTIONAL = 1000;
  const COST_PER_RT = NOTIONAL * 4 * 20 / 10000;
  const allReversions = [];

  for (const [entryA, entryB] of pairs) {
    const aligned = alignByDate(priceMap[entryA.ticker], priceMap[entryB.ticker]);
    if (aligned.length < 300) continue;
    const testStart = aligned.findIndex(d => d.date >= testDates[0]);
    if (testStart < 120) continue;

    const train = aligned.slice(Math.max(0, testStart-252), testStart);
    const lA=train.map(d=>Math.log(d.a)), lB=train.map(d=>Math.log(d.b));
    const fit = ols(lA, lB);
    if (!fit || fit.beta <= 0) continue;

    const test = aligned.slice(testStart);
    const spreads = test.map(d => Math.log(d.a) - fit.beta * Math.log(d.b));

    let state='WAITING', peakZ=0, peakSpread=0, peakIdx=0, entryIdx=0;

    for (let t=20; t<spreads.length; t++) {
      const window = spreads.slice(Math.max(0,t-19), t+1);
      const n=window.length;
      const mean=window.reduce((a,b)=>a+b,0)/n;
      const std=Math.sqrt(window.reduce((a,b)=>a+(b-mean)**2,0)/n);
      if (std<1e-10) continue;
      const z=(spreads[t]-mean)/std;

      if (state==='WAITING') {
        if (Math.abs(z)>=1.5) { state='DISLOCATED'; peakZ=z; peakSpread=spreads[t]; peakIdx=t; entryIdx=t; }
      } else if (state==='DISLOCATED') {
        if (Math.abs(z)>Math.abs(peakZ)) { peakZ=z; peakSpread=spreads[t]; peakIdx=t; }
        if (Math.abs(z)<Math.abs(peakZ)*0.8) state='REVERTING';
        if (t-entryIdx>60) state='WAITING';
      } else if (state==='REVERTING') {
        if (Math.abs(z)<0.5) {
          const spreadMove=Math.abs(peakSpread-spreads[t]);
          const dollarPnl=NOTIONAL*spreadMove;
          const netPnl=dollarPnl-COST_PER_RT;
          allReversions.push({
            tickerA:entryA.ticker, tickerB:entryB.ticker, sector:entryA.sector,
            entryDate:test[entryIdx].date, peakDate:test[peakIdx].date, exitDate:test[t].date,
            peakZ:+peakZ.toFixed(4), exitZ:+z.toFixed(4),
            spreadMove:+spreadMove.toFixed(8), dollarPnl:+dollarPnl.toFixed(2),
            cost:+COST_PER_RT.toFixed(2), netPnl:+netPnl.toFixed(2),
            holdDays:t-entryIdx,
          });
          state='WAITING';
        }
        if (Math.abs(z)>Math.abs(peakZ)) state='WAITING';
        if (t-entryIdx>60) state='WAITING';
      }
    }
  }

  allReversions.sort((a,b)=>b.netPnl-a.netPnl);
  const totalGross=allReversions.reduce((a,r)=>a+r.dollarPnl,0);
  const totalCost=allReversions.reduce((a,r)=>a+r.cost,0);
  const totalNet=allReversions.reduce((a,r)=>a+r.netPnl,0);
  const profitable=allReversions.filter(r=>r.netPnl>0);

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  RAW MARKET POTENTIAL — Alpaca data, US-only, ' + entries.length + ' tickers');
  console.log('  EUR ' + NOTIONAL + '/event, ' + COST_PER_RT.toFixed(0) + ' EUR cost/RT');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('Reversion events:   ' + allReversions.length);
  console.log('Profitable:         ' + profitable.length + ' (' + (profitable.length/allReversions.length*100).toFixed(0) + '%)');
  console.log('Gross:              EUR ' + totalGross.toFixed(0));
  console.log('Costs:              EUR ' + totalCost.toFixed(0));
  console.log('Net:                EUR ' + totalNet.toFixed(0));
  console.log('Avg/event:          EUR ' + (totalNet/allReversions.length).toFixed(2));
  console.log('Avg hold:           ' + (allReversions.reduce((a,r)=>a+r.holdDays,0)/allReversions.length).toFixed(1) + ' days');

  console.log('\nAt EUR 5000 capital:');
  for (const lev of [1,3,5]) {
    const scale=5000*0.06*lev/NOTIONAL;
    console.log('  '+lev+'x: EUR '+(totalNet*scale).toFixed(0));
  }

  console.log('\nBy sector:');
  const sec={};
  for(const r of allReversions){if(!sec[r.sector])sec[r.sector]={n:0,gross:0,net:0};sec[r.sector].n++;sec[r.sector].gross+=r.dollarPnl;sec[r.sector].net+=r.netPnl}
  for(const[s,d] of Object.entries(sec).sort((a,b)=>b[1].net-a[1].net))
    console.log('  '+s.padEnd(12)+String(d.n).padStart(5)+' events | gross EUR '+d.gross.toFixed(0)+' | net EUR '+d.net.toFixed(0));

  console.log('\nBy hold time:');
  for(const[lo,hi,l] of [[1,4,'1-3d'],[4,8,'4-7d'],[8,15,'8-14d'],[15,30,'15-29d'],[30,999,'30d+']]){
    const sub=allReversions.filter(r=>r.holdDays>=lo&&r.holdDays<hi);
    if(!sub.length)continue;
    console.log('  '+l.padEnd(8)+String(sub.length).padStart(5)+' | gross EUR '+sub.reduce((a,r)=>a+r.dollarPnl,0).toFixed(0)+' | net EUR '+sub.reduce((a,r)=>a+r.netPnl,0).toFixed(0));
  }

  console.log('\nTop 15:');
  for(const r of allReversions.slice(0,15))
    console.log('  '+r.tickerA+'/'+r.tickerB+' '+r.sector.padEnd(12)+r.entryDate+' → '+r.exitDate+' | '+r.holdDays+'d | z='+r.peakZ+' | EUR '+r.netPnl.toFixed(0));

  const header='tickerA,tickerB,sector,entryDate,peakDate,exitDate,peakZ,exitZ,spreadMove,dollarPnl,cost,netPnl,holdDays';
  const rows=allReversions.map(r=>[r.tickerA,r.tickerB,r.sector,r.entryDate,r.peakDate,r.exitDate,r.peakZ,r.exitZ,r.spreadMove,r.dollarPnl,r.cost,r.netPnl,r.holdDays].join(','));
  fs.writeFileSync('market-potential-alpaca.csv',header+'\n'+rows.join('\n'));
  console.log('\nSaved market-potential-alpaca.csv: '+allReversions.length+' events');
}

run().catch(e=>{console.error(e);process.exit(1)});
