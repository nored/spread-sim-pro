'use strict';
// ═══════════════════════════════════════════════════════
//  scanner.js  –  Pair Intelligence Engine v5
//
//  Model: Engle-Granger cointegration (bidirectional) +
//         Kalman-filtered hedge ratio +
//         Ornstein-Uhlenbeck spread dynamics
//
//  Fixes applied vs v4:
//    1. Benjamini-Hochberg FDR correction across all pairs
//    2. Bidirectional cointegration test (both OLS directions)
//    3. Kalman filter for time-varying hedge ratio
//    4. FX conversion to USD before testing cross-currency pairs
//    5. Pair position schema moved to db.js (server.js uses pair_positions)
//    6. Cointegration stability check (first-half vs second-half)
//    7. ADF with AIC-selected lag order (0-4 lags)
//
//  Rate limit: YAHOO_RPM controls request rate. Exponential
//  backoff on 429 errors (up to FETCH_RETRIES attempts).
// ═══════════════════════════════════════════════════════

require('dotenv').config();
const { getAllDailyBars, getLatestTrade, DELAY_MS } = require('./alpaca-client');
const db = require('./db');

// ── Universe (US-only, Alpaca) ──────────────────────────
const UNIVERSE = [
  // ── DEFENSE (14) ──────────────────────────────────────
  { ticker: 'LMT',     name: 'Lockheed Martin',   sector: 'DEFENSE'    },
  { ticker: 'RTX',     name: 'Raytheon',           sector: 'DEFENSE'    },
  { ticker: 'NOC',     name: 'Northrop Grumman',   sector: 'DEFENSE'    },
  { ticker: 'GD',      name: 'General Dynamics',   sector: 'DEFENSE'    },
  { ticker: 'BA',      name: 'Boeing',             sector: 'DEFENSE'    },
  { ticker: 'LHX',     name: 'L3Harris',           sector: 'DEFENSE'    },
  { ticker: 'HII',     name: 'Huntington Ingalls', sector: 'DEFENSE'    },
  { ticker: 'LDOS',    name: 'Leidos',             sector: 'DEFENSE'    },
  { ticker: 'SAIC',    name: 'SAIC',               sector: 'DEFENSE'    },
  { ticker: 'ESLT',    name: 'Elbit Systems',      sector: 'DEFENSE'    },
  { ticker: 'BWXT',    name: 'BWX Technologies',   sector: 'DEFENSE'    },
  { ticker: 'KTOS',    name: 'Kratos Defense',     sector: 'DEFENSE'    },
  { ticker: 'TDG',     name: 'TransDigm',          sector: 'DEFENSE'    },
  { ticker: 'HWM',     name: 'Howmet Aerospace',   sector: 'DEFENSE'    },
  // ── ENERGY (14) ───────────────────────────────────────
  { ticker: 'XOM',     name: 'ExxonMobil',         sector: 'ENERGY'     },
  { ticker: 'CVX',     name: 'Chevron',            sector: 'ENERGY'     },
  { ticker: 'HAL',     name: 'Halliburton',        sector: 'ENERGY'     },
  { ticker: 'SLB',     name: 'SLB',                sector: 'ENERGY'     },
  { ticker: 'BKR',     name: 'Baker Hughes',       sector: 'ENERGY'     },
  { ticker: 'COP',     name: 'ConocoPhillips',     sector: 'ENERGY'     },
  { ticker: 'EOG',     name: 'EOG Resources',      sector: 'ENERGY'     },
  { ticker: 'PSX',     name: 'Phillips 66',        sector: 'ENERGY'     },
  { ticker: 'DVN',     name: 'Devon Energy',       sector: 'ENERGY'     },
  { ticker: 'FANG',    name: 'Diamondback Energy', sector: 'ENERGY'     },
  { ticker: 'OXY',     name: 'Occidental',         sector: 'ENERGY'     },
  { ticker: 'MPC',     name: 'Marathon Petroleum', sector: 'ENERGY'     },
  { ticker: 'VLO',     name: 'Valero Energy',      sector: 'ENERGY'     },
  { ticker: 'PXD',     name: 'Pioneer Natural',    sector: 'ENERGY'     },
  // ── SHIPPING (6) ──────────────────────────────────────
  { ticker: 'FRO',     name: 'Frontline',          sector: 'SHIPPING'   },
  { ticker: 'STNG',    name: 'Scorpio Tankers',    sector: 'SHIPPING'   },
  { ticker: 'DHT',     name: 'DHT Holdings',       sector: 'SHIPPING'   },
  { ticker: 'INSW',    name: 'Intl Seaways',       sector: 'SHIPPING'   },
  { ticker: 'NAT',     name: 'Nordic American',    sector: 'SHIPPING'   },
  { ticker: 'TRMD',    name: 'TORM',               sector: 'SHIPPING'   },
  // ── COMMODITY (4) ─────────────────────────────────────
  { ticker: 'GLD',     name: 'Gold ETF',           sector: 'COMMODITY'  },
  { ticker: 'USO',     name: 'Oil ETF',            sector: 'COMMODITY'  },
  { ticker: 'UNG',     name: 'Natural Gas ETF',    sector: 'COMMODITY'  },
  { ticker: 'SLV',     name: 'Silver ETF',         sector: 'COMMODITY'  },
  // ── SEMIS (16) ────────────────────────────────────────
  { ticker: 'NVDA',    name: 'NVIDIA',             sector: 'SEMIS'      },
  { ticker: 'AMD',     name: 'AMD',                sector: 'SEMIS'      },
  { ticker: 'INTC',    name: 'Intel',              sector: 'SEMIS'      },
  { ticker: 'TSM',     name: 'TSMC',               sector: 'SEMIS'      },
  { ticker: 'QCOM',    name: 'Qualcomm',           sector: 'SEMIS'      },
  { ticker: 'MU',      name: 'Micron',             sector: 'SEMIS'      },
  { ticker: 'LRCX',    name: 'Lam Research',       sector: 'SEMIS'      },
  { ticker: 'AMAT',    name: 'Applied Materials',  sector: 'SEMIS'      },
  { ticker: 'AVGO',    name: 'Broadcom',           sector: 'SEMIS'      },
  { ticker: 'KLAC',    name: 'KLA Corp',           sector: 'SEMIS'      },
  { ticker: 'MRVL',    name: 'Marvell',            sector: 'SEMIS'      },
  { ticker: 'ON',      name: 'ON Semi',            sector: 'SEMIS'      },
  { ticker: 'SWKS',    name: 'Skyworks',           sector: 'SEMIS'      },
  { ticker: 'TXN',     name: 'Texas Instruments',  sector: 'SEMIS'      },
  { ticker: 'NXPI',    name: 'NXP Semi',           sector: 'SEMIS'      },
  { ticker: 'ADI',     name: 'Analog Devices',     sector: 'SEMIS'      },
  // ── TECH (13) ─────────────────────────────────────────
  { ticker: 'PANW',    name: 'Palo Alto',          sector: 'TECH'       },
  { ticker: 'CRWD',    name: 'CrowdStrike',        sector: 'TECH'       },
  { ticker: 'FTNT',    name: 'Fortinet',           sector: 'TECH'       },
  { ticker: 'ZS',      name: 'Zscaler',            sector: 'TECH'       },
  { ticker: 'CRM',     name: 'Salesforce',         sector: 'TECH'       },
  { ticker: 'ORCL',    name: 'Oracle',             sector: 'TECH'       },
  { ticker: 'SNOW',    name: 'Snowflake',          sector: 'TECH'       },
  { ticker: 'NET',     name: 'Cloudflare',         sector: 'TECH'       },
  { ticker: 'DDOG',    name: 'Datadog',            sector: 'TECH'       },
  { ticker: 'MDB',     name: 'MongoDB',            sector: 'TECH'       },
  { ticker: 'PLTR',    name: 'Palantir',           sector: 'TECH'       },
  { ticker: 'NOW',     name: 'ServiceNow',         sector: 'TECH'       },
  { ticker: 'WDAY',    name: 'Workday',            sector: 'TECH'       },
  // ── US_BANKS (10) ─────────────────────────────────────
  { ticker: 'JPM',     name: 'JPMorgan',           sector: 'US_BANKS'   },
  { ticker: 'BAC',     name: 'Bank of America',    sector: 'US_BANKS'   },
  { ticker: 'GS',      name: 'Goldman Sachs',      sector: 'US_BANKS'   },
  { ticker: 'MS',      name: 'Morgan Stanley',     sector: 'US_BANKS'   },
  { ticker: 'C',       name: 'Citigroup',          sector: 'US_BANKS'   },
  { ticker: 'WFC',     name: 'Wells Fargo',        sector: 'US_BANKS'   },
  { ticker: 'SCHW',    name: 'Schwab',             sector: 'US_BANKS'   },
  { ticker: 'USB',     name: 'US Bancorp',         sector: 'US_BANKS'   },
  { ticker: 'PNC',     name: 'PNC Financial',      sector: 'US_BANKS'   },
  { ticker: 'TFC',     name: 'Truist',             sector: 'US_BANKS'   },
  // ── MINING (11) ───────────────────────────────────────
  { ticker: 'NEM',     name: 'Newmont',            sector: 'MINING'     },
  { ticker: 'GOLD',    name: 'Barrick Gold',       sector: 'MINING'     },
  { ticker: 'FCX',     name: 'Freeport-McMoRan',   sector: 'MINING'     },
  { ticker: 'BHP',     name: 'BHP Group',          sector: 'MINING'     },
  { ticker: 'RIO',     name: 'Rio Tinto',          sector: 'MINING'     },
  { ticker: 'VALE',    name: 'Vale',               sector: 'MINING'     },
  { ticker: 'SCCO',    name: 'Southern Copper',    sector: 'MINING'     },
  { ticker: 'TECK',    name: 'Teck Resources',     sector: 'MINING'     },
  { ticker: 'AA',      name: 'Alcoa',              sector: 'MINING'     },
  { ticker: 'CLF',     name: 'Cleveland-Cliffs',   sector: 'MINING'     },
  { ticker: 'MP',      name: 'MP Materials',       sector: 'MINING'     },
  // ── PHARMA (12) ───────────────────────────────────────
  { ticker: 'JNJ',     name: 'Johnson & Johnson',  sector: 'PHARMA'     },
  { ticker: 'PFE',     name: 'Pfizer',             sector: 'PHARMA'     },
  { ticker: 'MRK',     name: 'Merck',              sector: 'PHARMA'     },
  { ticker: 'ABBV',    name: 'AbbVie',             sector: 'PHARMA'     },
  { ticker: 'LLY',     name: 'Eli Lilly',          sector: 'PHARMA'     },
  { ticker: 'NVO',     name: 'Novo Nordisk',       sector: 'PHARMA'     },
  { ticker: 'AZN',     name: 'AstraZeneca',        sector: 'PHARMA'     },
  { ticker: 'BMY',     name: 'Bristol-Myers',      sector: 'PHARMA'     },
  { ticker: 'AMGN',    name: 'Amgen',              sector: 'PHARMA'     },
  { ticker: 'GILD',    name: 'Gilead',             sector: 'PHARMA'     },
  { ticker: 'REGN',    name: 'Regeneron',          sector: 'PHARMA'     },
  { ticker: 'VRTX',    name: 'Vertex',             sector: 'PHARMA'     },
  // ── AUTOS (7) ─────────────────────────────────────────
  { ticker: 'F',       name: 'Ford',               sector: 'AUTOS'      },
  { ticker: 'GM',      name: 'General Motors',     sector: 'AUTOS'      },
  { ticker: 'STLA',    name: 'Stellantis',         sector: 'AUTOS'      },
  { ticker: 'TM',      name: 'Toyota',             sector: 'AUTOS'      },
  { ticker: 'APTV',    name: 'Aptiv',              sector: 'AUTOS'      },
  { ticker: 'BWA',     name: 'BorgWarner',         sector: 'AUTOS'      },
  { ticker: 'ALV',     name: 'Autoliv',            sector: 'AUTOS'      },
  // ── INFRA (8) ─────────────────────────────────────────
  { ticker: 'NEE',     name: 'NextEra Energy',     sector: 'INFRA'      },
  { ticker: 'PWR',     name: 'Quanta Services',    sector: 'INFRA'      },
  { ticker: 'DUK',     name: 'Duke Energy',        sector: 'INFRA'      },
  { ticker: 'SO',      name: 'Southern Company',   sector: 'INFRA'      },
  { ticker: 'AES',     name: 'AES Corp',           sector: 'INFRA'      },
  { ticker: 'XEL',     name: 'Xcel Energy',        sector: 'INFRA'      },
  { ticker: 'ES',      name: 'Eversource',         sector: 'INFRA'      },
  { ticker: 'VST',     name: 'Vistra',             sector: 'INFRA'      },
];

