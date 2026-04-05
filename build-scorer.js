'use strict';
// ═══════════════════════════════════════════════════════
//  build-scorer.js — Learn a signal quality model from backtest data
//
//  Reads signal-analysis.json (4000+ labeled trades), fits a
//  logistic regression to predict P(win), outputs optimal weights
//  and a scorer function for the live system.
//
//  No ML libraries. Plain gradient descent on logistic loss.
//
//  Usage: node build-scorer.js
// ═══════════════════════════════════════════════════════

const fs = require('fs');

// ── Load data ───────────────────────────────────────────
const raw = JSON.parse(fs.readFileSync('signal-analysis.json', 'utf8'));
const signals = raw.signals;
console.log(`Loaded ${signals.length} labeled signals\n`);

// ── Feature engineering ─────────────────────────────────
// Normalize features to [0,1] range for stable gradient descent
function stats(arr) {
  const n = arr.length;
  const mean = arr.reduce((a,b)=>a+b,0)/n;
  const std = Math.sqrt(arr.reduce((a,b)=>a+(b-mean)**2,0)/n) || 1;
  const min = Math.min(...arr);
  const max = Math.max(...arr);
  return { mean, std, min, max };
}

// Features we'll use (based on what the analysis showed matters)
const featureNames = [
  'absEntryZ',     // z-score magnitude at entry
  'halfLife',      // OU half-life
  'kappa',         // mean-reversion speed
  'ouR2',          // OU model fit quality
  'olsR2',         // OLS cointegration fit
  'beta',          // hedge ratio
  'spreadStd',     // spread volatility
  'sigma',         // OU annualized vol
];

// Sector encoding: one-hot for top sectors, 0 for others
const sectorMap = {};
const sectorCounts = {};
for (const s of signals) { sectorCounts[s.sector] = (sectorCounts[s.sector]||0) + 1; }
const topSectors = Object.entries(sectorCounts)
  .filter(([,n]) => n >= 30)
  .sort((a,b) => b[1]-a[1])
  .map(([s]) => s);

console.log('Sectors:', topSectors.join(', '));

// Extract feature matrix
function extractFeatures(signal) {
  const f = featureNames.map(name => signal[name] || 0);
  // Add sector one-hot
  for (const sec of topSectors) {
    f.push(signal.sector === sec ? 1 : 0);
  }
  // Interaction features (the analysis showed these matter)
  f.push(signal.absEntryZ * signal.kappa);          // z × speed
  f.push(signal.halfLife * signal.kappa);            // consistency check
  f.push(signal.absEntryZ / (signal.halfLife || 1)); // z per half-life
  return f;
}

const allFeatures = signals.map(extractFeatures);
const allLabels = signals.map(s => s.pnlPct > 0 ? 1 : 0);

// Feature names for output
const allFeatureNames = [
  ...featureNames,
  ...topSectors.map(s => `sector_${s}`),
  'z_x_kappa', 'hl_x_kappa', 'z_per_hl',
];

// Normalize
const featureStats = [];
for (let j = 0; j < allFeatureNames.length; j++) {
  const col = allFeatures.map(f => f[j]);
  const st = stats(col);
  featureStats.push(st);
  // Normalize in place
  for (let i = 0; i < allFeatures.length; i++) {
    allFeatures[i][j] = st.std > 0 ? (allFeatures[i][j] - st.mean) / st.std : 0;
  }
}

// ── Logistic regression via gradient descent ────────────
const nFeatures = allFeatureNames.length;
const weights = new Array(nFeatures + 1).fill(0); // +1 for bias

function sigmoid(x) { return 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, x)))); }

function predict(features) {
  let z = weights[0]; // bias
  for (let j = 0; j < features.length; j++) z += weights[j + 1] * features[j];
  return sigmoid(z);
}

function loss() {
  let total = 0;
  for (let i = 0; i < allFeatures.length; i++) {
    const p = predict(allFeatures[i]);
    const y = allLabels[i];
    total += -y * Math.log(p + 1e-10) - (1 - y) * Math.log(1 - p + 1e-10);
  }
  return total / allFeatures.length;
}

// Train
const lr = 0.1;
const epochs = 500;
const n = allFeatures.length;

console.log(`\nTraining logistic regression: ${nFeatures} features, ${n} samples`);
console.log(`Baseline win rate: ${(allLabels.reduce((a,b)=>a+b,0)/n*100).toFixed(1)}%\n`);

