'use strict';
// ═══════════════════════════════════════════════════════
//  Short Interest via yahoo-finance2 (already installed)
//
//  Fetches short % of float and days-to-cover from Yahoo's
//  defaultKeyStatistics module. Cached per scan cycle.
// ═══════════════════════════════════════════════════════

const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

const siCache = new Map();
const CACHE_TTL = 1800000; // 30 min

async function getShortInterest(ticker) {
  // Skip non-US tickers and FX (no FINRA data)
  if (/\.(DE|PA|AS|MI|MC|L|OL|SW)$/.test(ticker) || ticker.includes('=')) return null;

  const cached = siCache.get(ticker);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  try {
    const summary = await yahooFinance.quoteSummary(ticker, {
      modules: ['defaultKeyStatistics'],
    }, { validateResult: false });

    const stats = summary?.defaultKeyStatistics;
    if (!stats) {
      siCache.set(ticker, { ts: Date.now(), data: null });
      return null;
    }

    const data = {
      shortPercentOfFloat: stats.shortPercentOfFloat ?? null,
      shortRatio: stats.shortRatio ?? null,
      sharesShort: stats.sharesShort ?? null,
      dateShortInterest: stats.dateShortInterest
        ? new Date(stats.dateShortInterest * 1000).toISOString().split('T')[0]
        : null,
    };

    siCache.set(ticker, { ts: Date.now(), data });
    return data;
  } catch {
    siCache.set(ticker, { ts: Date.now(), data: null });
    return null;
  }
}

async function checkPairShortInterest(tickerA, tickerB) {
  const [siA, siB] = await Promise.all([
    getShortInterest(tickerA),
    getShortInterest(tickerB),
  ]);

  if (!siA && !siB) return null;

  // Block if either leg has >20% SI of float or >10 days to cover
  const dangerA = (siA?.shortPercentOfFloat > 0.20) || (siA?.shortRatio > 10);
  const dangerB = (siB?.shortPercentOfFloat > 0.20) || (siB?.shortRatio > 10);

  let reason = null;
  if (dangerA) {
    const pct = siA.shortPercentOfFloat ? `${(siA.shortPercentOfFloat * 100).toFixed(1)}%` : '';
    const dtc = siA.shortRatio ? `DTC=${siA.shortRatio.toFixed(1)}` : '';
    reason = `${tickerA} SI ${pct} ${dtc}`.trim();
  } else if (dangerB) {
    const pct = siB.shortPercentOfFloat ? `${(siB.shortPercentOfFloat * 100).toFixed(1)}%` : '';
    const dtc = siB.shortRatio ? `DTC=${siB.shortRatio.toFixed(1)}` : '';
    reason = `${tickerB} SI ${pct} ${dtc}`.trim();
  }

  return {
    tickerA_si: siA,
    tickerB_si: siB,
    blocked: dangerA || dangerB,
    reason,
  };
}

module.exports = { getShortInterest, checkPairShortInterest };
