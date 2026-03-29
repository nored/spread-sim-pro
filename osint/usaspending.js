'use strict';
const https = require('https');

const TICKER_NAMES = {
  LMT: 'LOCKHEED', RTX: 'RAYTHEON', NOC: 'NORTHROP', GD: 'GENERAL DYNAMICS',
  BA: 'BOEING', LHX: 'L3HARRIS', HII: 'HUNTINGTON', LDOS: 'LEIDOS', SAIC: 'SAIC',
};

async function getRecentLargeAwards(thresholdM = 500) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 8000);
    const cutoff = new Date(Date.now() - 5 * 86400000).toISOString().split('T')[0];
    const body = JSON.stringify({
      filters: {
        award_type_codes: ['A', 'B', 'C', 'D'],
        agencies: [{ type: 'awarding', tier: 'toptier', name: 'Department of Defense' }],
        date_range: { start_date: cutoff },
        award_amounts: [{ lower_bound: thresholdM * 1e6 }],
      },
      fields: ['recipient_name', 'total_obligation'],
      page: 1, limit: 20, sort: 'total_obligation', order: 'desc',
    });

    const req = https.request({
      hostname: 'api.usaspending.gov',
      path: '/api/v2/search/spending_by_award/',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const results = JSON.parse(d)?.results || [];
          const winners = [];
          for (const [ticker, nameFragment] of Object.entries(TICKER_NAMES)) {
            if (results.some(r => (r.recipient_name || '').toUpperCase().includes(nameFragment))) {
              winners.push(ticker);
            }
          }
          resolve({ winners, threshold: thresholdM, cutoffDate: cutoff });
        } catch { resolve(null); }
      });
    });
    req.on('error', () => { clearTimeout(timer); resolve(null); });
    req.write(body);
    req.end();
  });
}

module.exports = { getRecentLargeAwards };