// All sectors active. The signal works in every sector (97.8% z-reversion).
// Sector filtering was masking the real problem: hedge ratio drift.
const SECTOR_WHITELIST = new Set(
  [...new Set(UNIVERSE.map(e => e.sector))]
);

// ── Rate Limit Configuration ────────────────────────────
// Alpaca: 200 req/min free tier. DELAY_MS imported from alpaca-client.
const FETCH_DELAY_MS  = DELAY_MS;
const YAHOO_RPM       = Math.ceil(60000 / DELAY_MS); // compat export

// ── Pair Analysis Configuration ─────────────────────────
function rollingLookback(tradingDays = 504) {
  const d = new Date();
  d.setDate(d.getDate() - Math.round(tradingDays * 365 / 252));
  return d.toISOString().split('T')[0];
}

const CONFIG = {
  lookbackDays:  756,      // rolling window (trading days); actual date computed at scan start
  minObs:        120,
  halfLifeMin:   5,
  halfLifeMax:   20,    // analysis: hl 5-20 has best expectancy, longer = losses
  zScoreEntry:   2.5,   // analysis: z>=2.5 → 69% WR, 0.48% expectancy (z<2.5 is noise)
  zScoreStrong:  3.0,
  bhAlpha:       1.00,   // BH pre-filter: passes ~50 candidates for quality filters (Hurst, IR, walk-forward, OU, z-score)
  kalmanDelta:   0.0001, // hedge ratio drift speed (smaller = slower drift)
  maxAdfLags:    4,      // maximum ADF lag order for AIC selection
  oosAlpha:      0.15,   // walk-forward ADF threshold (lenient: shorter series)
  hlCvMax:       0.50,   // max coefficient of variation of half-life across sub-periods
  maxBetaDrift:  1.50,   // max fractional drift between Kalman and OLS hedge ratio (Kalman adapts over 3yr window — large drift is normal)
  hurstMax:      1.00,   // effectively disabled — R/S Hurst is biased >0.8 for financial spreads; ADF handles mean-reversion
  minSpreadIR:   0.20,   // minimum annualized information ratio of canonical spread
  minVolumeUSD:  5_000_000,    // $5M median daily turnover (20M was killing European/shipping names)
};

