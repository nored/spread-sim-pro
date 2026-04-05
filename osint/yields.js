'use strict';
// ═══════════════════════════════════════════════════════
//  Yield Curve + Credit Regime via Yahoo Finance
//
//  No API key needed. Uses the same Yahoo data source as
//  the scanner. Fetches treasury yields + bond ETF prices
//  to detect regime shifts that break pair relationships.
//
//  ^TNX = 10Y yield, ^FVX = 5Y yield, ^IRX = 13-week bill
//  HYG/LQD ratio = proxy for credit stress (no FRED needed)
// ═══════════════════════════════════════════════════════

const https = require('https');

function yfQuote(ticker) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 8000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`;
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'Accept': 'application/json',
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const meta = JSON.parse(d).chart?.result?.[0]?.meta;
          if (!meta) { resolve(null); return; }
          resolve(meta.regularMarketPrice || meta.chartPreviousClose || null);
        } catch { resolve(null); }
      });
    }).on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

// Staggered fetch to respect Yahoo rate limits
async function fetchWithDelay(tickers) {
  const results = {};
  for (const [key, ticker] of Object.entries(tickers)) {
    results[key] = await yfQuote(ticker);
    await new Promise(r => setTimeout(r, 1200));
  }
  return results;
}

async function getYieldRegime() {
  const data = await fetchWithDelay({
    t10y: '^TNX',   // 10-Year Treasury yield (%)
    t5y:  '^FVX',   // 5-Year Treasury yield (%)
    t13w: '^IRX',   // 13-Week T-Bill yield (%)
    hyg:  'HYG',    // iShares High Yield Bond ETF
    lqd:  'LQD',    // iShares Investment Grade Bond ETF
  });

  const t10y = data.t10y;
  const t5y  = data.t5y;
  const t13w = data.t13w;

  // Approximate 10Y-2Y spread using 10Y - 5Y as a proxy
  // (Yahoo doesn't have a clean 2Y yield ticker)
  // The 10Y - 13-week spread is an even better inversion signal
  const spread10y5y  = (t10y !== null && t5y !== null)  ? +(t10y - t5y).toFixed(3)  : null;
  const spread10y13w = (t10y !== null && t13w !== null) ? +(t10y - t13w).toFixed(3) : null;

  // HYG/LQD ratio as credit stress proxy
  // Normal: ~0.68-0.72. Below 0.65 = stress. Below 0.60 = crisis.
  const hygLqdRatio = (data.hyg && data.lqd) ? +(data.hyg / data.lqd).toFixed(4) : null;

  // Regime scoring
  let score = 0;

  // Curve inversion signals
  if (spread10y13w !== null && spread10y13w < 0)    score += 3;  // deeply inverted
  else if (spread10y13w !== null && spread10y13w < 0.3) score += 1;  // flat
  if (spread10y5y !== null && spread10y5y < 0)      score += 2;  // mid-curve inversion

  // Credit stress via HYG/LQD
  if (hygLqdRatio !== null && hygLqdRatio < 0.62)   score += 3;  // credit crisis
  else if (hygLqdRatio !== null && hygLqdRatio < 0.66) score += 1;  // elevated stress

  return {
    t10y,
    t5y,
    t13w,
    spread10y5y,
    spread10y13w,
    hygLqdRatio,
    score,
    // Banks are driven by the yield curve — flat/inverted = broken spreads
    banksWarning: spread10y13w !== null && spread10y13w < 0.3,
    // Credit stress affects all equity pair relationships
    creditStress: hygLqdRatio !== null && hygLqdRatio < 0.65,
  };
}

module.exports = { getYieldRegime };
