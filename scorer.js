'use strict';
// ═══════════════════════════════════════════════════════
//  scorer.js — Data-driven signal quality scorer
//
//  Empirical scoring based on analysis of 4,064 historical trades.
//  Each feature contributes points based on which performance bucket
//  it falls into. Total score = sum of all feature contributions.
//
//  Transparent, tunable, no calibration issues.
// ═══════════════════════════════════════════════════════

// Expectancy from each bucket (directly from analyze-signals.js output)
const RULES = {
  // Z-score at entry: higher z = stronger dislocation
  z: [
    { min: 4.0,  max: Inf, points: 3 },   // 71% WR, +0.72% avg
    { min: 2.5,  max: 4.0, points: 2 },   // 69% WR, +0.48% avg
    { min: 2.0,  max: 2.5, points: 1 },   // 66% WR, -0.01% avg
    { min: 1.5,  max: 2.0, points: 0 },   // 63% WR, -0.21% avg
    { min: 0,    max: 1.5, points: -2 },
  ],
  // Half-life: 5-10 is the sweet spot
  halfLife: [
    { min: 5,   max: 10,  points: 3 },    // 65% WR, +0.15% avg
    { min: 10,  max: 20,  points: 2 },    // 67% WR, +0.11% avg
    { min: 60,  max: 999, points: 1 },    // 65% WR, +0.27% avg
    { min: 40,  max: 60,  points: 0 },    // 67% WR, -0.04% avg
    { min: 20,  max: 40,  points: -1 },   // 60% WR, -0.43% avg
    { min: 0,   max: 5,   points: -2 },   // 56% WR, -1.29% avg
  ],
  // Kappa (reversion speed): 0.05-0.10 is best
  kappa: [
    { min: 0.05, max: 0.10, points: 2 },  // 67% WR, +0.17% avg
    { min: 0.10, max: 0.20, points: 1 },
    { min: 0.01, max: 0.05, points: 0 },  // 63% WR
    { min: 0,    max: 0.01, points: -1 },
  ],
  // OU R²: counterintuitively, lower is better (less overfitted)
  ouR2: [
    { min: 0,    max: 0.90, points: 2 },  // 67% WR, +0.12% avg
    { min: 0.90, max: 0.95, points: 1 },  // 65% WR
    { min: 0.95, max: 0.98, points: -1 }, // 59% WR, -0.49% avg
    { min: 0.98, max: 1.0,  points: 0 },
  ],
  // Beta (hedge ratio): 0.5-1.0 is most stable
  beta: [
    { min: 0.5, max: 1.0,  points: 2 },   // 65% WR, +0.08%
    { min: 2.0, max: 999,  points: 1 },   // 69% WR, +0.82% (but volatile)
    { min: 1.0, max: 1.5,  points: 0 },
    { min: 0,   max: 0.5,  points: -1 },  // 64% WR, -0.24%
    { min: 1.5, max: 2.0,  points: -1 },  // 60% WR, -0.41%
  ],
  // Sector: from analysis expectancy ranking
  sector: {
    SHIPPING:     3,   // +1.29% avg expectancy
    AUTOS:        2,   // +0.69%
    PHARMA:       2,   // +0.66%
    INFRA:        1,   // +0.38%
    MINING:       1,   // +0.33%
    US_BANKS:     1,   // +0.32%
    FX_COMMODITY: 0,   // +0.06%
    FX_MAJOR:     0,   // -0.02%
    SEMIS:        0,   // -0.17%
    ENERGY:       0,   // -0.25%
    BANKS:        -1,  // -0.27%
    TECH:         -1,  // -0.32%
    DEFENSE:      -2,  // -0.74%
    COMMODITY:    -2,  // -1.21%
  },
};

var Inf = Infinity;

function bucketScore(value, buckets) {
  for (const b of buckets) {
    if (value >= b.min && value < b.max) return b.points;
  }
  return 0;
}

// Score a signal. Returns { score, maxScore, probability, grade, take, breakdown }
function scoreSignal(signal, phaseName) {
  const absZ     = Math.abs(signal.z_score || signal.z || 0);
  const halfLife = signal.half_life || signal.halfLife || 0;
  const kappa    = signal.ou_kappa || signal.kappa || 0;
  const ouR2     = signal.ou_r2 || signal.ouR2 || 0;
  const beta     = signal.hedge_ratio || signal.beta || 0;
  const sector   = signal.sector || '';

  const breakdown = {
    z:        bucketScore(absZ, RULES.z),
    halfLife: bucketScore(halfLife, RULES.halfLife),
    kappa:    bucketScore(kappa, RULES.kappa),
    ouR2:     bucketScore(ouR2, RULES.ouR2),
    beta:     bucketScore(beta, RULES.beta),
    sector:   RULES.sector[sector] ?? 0,
  };

  const score = Object.values(breakdown).reduce((a, b) => a + b, 0);
  const maxScore = 3 + 3 + 2 + 2 + 2 + 3; // 15 max
  const minScore = -2 + -2 + -1 + -1 + -1 + -2; // -9 min

  // Normalize to 0-1 probability
  const probability = +Math.max(0, Math.min(1, (score - minScore) / (maxScore - minScore))).toFixed(4);

  // Grade based on score
  let grade;
  if (score >= 10) grade = 'A';
  else if (score >= 7) grade = 'B';
  else if (score >= 4) grade = 'C';
  else grade = 'D';

  // Threshold per risk phase
  const thresholds = { aggressive: 4, growth: 6, protect: 8 };
  const phaseKey = (phaseName || 'aggressive').toLowerCase();
  const threshold = thresholds[phaseKey] ?? 5;

  return {
    score,
    maxScore,
    probability,
    grade,
    take: score >= threshold,
    threshold,
    breakdown,
  };
}

module.exports = { scoreSignal, RULES };
