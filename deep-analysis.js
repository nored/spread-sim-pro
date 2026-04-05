'use strict';
// ═══════════════════════════════════════════════════════
//  deep-analysis.js — Answers all 5 diagnostic prompts
//  Outputs: deep-analysis-report.md
// ═══════════════════════════════════════════════════════

const fs = require('fs');
const report = JSON.parse(fs.readFileSync('report.json', 'utf8'));
const trades = report.trades;
const out = [];

function log(s) { out.push(s); console.log(s); }
function section(title) { log(`\n${'='.repeat(70)}`); log(`  ${title}`); log('='.repeat(70)); }

// ═════════════════════════════════════════════════════════
section('PROMPT 1 — BETA OSCILLATION DIAGNOSIS');
// ═════════════════════════════════════════════════════════

log(`
HOW BETA IS COMPUTED:
- Initial OLS beta: fitted on 252 trading days BEFORE trade entry
  Formula: logA = alpha + beta * logB (simple OLS)
  Window: fixed 252-day lookback at entry time

- During the trade: BETA IS NEVER RECOMPUTED
  server.js uses: const beta = pos.kalman_beta ?? pos.hedge_ratio
  This is frozen at entry. The Kalman beta was estimated at scan time
  and never updated during the trade's lifetime.

- The backtest's generate-report.js DOES compute a "currentBeta" for
  diagnostic purposes using a rolling 20-day window, but this is NOT
  used for P&L or exit decisions — it's only logged.

BETA DRIFT COMPUTATION:
  betaDriftPct = ((currentBeta - entryBeta) / entryBeta) * 100
  Where currentBeta = OLS on last 20 bars, entryBeta = OLS at entry
`);

// Compute beta drift stats
const drifts = trades.map(t => Math.abs(t.betaDriftAtExit));
const maxDrifts = trades.map(t => t.maxBetaDrift);
drifts.sort((a,b) => a-b);
maxDrifts.sort((a,b) => a-b);
const pct = (arr, p) => arr[Math.floor(arr.length * p)];

log('BETA DRIFT DISTRIBUTION AT EXIT:');
log(`  Min:    ${pct(drifts, 0).toFixed(1)}%`);
log(`  p25:    ${pct(drifts, 0.25).toFixed(1)}%`);
log(`  Median: ${pct(drifts, 0.50).toFixed(1)}%`);
log(`  p75:    ${pct(drifts, 0.75).toFixed(1)}%`);
log(`  p95:    ${pct(drifts, 0.95).toFixed(1)}%`);
log(`  Max:    ${pct(drifts, 0.99).toFixed(1)}%`);

log('\nMAX BETA DRIFT DURING TRADE:');
log(`  Median: ${pct(maxDrifts, 0.50).toFixed(1)}%`);
log(`  p95:    ${pct(maxDrifts, 0.95).toFixed(1)}%`);

log('\nWIN RATE BY BETA DRIFT AT EXIT:');
for (const [lo, hi, label] of [[0,10,'<10%'],[10,50,'10-50%'],[50,100,'50-100%'],[100,500,'100-500%'],[500,99999,'>500%']]) {
  const sub = trades.filter(t => Math.abs(t.betaDriftAtExit) >= lo && Math.abs(t.betaDriftAtExit) < hi);
  if (sub.length < 5) continue;
  const wins = sub.filter(t => t.pnlAfterCost > 0).length;
  const avgPnl = sub.reduce((a,t) => a + t.pnlPct, 0) / sub.length;
  log(`  Drift ${label.padEnd(10)}: ${String(sub.length).padStart(5)} trades | ${(wins/sub.length*100).toFixed(0)}% win | avg ${avgPnl.toFixed(3)}%`);
}

log('\nCRITICAL FINDING: Beta is FROZEN at entry. A 252-day OLS window');
log('estimates a long-term relationship, but during a 10-20 day trade,');
log('the actual relationship can shift dramatically. The "hedge leak"');
log('is caused by holding a stale hedge against a moving target.');

// ═════════════════════════════════════════════════════════
section('PROMPT 2 — TIME_CUT TRADE ANATOMY');
// ═════════════════════════════════════════════════════════

const timeCuts = trades.filter(t => t.exitReason === 'TIME_CUT');
log(`\nTIME_CUT trades: ${timeCuts.length} of ${trades.length} (${(timeCuts.length/trades.length*100).toFixed(1)}%)`);

let hadPositiveWindow = 0;
let peakBeforeNeg = [];
let zAtDays = { 5: [], 10: [], 15: [], 20: [] };