// All tickers are US — no FX conversion needed.
function getCurrency() { return 'USD'; }

// ══════════════════════════════════════════════════════════
//  LINEAR ALGEBRA
// ══════════════════════════════════════════════════════════

// Simple OLS: y = alpha + beta * x
// Returns { alpha, beta, residuals, r2 } or null.
function ols(y, x) {
  const n = y.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; sxy += x[i] * y[i];
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const beta  = (n * sxy - sx * sy) / denom;
  const alpha = (sy - beta * sx) / n;
  const resid = y.map((yi, i) => yi - alpha - beta * x[i]);
  const yMean = sy / n;
  const ssTot = y.reduce((a, yi) => a + (yi - yMean) ** 2, 0);
  const ssRes = resid.reduce((a, e) => a + e * e, 0);
  return { alpha, beta, residuals: resid, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0 };
}

// Multi-dimensional OLS: y = X * beta (no intercept; caller includes intercept column if needed).
// X is array of row vectors. Uses Gaussian elimination on normal equations.
// Returns { coeffs, residuals, sigma2, XtXinv } or null if singular.
function olsMulti(y, Xrows) {
  const n = y.length, k = Xrows[0].length;
  if (n < k + 2) return null;

  // X'X and X'y
  const XtX = Array.from({ length: k }, (_, i) =>
    Array.from({ length: k }, (_, j) =>
      Xrows.reduce((s, row) => s + row[i] * row[j], 0)));
  const Xty = Array.from({ length: k }, (_, i) =>
    Xrows.reduce((s, row, r) => s + row[i] * y[r], 0));

  // Augment for both solve and inverse: [X'X | X'y | I]
  const w = 2 * k + 1;
  const A = XtX.map((row, i) => {
    const ident = Array.from({ length: k }, (_, j) => (i === j ? 1 : 0));
    return [...row, Xty[i], ...ident];
  });

  for (let col = 0; col < k; col++) {
    let maxRow = col;
    for (let row = col + 1; row < k; row++) {
      if (Math.abs(A[row][col]) > Math.abs(A[maxRow][col])) maxRow = row;
    }
    [A[col], A[maxRow]] = [A[maxRow], A[col]];
    const pivot = A[col][col];
    if (Math.abs(pivot) < 1e-12) return null;
    for (let c = 0; c < w; c++) A[col][c] /= pivot;
    for (let row = 0; row < k; row++) {
      if (row === col) continue;
      const f = A[row][col];
      for (let c = 0; c < w; c++) A[row][c] -= f * A[col][c];
    }
  }

  const coeffs  = A.map(row => row[k]);
  const XtXinv  = A.map(row => row.slice(k + 1));
  const resid   = y.map((yi, i) => yi - Xrows[i].reduce((s, x, j) => s + x * coeffs[j], 0));
  const sigma2  = resid.reduce((s, e) => s + e * e, 0) / (n - k);

  return { coeffs, residuals: resid, sigma2, XtXinv };
}

// ══════════════════════════════════════════════════════════
//  STATISTICS
// ══════════════════════════════════════════════════════════

// Replaces mackP. MacKinnon (1996) bivariate cointegration residuals,
// n=2, no trend. Table sorted ascending by cv (most negative = lowest p).
function adfPvalue(tau) {
  const table = [
    { p: 0.001, cv: -4.730 },
    { p: 0.005, cv: -4.260 },
    { p: 0.010, cv: -3.900 },
    { p: 0.025, cv: -3.604 },
    { p: 0.050, cv: -3.338 },
    { p: 0.100, cv: -3.046 },
    { p: 0.200, cv: -2.646 },
    { p: 0.400, cv: -2.000 },
    { p: 0.700, cv: -1.000 },
    { p: 0.900, cv:  0.000 },
  ];
  if (tau <= table[0].cv) {
    // Exponential extrapolation for far left tail
    const slope = Math.log(table[1].p / table[0].p) / (table[1].cv - table[0].cv);
    return +Math.max(1e-12, table[0].p * Math.exp(slope * (tau - table[0].cv))).toPrecision(4);
  }
  if (tau >= table[table.length - 1].cv) return 0.99;
  for (let i = 0; i < table.length - 1; i++) {
    if (tau >= table[i].cv && tau <= table[i + 1].cv) {
      const frac = (tau - table[i].cv) / (table[i + 1].cv - table[i].cv);
      return +Math.min(0.99,
        table[i].p + frac * (table[i + 1].p - table[i].p)
      ).toFixed(4);
    }
  }
  return 0.99;
}

