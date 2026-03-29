'use strict';
const https = require('https');

async function getDefenseTensionIndex() {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 8000);
    // GDELT DOC API: full-text keyword search (actor1countrycode fields are
    // Events API syntax and do not work here — use plain keywords instead)
    const keywords = [
      'NATO', 'military strike', 'missile attack', 'air defense',
      'rearmament', 'defense spending', 'arms deal', 'naval exercise',
      'Ukraine front', 'Taiwan strait', 'conflict escalation',
    ].map(k => `"${k}"`).join(' OR ');
    const url = `https://api.gdeltproject.org/api/v2/doc/doc` +
      `?query=${encodeURIComponent(keywords)}` +
      `&mode=artlist&maxrecords=250&timespan=LAST7DAYS&format=json&sourcelang=English`;

    https.get(url, { headers: { 'User-Agent': 'spread-sim-pro/5.3' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const articles = JSON.parse(d).articles || [];
          // Mean absolute negative tone — higher = more alarming news coverage
          const negTones = articles
            .map(a => parseFloat(a.tone || '0'))
            .filter(t => t < 0)
            .map(t => Math.abs(t));
          const tensionIndex = negTones.length > 0
            ? +(negTones.reduce((s, v) => s + v, 0) / negTones.length).toFixed(2)
            : 0;
          resolve({ tensionIndex, articleCount: articles.length });
        } catch { resolve(null); }
      });
    }).on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

module.exports = { getDefenseTensionIndex };