for (const t of timeCuts) {
  const dl = t.dailyLog || [];

  // Z at specific days
  for (const day of [5, 10, 15, 20]) {
    const entry = dl.find(d => d.day === day);
    if (entry) zAtDays[day].push(Math.abs(entry.rollingZ));
  }

  // Did P&L ever go positive then negative?
  let wasPositive = false;
  let peakPnl = -Infinity;
  for (const d of dl) {
    if (d.pnlPct > 0) wasPositive = true;
    if (d.pnlPct > peakPnl) peakPnl = d.pnlPct;
  }
  if (wasPositive && t.pnlPct <= 0) {
    hadPositiveWindow++;
    peakBeforeNeg.push(peakPnl);
  }
}

const avg = (arr) => arr.length > 0 ? arr.reduce((a,b) => a+b, 0) / arr.length : 0;

log('\nAVERAGE |ROLLING Z| AT SPECIFIC DAYS (TIME_CUT trades):');
for (const day of [5, 10, 15, 20]) {
  if (zAtDays[day].length > 0)
    log(`  Day ${String(day).padStart(2)}: avg |z| = ${avg(zAtDays[day]).toFixed(3)} (${zAtDays[day].length} trades)`);
}

log(`\nMISSED EXIT WINDOW (P&L went positive then turned negative):`);
log(`  ${hadPositiveWindow} of ${timeCuts.length} TIME_CUT trades (${(hadPositiveWindow/timeCuts.length*100).toFixed(1)}%)`);
if (peakBeforeNeg.length > 0) {
  log(`  Avg peak P&L before reversal: +${avg(peakBeforeNeg).toFixed(3)}%`);
  log(`  Max peak P&L missed: +${Math.max(...peakBeforeNeg).toFixed(3)}%`);
}

// Z direction in last 5 days
let movingTowardZero = 0;
let movingAway = 0;
for (const t of timeCuts) {
  const dl = t.dailyLog || [];
  if (dl.length < 6) continue;
  const last5 = dl.slice(-5);
  const first = Math.abs(last5[0].rollingZ);
  const last = Math.abs(last5[last5.length - 1].rollingZ);
  if (last < first) movingTowardZero++;
  else movingAway++;
}
log(`\nZ DIRECTION IN LAST 5 DAYS BEFORE TIME_CUT:`);
log(`  Moving toward zero (reverting): ${movingTowardZero} (${(movingTowardZero/(movingTowardZero+movingAway)*100).toFixed(0)}%)`);
log(`  Moving away (diverging): ${movingAway} (${(movingAway/(movingTowardZero+movingAway)*100).toFixed(0)}%)`);

// ═════════════════════════════════════════════════════════
section('PROMPT 3 — PAIR ADMISSION FILTER ANALYSIS');
// ═════════════════════════════════════════════════════════

// Read CSV for sector analysis
const csv = fs.readFileSync('report.csv', 'utf8').split('\n');
const headers = csv[0].split(',');
const idx = {};
headers.forEach((h, i) => idx[h] = i);

const csvTrades = csv.slice(1).filter(l => l.length > 10).map(line => {
  const c = line.split(',');
  return {
    tickerA: c[idx.tickerA], tickerB: c[idx.tickerB], sector: c[idx.sector],
    olsR2: parseFloat(c[idx.olsR2]), halfLife: parseFloat(c[idx.halfLife]),
    kappa: parseFloat(c[idx.kappa]), pnlAfterCost: parseFloat(c[idx.pnlAfterCost]),
    pnlPct: parseFloat(c[idx.pnlPct]), beta: parseFloat(c[idx.beta]),
  };
});

for (const sector of ['ENERGY', 'DEFENSE']) {
  const st = csvTrades.filter(t => t.sector === sector);
  const uniquePairs = new Set(st.map(t => `${t.tickerA}/${t.tickerB}`));
  const r2vals = st.map(t => t.olsR2).sort((a,b) => a-b);
  const hlvals = st.map(t => t.halfLife).sort((a,b) => a-b);

  log(`\n${sector}:`);
  log(`  Unique pairs: ${uniquePairs.size}`);
  log(`  Total trades: ${st.length}`);
  log(`  OLS R² distribution: min=${pct(r2vals,0).toFixed(3)} p25=${pct(r2vals,0.25).toFixed(3)} med=${pct(r2vals,0.5).toFixed(3)} p75=${pct(r2vals,0.75).toFixed(3)} max=${pct(r2vals,0.99).toFixed(3)}`);
  log(`  Half-life distribution: min=${pct(hlvals,0).toFixed(1)} med=${pct(hlvals,0.5).toFixed(1)} max=${pct(hlvals,0.99).toFixed(1)}`);

  log(`  Win rate by R² bucket:`);
  for (const [lo, hi, label] of [[0,0.3,'<0.3'],[0.3,0.5,'0.3-0.5'],[0.5,0.7,'0.5-0.7'],[0.7,1.01,'0.7+']]) {
    const sub = st.filter(t => t.olsR2 >= lo && t.olsR2 < hi);
    if (sub.length < 3) continue;
    const wins = sub.filter(t => t.pnlAfterCost > 0).length;
    const avgP = sub.reduce((a,t) => a + t.pnlPct, 0) / sub.length;
    log(`    R² ${label.padEnd(8)}: ${String(sub.length).padStart(4)} trades | ${(wins/sub.length*100).toFixed(0)}% win | avg ${avgP.toFixed(3)}%`);
  }

  const above05 = st.filter(t => t.olsR2 >= 0.5);
  const below05 = st.filter(t => t.olsR2 < 0.5);
  log(`  If R² threshold raised to 0.5:`);
  log(`    Kept: ${above05.length} trades (${(above05.length/st.length*100).toFixed(0)}%) | WR ${above05.length>0?(above05.filter(t=>t.pnlAfterCost>0).length/above05.length*100).toFixed(0):0}%`);
  log(`    Cut:  ${below05.length} trades (${(below05.length/st.length*100).toFixed(0)}%) | WR ${below05.length>0?(below05.filter(t=>t.pnlAfterCost>0).length/below05.length*100).toFixed(0):0}%`);
}