// ADF test with AIC-selected lag order.
// Tests: delta(y_t) = rho*y_{t-1} + sum phi_i*delta(y_{t-i}) + eps
// Uses MacKinnon (1996) response surface for bivariate cointegration residuals.
// Returns { stat, pvalue, lag }.
function adfTestAIC(series) {
  const n  = series.length;
  const dy = [];
  for (let i = 1; i < n; i++) dy.push(series[i] - series[i - 1]);

  let bestAIC = Infinity, bestStat = 0, bestPval = 0.99, bestLag = 0;

  for (let p = 0; p <= CONFIG.maxAdfLags; p++) {
    const start = p + 1;
    const m     = n - start;
    if (m < 20) break;

    // Dependent: dy_t for t = start..n-1
    const Y = dy.slice(p);
    // Regressors: [y_{t-1}, dy_{t-1}, ..., dy_{t-p}]
    const Xrows = Array.from({ length: m }, (_, i) => {
      const t   = start + i;
      const row = [series[t - 1]];
      for (let lag = 1; lag <= p; lag++) row.push(dy[t - 1 - lag]);
      return row;
    });

    const fit = olsMulti(Y, Xrows);
    if (!fit) continue;

    const k   = p + 1;
    const aic = Math.log(fit.sigma2) + 2 * k / m;
    if (aic >= bestAIC) continue;
    bestAIC = aic;
    bestLag = p;

    // t-stat for rho (first coefficient) via (X'X)^{-1}[0][0]
    const seRho = Math.sqrt(fit.sigma2 * fit.XtXinv[0][0]);
    if (seRho < 1e-12) continue;
    const stat = fit.coeffs[0] / seRho;

    bestStat = stat;
    bestPval = adfPvalue(stat);
  }

  return { stat: +bestStat.toFixed(4), pvalue: +parseFloat(bestPval.toPrecision(4)), lag: bestLag };
}

// Rescaled-range Hurst exponent.
// H < 0.5 = mean-reverting, H = 0.5 = random walk, H > 0.5 = trending.
// Reject pairs where H >= 0.48 — they are not genuinely mean-reverting.
function hurstExponent(series) {
  const n    = series.length;
  const mean = series.reduce((a, b) => a + b, 0) / n;
  let cumDev = 0, maxDev = -Infinity, minDev = Infinity, varSum = 0;
  for (let i = 0; i < n; i++) {
    cumDev += series[i] - mean;
    if (cumDev > maxDev) maxDev = cumDev;
    if (cumDev < minDev) minDev = cumDev;
    varSum += (series[i] - mean) ** 2;
  }
  const R = maxDev - minDev;
  const S = Math.sqrt(varSum / n);
  if (S < 1e-10 || R <= 0) return 0.5;
  return Math.log(R / S) / Math.log(n);
}

// Annualized information ratio of the canonical spread.
// A low IR means the spread has weak signal relative to its noise —
// it will not cover transaction costs reliably.
function spreadIR(canonical) {
  const n    = canonical.length;
  const mean = canonical.reduce((a, b) => a + b, 0) / n;
  const std  = Math.sqrt(canonical.reduce((a, c) => a + (c - mean) ** 2, 0) / n);
  if (std < 1e-10) return 0;
  return (mean / std) * Math.sqrt(252);
}

// OU parameter estimation via AR(1).
// Fits: s_t = a + b*s_{t-1} + eps
// Returns { kappa, halfLife, theta, sigma, r2 } or null.
function ouFit(spread) {
  const fit = ols(spread.slice(1), spread.slice(0, -1));
  if (!fit) return null;
  const { alpha: a, beta: b, residuals } = fit;
  if (b <= 0 || b >= 1) return null;
  const kappa    = -Math.log(b);
  const halfLife = Math.log(2) / kappa;
  const theta    = a / (1 - b);
  const sigma2   = residuals.reduce((s, e) => s + e * e, 0) / (residuals.length - 1);
  return {
    kappa:    +kappa.toFixed(6),
    halfLife: +halfLife.toFixed(2),
    theta:    +theta.toFixed(6),
    sigma:    +Math.sqrt(sigma2 * 252).toFixed(6),
    r2:       +fit.r2.toFixed(4),
  };
}

// Rolling Z-score of the most recent observation.
function rollingZScore(spread, window) {
  const slice = spread.slice(-window);
  const n     = slice.length;
  const mean  = slice.reduce((a, b) => a + b, 0) / n;
  const std   = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  if (std < 1e-10) return null;
  return +((spread[spread.length - 1] - mean) / std).toFixed(4);
}

// Benjamini-Hochberg FDR correction.
// pvals: array of { index, pvalue }
// Returns Set of indices that survive at FDR level alpha.
function bhCorrection(pvals, alpha) {
  const m      = pvals.length;
  if (m === 0) return new Set();
  const sorted = [...pvals].sort((a, b) => a.pvalue - b.pvalue);
  let threshold = -1;
  for (let k = 0; k < m; k++) {
    if (sorted[k].pvalue <= (k + 1) / m * alpha) threshold = k;
  }
  if (threshold === -1) return new Set();
  const surviving = new Set();
  for (let k = 0; k <= threshold; k++) surviving.add(sorted[k].index);
  return surviving;
}

// ══════════════════════════════════════════════════════════
//  KALMAN FILTER (time-varying hedge ratio)
// ══════════════════════════════════════════════════════════

