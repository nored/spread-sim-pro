'use strict';
const https = require('https');

async function getCrudeInventoryChange() {
  const key = process.env.EIA_API_KEY;
  if (!key) return null;

  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 8000);
    const url = `https://api.eia.gov/v2/petroleum/sum/sndw/data/?api_key=${key}` +
      `&frequency=weekly&data[0]=value&facets[series][]=WCESTUS1` +
      `&sort[0][column]=period&sort[0][direction]=desc&length=2`;
    https.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const rows = JSON.parse(d)?.response?.data;
          if (!rows || rows.length < 2) return resolve(null);
          const change = parseFloat(rows[0].value) - parseFloat(rows[1].value);
          resolve({
            changeMMBbl:  +change.toFixed(2),
            latestMMBbl:  +parseFloat(rows[0].value).toFixed(1),
            period:       rows[0].period,
          });
        } catch { resolve(null); }
      });
    }).on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

module.exports = { getCrudeInventoryChange };