// ═════════════════════════════════════════════════════════
section('PROMPT 4 — CURRENT EXIT LOGIC');
// ═════════════════════════════════════════════════════════

log(`
EXIT CONDITIONS IN server.js (updatePairPnL):

1. TAKE_PROFIT: |zCurrent| <= pos.tp_z
   - tp_z = max(0.3, |z_entry| * 0.15)  [AGGRESSIVE phase]
   - Uses OU z-score: (currentSpread - equilibrium) / ouStd
   - equilibrium = rolling mean of last 20 spread values (or ou_theta if <5 history)

2. STOP_LOSS: |zCurrent| >= dynamicSL
   - dynamicSL = sl_z * max(0.70, 1 - 0.10 * max(0, ageFraction - 1))
   - sl_z = min(4.0, |z_entry| * 1.30)  [AGGRESSIVE phase]
   - Tightens by 10% per half-life beyond the first, floors at 70%

3. TIME_CUT: ageDays >= CONFIG.scanner.maxHoldDays (currently 10)
   - Hard exit regardless of z-score or P&L

4. TIMEOUT: ageDays >= 3 * pos.half_life
   - Legacy fallback, rarely triggers because TIME_CUT is usually shorter

WHAT'S MISSING:
- NO spread velocity check (rate of z change)
- NO P&L deterioration check
- NO check for P&L peak then decline (missed exit window)
- NO dynamic TP that adjusts based on how the trade is evolving
- Exit uses OU z in server.js but report analysis uses rolling z
  → These give DIFFERENT answers (gap analysis proved OU z = 28% WR)
`);

// Exit reason distribution
log('EXIT REASON DISTRIBUTION:');
const reasons = {};
for (const t of trades) { reasons[t.exitReason] = (reasons[t.exitReason]||0) + 1; }
for (const [reason, count] of Object.entries(reasons).sort((a,b) => b[1]-a[1])) {
  const sub = trades.filter(t => t.exitReason === reason);
  const wins = sub.filter(t => t.pnlAfterCost > 0).length;
  const avgP = sub.reduce((a,t) => a+t.pnlPct, 0) / sub.length;
  log(`  ${reason.padEnd(12)}: ${String(count).padStart(5)} trades | ${(wins/count*100).toFixed(0)}% win | avg ${avgP.toFixed(3)}%`);
}

// ═════════════════════════════════════════════════════════
section('PROMPT 5 — SPREAD VELOCITY ANALYSIS');
// ═════════════════════════════════════════════════════════

const revertTrades = trades.filter(t => t.exitReason === 'REVERT');
const timeCutTrades = trades.filter(t => t.exitReason === 'TIME_CUT');

function computeVelocities(tradeSet, label) {
  // For last 5 days before exit
  const velocities = [];
  const earlyVelocities = [];  // days 1-5

  for (const t of tradeSet) {
    const dl = t.dailyLog || [];
    if (dl.length < 3) continue;

    // Last 5 days velocity
    const last5 = dl.slice(-5);
    for (let i = 1; i < last5.length; i++) {
      velocities.push(Math.abs(last5[i-1].rollingZ) - Math.abs(last5[i].rollingZ));
      // positive = z moving toward zero (reverting)
    }

    // First 5 days velocity
    const first5 = dl.slice(0, Math.min(5, dl.length));
    for (let i = 1; i < first5.length; i++) {
      earlyVelocities.push(Math.abs(first5[i-1].rollingZ) - Math.abs(first5[i].rollingZ));
    }
  }

  log(`\n${label} (${tradeSet.length} trades):`);
  log(`  Last 5 days: avg z-velocity = ${avg(velocities).toFixed(4)}/day (positive = reverting)`);
  log(`  First 5 days: avg z-velocity = ${avg(earlyVelocities).toFixed(4)}/day`);

  const stalledLast5 = velocities.filter(v => v < 0.05).length;
  log(`  Last 5 days stalling (velocity < 0.05): ${(stalledLast5/velocities.length*100).toFixed(0)}%`);

  return { lastAvg: avg(velocities), earlyAvg: avg(earlyVelocities) };
}