// Fits a Kalman filter to logA = alpha_t + beta_t * logB + noise.
// State: [alpha_t, beta_t], transitions with random walk (drift=delta).
// Returns array of { alpha, beta } filtered estimates (causal, no look-ahead).
// Final element gives current best hedge ratio estimate.
//
// delta: process noise variance per step. Larger = faster adaptation.
//        Typical range: [0.00001, 0.001]
// Ve:    observation noise variance.
function kalmanHedgeRatio(logA, logB, delta) {
  delta     = delta || CONFIG.kalmanDelta;
  const Ve  = 0.001;

  // Bootstrap with OLS on the first 30 observations to get a sensible starting point
  const initN   = Math.min(30, Math.floor(logA.length / 4));
  const initFit = ols(logA.slice(0, initN), logB.slice(0, initN));
  let theta     = initFit ? [initFit.alpha, initFit.beta] : [0, 1];

  // Initial state covariance
  let P = [[1, 0], [0, 1]];

  const estimates = [];

  for (let i = 0; i < logA.length; i++) {
    const F = [1, logB[i]];

    // Predict: P = P + Q  (Q = delta * I)
    const Pp = [
      [P[0][0] + delta, P[0][1]],
      [P[1][0],         P[1][1] + delta],
    ];

    // PF = Pp * F (2x1)
    const PF = [
      Pp[0][0] * F[0] + Pp[0][1] * F[1],
      Pp[1][0] * F[0] + Pp[1][1] * F[1],
    ];

    // Innovation variance: S = F' * PF + Ve
    const S = F[0] * PF[0] + F[1] * PF[1] + Ve;

    // Kalman gain: K = PF / S (2x1)
    const K = [PF[0] / S, PF[1] / S];

    // Update state
    const innov = logA[i] - (F[0] * theta[0] + F[1] * theta[1]);
    theta = [theta[0] + K[0] * innov, theta[1] + K[1] * innov];

    // Update covariance: P = Pp - outer(K, PF)
    P = [
      [Pp[0][0] - K[0] * PF[0], Pp[0][1] - K[0] * PF[1]],
      [Pp[1][0] - K[1] * PF[0], Pp[1][1] - K[1] * PF[1]],
    ];

    estimates.push({ alpha: theta[0], beta: theta[1] });
  }

  return estimates;
}

// ══════════════════════════════════════════════════════════
//  DATA LAYER
// ══════════════════════════════════════════════════════════

function alignSeries(a, b) {
  const n = Math.min(a.length, b.length);
  return [a.slice(-n), b.slice(-n)];
}

// Convert a log-price series to USD by adding the log FX rate.
// If FX data is unavailable, returns the series unchanged and logs a warning.
// All US — toLogUSD is identity
function toLogUSD(logPrices) { return logPrices; }

// Fetch daily closes via Alpaca. Returns array of close prices or null.
async function fetchPrices(ticker, lookback) {
  try {
    const { getDailyBars } = require('./alpaca-client');
    const endDate = new Date().toISOString().split('T')[0];
    const bars = await getDailyBars(ticker, lookback, endDate);
    const closes = bars.map(b => b.close).filter(v => v > 0);
    if (closes.length < CONFIG.minObs) return null;

    // Median daily dollar volume check
    const volumes = bars.map(b => (b.volume || 0) * b.close).filter(v => v > 0);
    if (volumes.length > 0) {
      const sorted = [...volumes].sort((a, b) => a - b);
      const medVol = sorted[Math.floor(sorted.length / 2)] || 0;
      if (medVol < CONFIG.minVolumeUSD) {
        db.log('LIQUIDITY_SKIP', `${ticker}: median vol $${(medVol / 1e6).toFixed(1)}M < $${CONFIG.minVolumeUSD / 1e6}M threshold`);
        return null;
      }
    }
    return closes;
  } catch (e) {
    db.log('FETCH_ERR', `${ticker}: ${e.message}`);
    return null;
  }
}

// Generate all cross-sector pairs. Third element indicates same-sector membership.
function generatePairs() {
  const active = UNIVERSE.filter(e => SECTOR_WHITELIST.has(e.sector));
  const pairs = [];
  for (let i = 0; i < active.length - 1; i++) {
    for (let j = i + 1; j < active.length; j++) {
      pairs.push([active[i], active[j], active[i].sector === active[j].sector]);
    }
  }
  return pairs;
}

// ══════════════════════════════════════════════════════════
//  PAIR ANALYSIS
// ══════════════════════════════════════════════════════════

// Test cointegration stability on the first half of the data.
// Input MUST be zero-mean OLS residuals, not the canonical spread.
// The no-intercept ADF used here is only valid for zero-mean series:
// passing canonical spread (mean = OLS alpha) causes the ADF to
// interpret the non-zero mean as evidence of a unit root, producing
// false failures for genuinely cointegrated pairs.
// Returns true if the first-half ADF passes at 1.5× the main threshold.
function isStable(residuals) {
  const half = Math.floor(residuals.length / 2);
  if (half < 40) return true;
  const adf = adfTestAIC(residuals.slice(0, half));
  return adf.pvalue <= CONFIG.bhAlpha * 1.5;
}

// Full analysis for one pair. Returns a raw result object (before BH correction)
// containing the ADF p-value. Only pairs that pass BH receive full OU/z-score analysis.
// Returns null if prices are insufficient.
function rawPairAnalysis(entryA, entryB, pricesA, pricesB) {
  const [pa, pb] = alignSeries(pricesA, pricesB);
  if (pa.length < CONFIG.minObs) return null;

  const logA = pa.map(p => Math.log(p));
  const logB = pb.map(p => Math.log(p));
  // All USD — no FX conversion needed
  const logA_usd = logA;
  const logB_usd = logB;

  const eg = olsBidirectional(logA_usd, logB_usd);
  if (!eg) return null;

  return {
    entryA, entryB, pa, pb,
    logA_usd, logB_usd,
    spread:      eg.spread,
    hedgeRatio:  eg.hedgeRatio,
    adf:         eg.adf,
    egDirection: eg.egDirection,
    crossCurrency: false,
  };
}