for (let epoch = 0; epoch < epochs; epoch++) {
  // Compute gradients
  const grad = new Array(nFeatures + 1).fill(0);
  for (let i = 0; i < n; i++) {
    const p = predict(allFeatures[i]);
    const err = p - allLabels[i];
    grad[0] += err; // bias
    for (let j = 0; j < nFeatures; j++) grad[j + 1] += err * allFeatures[i][j];
  }

  // Stronger L2 regularization — prevent sigmoid saturation
  const lambda = 0.10;
  for (let j = 1; j <= nFeatures; j++) grad[j] += lambda * weights[j];

  // Update
  for (let j = 0; j <= nFeatures; j++) weights[j] -= lr * grad[j] / n;

  if (epoch % 100 === 0 || epoch === epochs - 1) {
    console.log(`  Epoch ${epoch}: loss=${loss().toFixed(4)}`);
  }
}

// ── Evaluate ────────────────────────────────────────────
const predictions = allFeatures.map((f, i) => ({
  prob: predict(f),
  actual: allLabels[i],
  pnlPct: signals[i].pnlPct,
  sector: signals[i].sector,
  z: signals[i].absEntryZ,
  hl: signals[i].halfLife,
}));

predictions.sort((a, b) => b.prob - a.prob);

console.log('\n═══════════════════════════════════════════');
console.log('  MODEL EVALUATION');
console.log('═══════════════════════════════════════════');

// Show performance at different probability thresholds
for (const threshold of [0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80]) {
  const above = predictions.filter(p => p.prob >= threshold);
  if (above.length < 10) continue;
  const wins = above.filter(p => p.actual === 1).length;
  const avgPnl = above.reduce((a,p) => a + p.pnlPct, 0) / above.length;
  const totalPnl = above.reduce((a,p) => a + p.pnlPct, 0);
  console.log(`  P>=${threshold.toFixed(2)}: ${String(above.length).padStart(5)} trades | ${(wins/above.length*100).toFixed(0)}% win | avg ${avgPnl>=0?'+':''}${avgPnl.toFixed(2)}% | total ${totalPnl>=0?'+':''}${totalPnl.toFixed(0)}%`);
}

// Compare: what static z>=2.5 + hl 5-20 gives vs the model
const staticFiltered = predictions.filter((p, i) => signals[i].absEntryZ >= 2.5 && signals[i].halfLife >= 5 && signals[i].halfLife <= 20);
const modelBest = predictions.filter(p => p.prob >= 0.70);

console.log('\n  STATIC FILTERS (z>=2.5, hl 5-20):');
if (staticFiltered.length > 0) {
  const sw = staticFiltered.filter(p=>p.actual===1).length;
  console.log(`    ${staticFiltered.length} trades | ${(sw/staticFiltered.length*100).toFixed(0)}% win | total ${staticFiltered.reduce((a,p)=>a+p.pnlPct,0).toFixed(0)}%`);
}

console.log('  MODEL (P>=0.70):');
if (modelBest.length > 0) {
  const mw = modelBest.filter(p=>p.actual===1).length;
  console.log(`    ${modelBest.length} trades | ${(mw/modelBest.length*100).toFixed(0)}% win | total ${modelBest.reduce((a,p)=>a+p.pnlPct,0).toFixed(0)}%`);
}

// ── Feature importance (absolute weight × std) ──────────
console.log('\n  FEATURE IMPORTANCE (what predicts winning):');
const importance = allFeatureNames.map((name, j) => ({
  name,
  weight: weights[j + 1],
  absWeight: Math.abs(weights[j + 1]),
})).sort((a, b) => b.absWeight - a.absWeight);

for (const f of importance) {
  const dir = f.weight > 0 ? '+' : '-';
  const bar = '█'.repeat(Math.min(30, Math.round(f.absWeight * 10)));
  console.log(`    ${dir} ${f.name.padEnd(20)} ${f.weight.toFixed(4).padStart(8)} ${bar}`);
}

// ── Output scorer config ────────────────────────────────
const scorerConfig = {
  weights: weights,
  featureNames: allFeatureNames,
  featureStats: allFeatureNames.map((name, j) => ({
    name,
    mean: featureStats[j].mean,
    std: featureStats[j].std,
  })),
  topSectors,
  baseFeatureNames: featureNames,
  thresholds: {
    aggressive: 0.55,  // AGGRESSIVE phase: take more trades
    growth:     0.60,
    protect:    0.70,  // PROTECT phase: only high-confidence
  },
};

fs.writeFileSync('scorer-config.json', JSON.stringify(scorerConfig, null, 2));
console.log('\n\nScorer config saved to scorer-config.json');
console.log('Use in live system: require("./scorer-config.json")');
console.log('═══════════════════════════════════════════\n');