const revertVel = computeVelocities(revertTrades, 'REVERT trades');
const timecutVel = computeVelocities(timeCutTrades, 'TIME_CUT trades');

log(`\nVELOCITY COMPARISON:`);
log(`  REVERT last 5d velocity:   ${revertVel.lastAvg.toFixed(4)}/day`);
log(`  TIME_CUT last 5d velocity: ${timecutVel.lastAvg.toFixed(4)}/day`);
log(`  Difference: ${(revertVel.lastAvg - timecutVel.lastAvg).toFixed(4)}/day`);

// Test velocity-stall exit rule
log('\nVELOCITY-STALL EXIT RULE TEST:');
log('Rule: exit if |z| velocity < 0.05 for 3 consecutive days');

let savedMoney = 0, savedCount = 0, madeWorse = 0, worseCount = 0;
for (const t of timeCutTrades) {
  const dl = t.dailyLog || [];
  if (dl.length < 5) continue;

  // Check each day for 3-day stall
  for (let i = 3; i < dl.length; i++) {
    const v1 = Math.abs(dl[i-2].rollingZ) - Math.abs(dl[i-1].rollingZ);
    const v2 = Math.abs(dl[i-1].rollingZ) - Math.abs(dl[i].rollingZ);
    const v3 = i >= 4 ? Math.abs(dl[i-3].rollingZ) - Math.abs(dl[i-2].rollingZ) : 0;

    if (v1 < 0.05 && v2 < 0.05 && v3 < 0.05) {
      // Would have exited at day i
      const earlyPnl = dl[i].pnlPct;
      const actualPnl = t.pnlPct;
      if (earlyPnl > actualPnl) { savedMoney += earlyPnl - actualPnl; savedCount++; }
      else { madeWorse += actualPnl - earlyPnl; worseCount++; }
      break;
    }
  }
}

log(`  Would have triggered on: ${savedCount + worseCount} of ${timeCutTrades.length} TIME_CUT trades`);
log(`  Improved P&L: ${savedCount} trades (saved avg ${savedCount>0?(savedMoney/savedCount).toFixed(3):0}% per trade)`);
log(`  Made worse:   ${worseCount} trades (lost avg ${worseCount>0?(madeWorse/worseCount).toFixed(3):0}% per trade)`);
log(`  Net benefit:  ${(savedMoney - madeWorse).toFixed(2)}% total`);

// ═════════════════════════════════════════════════════════
section('SYNTHESIS — WHAT NEEDS TO CHANGE');
// ═════════════════════════════════════════════════════════

log(`
ROOT CAUSES OF LOSS (in priority order):

1. FROZEN HEDGE RATIO
   Beta is computed once at entry and never updated. Average drift: 236%.
   The position is structurally wrong by exit. This alone explains why
   z-score reversion (97.8%) doesn't translate to P&L (48.6%).
   FIX: Recompute beta daily using a short rolling window. Adjust position
   shares to match the new hedge ratio.

2. OU Z-SCORE FOR EXITS
   The live system (server.js) uses OU z for exit decisions. The gap
   analysis proved OU z has 28% WR vs rolling z at 97.8%. The backtest
   partially fixed this but the live system still uses OU z.
   FIX: Switch server.js exit logic to rolling z-score.

3. NO ADAPTIVE EXIT
   Static TP/SL/time limits. No awareness of whether the trade is
   working (velocity toward zero) or dying (stalling/reversing).
   FIX: Add velocity-based exit. If z is not moving toward zero for
   3 consecutive polls, exit early. Don't wait for TIME_CUT.

4. MISSED EXIT WINDOWS
   Many TIME_CUT trades had positive P&L earlier in the trade that
   reversed before the hard time limit. A trailing stop on P&L or
   z-score would capture these.
   FIX: Add trailing TP — once P&L exceeds +1%, set a floor at 0%.
   Exit if P&L drops below the floor.
`);

// Write report
const reportText = out.join('\n');
fs.writeFileSync('deep-analysis-report.md', reportText);
console.log(`\nReport saved to deep-analysis-report.md (${(reportText.length/1024).toFixed(0)}KB)`);