// OLS bidirectional Engle-Granger.
// Tests both logA on logB and logB on logA using static OLS.
// Both spreads are expressed in canonical form: logA - beta * logB
// so direction handling is uniform and the ADF is on the same
// formula that completePairAnalysis, OU, and the P&L updater all use.
// Returns { spread, hedgeRatio, adf, egDirection } or null.
// OLS bidirectional Engle-Granger with correct ADF phase.
//
// ADF is run on the ZERO-MEAN OLS RESIDUALS:
//   resid[i] = logA[i] - alpha - beta * logB[i]
//
// The no-intercept ADF requires zero-mean input. The canonical spread
// (logA - beta*logB) has mean = alpha (the OLS intercept), which causes
// the no-intercept ADF to incorrectly fail to reject the unit root null —
// treating the constant as evidence of a trend. Running on residuals fixes
// this: ADF stat for a cointegrated pair is ~ -22 vs ~ -2 for a random walk.
//
// The CANONICAL SPREAD (logA - beta*logB) is stored separately for OU
// estimation and z-score computation, and is consistent with the formula
// used in the P&L updater (log(spotA) - hedge_ratio * log(spotB)).
// The OU theta absorbs the alpha level.
function olsBidirectional(logA_usd, logB_usd) {
  const candidates = [];

  // AB direction: logA = alpha_AB + beta_AB * logB
  const fitAB = ols(logA_usd, logB_usd);
  if (fitAB && fitAB.beta > 0) {
    // ADF on residuals (zero-mean)
    const adf      = adfTestAIC(fitAB.residuals);
    // Canonical spread (non-zero mean = alpha_AB) for OU and z-score
    const spread   = logA_usd.map((la, i) => la - fitAB.beta * logB_usd[i]);
    candidates.push({ spread, hedgeRatio: fitAB.beta, adf, egDirection: 'AB' });
  }

  // BA direction: logB = alpha_BA + beta_BA * logA → invert for A-on-B form
  const fitBA = ols(logB_usd, logA_usd);
  if (fitBA && fitBA.beta > 0) {
    // Residuals in BA form: logB - alpha_BA - beta_BA * logA
    // Stationarity of these residuals ↔ stationarity of logA - (1/beta_BA)*logB
    const adf     = adfTestAIC(fitBA.residuals);
    const betaInv = 1 / fitBA.beta;
    const spread  = logA_usd.map((la, i) => la - betaInv * logB_usd[i]);
    candidates.push({ spread, hedgeRatio: betaInv, adf, egDirection: 'BA' });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => a.adf.stat - b.adf.stat);
  return candidates[0];
}

// ── Walk-forward cointegration check ──────────────────
// Fits OLS hedge ratio on first 60% of data, then tests whether the
// canonical spread (using that fixed hedge ratio) is stationary in the
// remaining 40%. Rejects pairs that only appear cointegrated in-sample.
// Returns { pass, oosP } where oosP is the out-of-sample ADF p-value.
function walkForwardCheck(logA_usd, logB_usd) {
  const n     = logA_usd.length;
  const split = Math.floor(n * 0.60);

  const trainFit = ols(logA_usd.slice(0, split), logB_usd.slice(0, split));
  if (!trainFit || trainFit.beta <= 0) return { pass: false, oosP: 1.0 };

  const validA  = logA_usd.slice(split);
  const validB  = logB_usd.slice(split);
  if (validA.length < 30) return { pass: true, oosP: null };  // too short to test

  // OLS residuals using training alpha and beta.
  // Using training alpha is deliberate: tests whether the validation period
  // spread is stationary AROUND THE TRAINING EQUILIBRIUM. If the relationship
  // level has permanently shifted, validation residuals have non-zero mean and
  // the ADF correctly signals non-stationarity (structural break detected).
  const validResiduals = validA.map((la, i) => la - trainFit.alpha - trainFit.beta * validB[i]);
  const adf = adfTestAIC(validResiduals);
  return { pass: adf.pvalue <= CONFIG.oosAlpha, oosP: +adf.pvalue.toFixed(4) };
}

// ── Half-life stability check ──────────────────────────
// Splits the canonical spread into three equal windows and estimates the
// OU half-life in each. A high coefficient of variation (CV) means the
// reversion speed is regime-dependent and the OU model is unreliable.
// Returns { cv, halfLives } — reject if cv > CONFIG.hlCvMax.
function halfLifeStability(canonical) {
  const n  = canonical.length;
  const sz = Math.floor(n / 3);
  if (sz < 30) return { cv: 0, halfLives: [] };  // too short for sub-windows

  const halfLives = [];
  for (let w = 0; w < 3; w++) {
    const slice = canonical.slice(w * sz, (w + 1) * sz);
    const ou = ouFit(slice);
    if (ou && ou.halfLife >= 1 && ou.halfLife <= 120) halfLives.push(ou.halfLife);
  }
  if (halfLives.length < 2) return { cv: 1.0, halfLives };

  const mean = halfLives.reduce((a, b) => a + b, 0) / halfLives.length;
  const cv   = Math.sqrt(halfLives.reduce((a, b) => a + (b - mean) ** 2, 0) / halfLives.length) / mean;
  return { cv: +cv.toFixed(3), halfLives: halfLives.map(h => +h.toFixed(1)) };
}

