'use strict';
const https = require('https');

function fredSeries(seriesId, key) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 5000);
    const url = `https://api.stlouisfed.org/fred/series/observations` +
      `?series_id=${seriesId}&api_key=${key}&file_type=json&limit=3&sort_order=desc`;
    https.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const val = parseFloat(JSON.parse(d).observations?.[0]?.value);
          resolve(isNaN(val) ? null : val);
        } catch { resolve(null); }
      });
    }).on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

async function getRegimeScore() {
  const key = process.env.FRED_API_KEY;
  if (!key) return { score: 0, blocked: false, vix: null, vix3m: null, hyOas: null };

  const [vix, vix3m, hyOas] = await Promise.all([
    fredSeries('VIXCLS', key),
    fredSeries('VXVCLS', key),
    fredSeries('BAMLH0A0HYM2', key),
  ]);

  let score = 0;
  if (vix !== null && vix > 35)    score += 3;
  else if (vix !== null && vix > 25) score += 1;
  if (vix !== null && vix3m !== null && vix > vix3m + 2) score += 2;
  if (hyOas !== null && hyOas > 600) score += 3;
  else if (hyOas !== null && hyOas > 400) score += 1;

  return { score, blocked: score >= 4, vix, vix3m, hyOas };
}

module.exports = { getRegimeScore };