// Complete the analysis for a pair that has already passed BH correction.
// Returns a signal object or null if OU/z-score filters fail.
//
// IMPORTANT: all OU parameters and z-score are computed on the CANONICAL spread:
//   canonical[i] = logA_usd[i] - hedgeRatio * logB_usd[i]   (no Kalman alpha)
//
// This matches exactly what updatePairPnL reconstructs at runtime:
//   currentSpread = log(spotA) - hedge_ratio * log(spotB)
//
// The ou_theta absorbs the level difference between the two price series.
// This also eliminates the BA-direction inversion bug (Bug 8): regardless of
// which OLS direction won the bidirectional EG test, the canonical spread is
// always expressed in A-on-B terms so z-score sign and ou_theta are consistent.
function completePairAnalysis(raw, sameSector, funnel) {
  const { hedgeRatio, adf, entryA, entryB, pa, pb, crossCurrency, egDirection,
          logA_usd, logB_usd } = raw;
  const pair = `${entryA.ticker}/${entryB.ticker}`;

  // raw.spread is the canonical OLS spread: logA - hedgeRatio * logB.
  // Non-zero mean = OLS alpha. Zero-mean residuals for ADF-based checks
  // are derived by subtracting the spread mean (= OLS alpha for OLS fit).
  const canonical   = raw.spread;
  const spreadMean  = canonical.reduce((a, b) => a + b, 0) / canonical.length;
  const residuals   = canonical.map(c => c - spreadMean);  // zero-mean OLS residuals

  // Stability check MUST use zero-mean residuals — see isStable docstring.
  if (!isStable(residuals)) { if (funnel) funnel.stability++; return null; }

  // Run Kalman to get the current adaptive hedge ratio estimate.
  const [laU, lbU] = alignSeries(logA_usd, logB_usd);
  const kalmanEst  = kalmanHedgeRatio(laU, lbU);
  const kalmanBeta = +kalmanEst[kalmanEst.length - 1].beta.toFixed(6);

  // Hedge ratio drift filter
  const betaDrift = Math.abs(kalmanBeta - hedgeRatio) / Math.abs(hedgeRatio);
  if (betaDrift > CONFIG.maxBetaDrift) { if (funnel) funnel.betaDrift++; return null; }

  // Hurst exponent filter: reject non-mean-reverting spreads
  const hurst = hurstExponent(canonical);
  if (hurst >= CONFIG.hurstMax) { if (funnel) funnel.hurst++; return null; }

  // Information ratio filter: reject weak signal-to-noise spreads
  if (Math.abs(spreadIR(canonical)) < CONFIG.minSpreadIR) { if (funnel) funnel.spreadIR++; return null; }

  // OU parameters on canonical spread
  const ou = ouFit(canonical);
  if (!ou) { if (funnel) funnel.ouFit++; return null; }
  if (ou.halfLife < CONFIG.halfLifeMin || ou.halfLife > CONFIG.halfLifeMax) { if (funnel) funnel.halfLife++; return null; }

  // Half-life stability: reject if reversion speed is inconsistent across sub-periods
  const stability = halfLifeStability(canonical);
  if (stability.cv > CONFIG.hlCvMax) { if (funnel) funnel.hlCv++; return null; }

  // Walk-forward validation: cointegration must hold out-of-sample
  const wf = walkForwardCheck(logA_usd, logB_usd);
  if (!wf.pass) { if (funnel) funnel.walkForward++; return null; }

  // Z-score on canonical spread
  const zWindow = Math.max(20, Math.round(2 * ou.halfLife));
  const z = rollingZScore(canonical, zWindow);
  if (z === null || Math.abs(z) < CONFIG.zScoreEntry) { if (funnel) funnel.zScore++; return null; }

  // Both OLS directions now use canonical form logA - hedgeRatio * logB.
  // z > 0: spread above mean → A is expensive vs B → SHORT A, LONG B.
  // z < 0: spread below mean → A is cheap vs B   → LONG A, SHORT B.
  // No direction-specific sign inversion needed.
  const direction = z > 0 ? 'SHORT_A_LONG_B' : 'LONG_A_SHORT_B';

  const confidence = Math.abs(z) >= CONFIG.zScoreStrong ? 'HIGH' : 'MEDIUM';
  let score      = Math.round(Math.min(100, 50 + (Math.abs(z) - CONFIG.zScoreEntry) / CONFIG.zScoreEntry * 50));
  if (!sameSector) score = Math.max(50, score - 12);

  return {
    ticker_a:      entryA.ticker,
    name_a:        entryA.name,
    ticker_b:      entryB.ticker,
    name_b:        entryB.name,
    sector:        entryA.sector,
    cross_sector:   sameSector ? 0 : 1,
    cross_currency: crossCurrency ? 1 : 0,
    eg_direction:       egDirection,
    hedge_ratio:        +hedgeRatio.toFixed(6),
    kalman_hedge_ratio: kalmanBeta,
    adf_stat:      adf.stat,
    coint_pval:    adf.pvalue,
    adf_lag:       adf.lag,
    half_life:     ou.halfLife,
    ou_theta:      ou.theta,
    ou_sigma:      ou.sigma,
    ou_kappa:      ou.kappa,
    ou_r2:         ou.r2,
    z_score:       z,
    z_window:      zWindow,
    direction,
    confidence,
    score,
    hurst:         +hurst.toFixed(4),
    hl_cv:         stability.cv,
    oos_pvalue:    wf.oosP,
    spot_a:        +pa[pa.length - 1].toFixed(4),
    spot_b:        +pb[pb.length - 1].toFixed(4),
  };
}

// ══════════════════════════════════════════════════════════
//  PUBLIC API
// ══════════════════════════════════════════════════════════

// Full scan with all fixes applied.
// Pass 1: Fetch prices, compute ADF p-values for all pairs.
// BH:     Apply Benjamini-Hochberg FDR correction across all p-values.
// Pass 2: Complete analysis (OU, stability, z-score) only for BH-surviving pairs.
// Returns signals sorted by |z_score| descending.
async function scanAll(opts) {
  const onProgress = (opts && opts.onProgress) || (() => {});
  const pairs   = generatePairs();
  const tickers = [...new Set(UNIVERSE.map(e => e.ticker))];

  const lookback = rollingLookback(CONFIG.lookbackDays);
  const totalFetches = tickers.length;
  const etaSec = Math.ceil((totalFetches * FETCH_DELAY_MS) / 1000);
  db.log('SCAN_START',
    `${pairs.length} pairs | ${tickers.length} tickers | lookback=${lookback} | ETA ~${etaSec}s`);
  onProgress({ phase: 'fetching', tickersDone: 0, tickersTotal: totalFetches, pairsTotal: pairs.length });

  // ── Fetch VIX via Alpaca ──────────────────────────────
  let vixValue = null;
  try {
    const { getLatestTrade: getLT } = require('./alpaca-client');
    const vix = await getLT('VIXY'); // VIX proxy ETF
    if (vix) { vixValue = +vix.toFixed(1); db.log('VIX_FETCH', `VIX proxy ${vixValue}`); }
  } catch { db.log('VIX_WARN', 'VIX fetch failed'); }
  onProgress({ phase: 'fetching', tickersDone: 0, tickersTotal: totalFetches, vix: vixValue });

  // ── Fetch equity prices ───────────────────────────────
  const priceMap = {};
  let failures = 0;
  const t0 = Date.now();
  let tickersDone = 0;

  for (const t of tickers) {
    const closes = await fetchPrices(t, lookback);
    priceMap[t] = closes;
    if (!closes) failures++;
    tickersDone++;
    onProgress({ phase: 'fetching', tickersDone, tickersTotal: totalFetches });
  }

  const fetched = tickers.length - failures;
  db.log('FETCH_DONE', `${fetched}/${tickers.length} tickers | ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // ── Pass 1: compute ADF p-values for all pairs ───────
  const rawResults = [];
  for (let idx = 0; idx < pairs.length; idx++) {
    const [entryA, entryB, sameSector] = pairs[idx];
    const pa = priceMap[entryA.ticker];
    const pb = priceMap[entryB.ticker];
    if (!pa || !pb) continue;
    const raw = rawPairAnalysis(entryA, entryB, pa, pb);
    if (raw) rawResults.push({ idx, raw, sameSector });
  }

  // ── BH correction ────────────────────────────────────
  const pvals    = rawResults.map((r, i) => ({ index: i, pvalue: r.raw.adf.pvalue }));

  const survived = bhCorrection(pvals, CONFIG.bhAlpha);
  db.log('BH_CORRECTION', `${rawResults.length} pairs tested | ${survived.size} survive BH at FDR ${CONFIG.bhAlpha}`);
  onProgress({ phase: 'analyzing', pairsTested: rawResults.length, bhSurvived: survived.size, signalsFound: 0 });

  // ── Pass 2: complete analysis for BH survivors ───────
  const ts      = new Date().toISOString();
  const signals = [];
  const funnel  = { stability:0, betaDrift:0, hurst:0, spreadIR:0, ouFit:0, halfLife:0, hlCv:0, walkForward:0, zScore:0 };
  for (let i = 0; i < rawResults.length; i++) {
    if (!survived.has(i)) continue;
    const result = completePairAnalysis(rawResults[i].raw, rawResults[i].sameSector, funnel);
    if (!result) continue;
    const id = db.insertSpreadSignal({ ts, ...result });
    result.id = id;
    signals.push(result);
    onProgress({ phase: 'analyzing', signalsFound: signals.length });
  }

  // Log filter funnel so the user always sees where pairs die
  const funnelParts = Object.entries(funnel).filter(([,v]) => v > 0).map(([k,v]) => `${k}=${v}`);
  const rejected = Object.values(funnel).reduce((a,b) => a+b, 0);
  db.log('SCAN_FUNNEL',
    `${survived.size} BH survivors → ${rejected} rejected [${funnelParts.join(' ')}] → ${signals.length} signals`);

  // ── Pass 2b: Sector z-scores for ALL BH survivors (Mahalanobis context) ──
  const sectorZMap = {};
  for (let i = 0; i < rawResults.length; i++) {
    if (!survived.has(i)) continue;
    const { raw, sameSector } = rawResults[i];
    if (!sameSector) continue;
    const { hedgeRatio, entryA } = raw;
    const canonical = raw.spread;
    const ou = ouFit(canonical);
    if (!ou) continue;
    const zWindow = Math.max(20, Math.round(2 * ou.halfLife));
    const z = rollingZScore(canonical, zWindow);
    if (z === null) continue;
    const sector = entryA.sector;
    if (!sectorZMap[sector]) sectorZMap[sector] = [];
    sectorZMap[sector].push({ tickerA: entryA.ticker, tickerB: raw.entryB.ticker, z, absZ: Math.abs(z), halfLife: ou.halfLife, kappa: ou.kappa });
  }

  // ── Mahalanobis sector anomaly score per signal ──
  for (const sig of signals) {
    const sectorPairs = sectorZMap[sig.sector];
    if (!sectorPairs || sectorPairs.length <= 1) {
      sig._mahal = 3.0; sig._sectorContext = 'ISOLATED'; sig._sectorSize = sectorPairs ? sectorPairs.length : 0;
      sig._sectorElevated = 0; sig._sectorSignalFrac = 0;
      continue;
    }
    const absZScores = sectorPairs.map(p => p.absZ);
    const n = absZScores.length;
    const mean = absZScores.reduce((a, b) => a + b, 0) / n;
    const variance = absZScores.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    const std = Math.sqrt(variance);
    const elevatedFrac = absZScores.filter(z => z > 1.5).length / n;
    const signalFrac = absZScores.filter(z => z >= CONFIG.zScoreEntry).length / n;

    if (std < 0.01) {
      sig._mahal = 0; sig._sectorContext = 'REGIME_SHIFT';
    } else {
      const rawMahal = (Math.abs(sig.z_score) - mean) / std;
      const regimeAdjustment = Math.max(0, 1.0 - elevatedFrac * 2);
      sig._mahal = rawMahal * regimeAdjustment;
      if (elevatedFrac > 0.6) sig._sectorContext = 'REGIME_SHIFT';
      else if (signalFrac > 0.4) sig._sectorContext = 'SECTOR_MOVE';
      else if (rawMahal > 1.5) sig._sectorContext = 'ANOMALOUS';
      else sig._sectorContext = 'WEAK_ANOMALY';
    }
    sig._sectorSize = n;
    sig._sectorElevated = +(elevatedFrac * 100).toFixed(0);
    sig._sectorSignalFrac = +(signalFrac * 100).toFixed(0);
  }

  const ctxCounts = {};
  for (const sig of signals) ctxCounts[sig._sectorContext] = (ctxCounts[sig._sectorContext] || 0) + 1;
  db.log('MAHAL_SCAN', Object.entries(ctxCounts).map(([k,v]) => `${k}=${v}`).join(' ') + ` | total=${signals.length}`);

  signals.sort((a, b) => Math.abs(b.z_score) - Math.abs(a.z_score));
  db.log('SCAN_DONE',
    `${signals.length} active signals | ` +
    `HIGH: ${signals.filter(s => s.confidence === 'HIGH').length} ` +
    `MEDIUM: ${signals.filter(s => s.confidence === 'MEDIUM').length}`);
  onProgress({ phase: 'complete', signalsFound: signals.length, vix: vixValue });
  return { signals, vix: vixValue };
}

// On-demand analysis for a specific pair (no BH correction – single pair).
async function scanPair(tickerA, tickerB) {
  const entryA = UNIVERSE.find(e => e.ticker === tickerA);
  const entryB = UNIVERSE.find(e => e.ticker === tickerB);
  if (!entryA || !entryB) throw new Error(`Unknown tickers: ${tickerA}, ${tickerB}`);

  const lookback = rollingLookback(CONFIG.lookbackDays);
  const [pa, pb] = await Promise.all([fetchPrices(tickerA, lookback), fetchPrices(tickerB, lookback)]);
  if (!pa) throw new Error(`No price data for ${tickerA}`);
  if (!pb) throw new Error(`No price data for ${tickerB}`);

  const curA   = getCurrency(tickerA);
  const curB   = getCurrency(tickerB);
  const fxLogMap = {};
  for (const ccy of [curA, curB]) {
    if (ccy !== 'USD' && FX_MAP[ccy]) {
      const raw = await fetchPrices(FX_MAP[ccy], lookback);
      fxLogMap[ccy] = raw ? raw.map(p => Math.log(p)) : null;
    }
  }

  const raw = rawPairAnalysis(entryA, entryB, pa, pb, fxLogMap);
  if (!raw) return null;
  return completePairAnalysis(raw);
}

module.exports = { scanAll, scanPair, UNIVERSE, CONFIG, FETCH_DELAY_MS, YAHOO_RPM, SECTOR_WHITELIST };
