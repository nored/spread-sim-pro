'use strict';
// ═══════════════════════════════════════════════════════
//  CFTC Commitment of Traders — direct from CFTC.gov
//
//  No API key needed. CFTC publishes weekly reports as CSV.
//  We fetch the most recent "Disaggregated Futures Only" report
//  and parse positioning for energy, metals, and FX contracts.
//
//  Updated weekly (Tuesday data, released Friday ~3:30 PM ET).
//  Cached for 24 hours to avoid redundant fetches.
// ═══════════════════════════════════════════════════════

const https = require('https');

// Cache: COT data is weekly, no need to re-fetch every 30-min scan cycle
let cache = { ts: 0, data: null };
const CACHE_TTL = 86400000; // 24 hours

// CFTC contract codes we care about → mapped to scanner sectors
const CONTRACTS = {
  'CRUDE OIL, LIGHT SWEET':  'ENERGY',
  'GOLD':                     'MINING',
  'NATURAL GAS':              'ENERGY',
  'AUSTRALIAN DOLLAR':        'FX_COMMODITY',
  'CANADIAN DOLLAR':          'FX_COMMODITY',
  'NEW ZEALAND DOLLAR':       'FX_COMMODITY',
  'EURO FX':                  'FX_MAJOR',
  'BRITISH POUND':            'FX_MAJOR',
  'JAPANESE YEN':             'FX_MAJOR',
  'SWISS FRANC':              'FX_MAJOR',
  'COPPER':                   'MINING',
};

// Try multiple CFTC data sources in order
const CFTC_URLS = [
  'https://www.cftc.gov/dea/newcot/f_disagg.txt',
  'https://www.cftc.gov/dea/newcot/deafut.txt',  // legacy combined format (fallback)
];

function fetchUrl(url) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 15000);
    const proto = url.startsWith('https') ? https : require('http');
    proto.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        fetchUrl(res.headers.location).then(d => { clearTimeout(timer); resolve(d); });
        return;
      }
      if (res.statusCode !== 200) { clearTimeout(timer); resolve(null); return; }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { clearTimeout(timer); resolve(d); });
    }).on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

async function fetchCftcReport() {
  for (const url of CFTC_URLS) {
    const data = await fetchUrl(url);
    if (data && data.length > 500 && !data.includes('<!DOCTYPE')) return data;
  }
  return null;
}

function parseCsvReport(text) {
  if (!text || text.length < 100) return null;
  const lines = text.split('\n');
  if (lines.length < 2) return null;

  // Header line — find column indices
  const header = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
  const idx = {};
  header.forEach((h, i) => idx[h] = i);

  // Key columns (names from CFTC disaggregated format)
  const nameCol   = idx['Market_and_Exchange_Names'] ?? idx['Market and Exchange Names'] ?? 0;
  const dateCol   = idx['Report_Date_as_YYYY-MM-DD'] ?? idx['As of Date in Form YYYY-MM-DD'] ?? 1;
  const oiCol     = idx['Open_Interest_All'] ?? idx['Open Interest (All)'] ?? null;
  const pmLong    = idx['Prod_Merc_Positions_Long_All'] ?? null;    // Producer/Merchant long
  const pmShort   = idx['Prod_Merc_Positions_Short_All'] ?? null;   // Producer/Merchant short
  const mmLong    = idx['M_Money_Positions_Long_All'] ?? null;      // Managed Money long
  const mmShort   = idx['M_Money_Positions_Short_All'] ?? null;     // Managed Money short

  const results = {};
  // Find latest date first
  let latestDate = '';
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/"/g, ''));
    if (cols.length < 5) continue;
    const date = cols[dateCol] || '';
    if (date > latestDate) latestDate = date;
  }

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/"/g, ''));
    if (cols.length < 5) continue;

    const date = cols[dateCol] || '';
    if (date !== latestDate) continue;  // only latest week

    const name = (cols[nameCol] || '').toUpperCase();

    // Match against our contract list
    for (const [contract, sector] of Object.entries(CONTRACTS)) {
      if (!name.includes(contract)) continue;

      const oi    = parseInt(cols[oiCol]) || 0;
      const mml   = mmLong  !== null ? parseInt(cols[mmLong])  || 0 : 0;
      const mms   = mmShort !== null ? parseInt(cols[mmShort]) || 0 : 0;
      const net   = mml - mms;
      const netPct = oi > 0 ? +(net / oi * 100).toFixed(2) : 0;

      // Keep the one with highest OI if multiple matches (e.g. NYMEX vs ICE crude)
      if (!results[sector] || oi > results[sector].openInterest) {
        results[sector] = {
          contract: contract,
          date,
          netSpeculative: net,
          netPct,
          openInterest: oi,
          crowded: Math.abs(netPct) > 25,
          direction: net > 0 ? 'LONG' : 'SHORT',
        };
      }
      break;
    }
  }

  return Object.keys(results).length > 0 ? results : null;
}

async function getCotPositioning() {
  // Return cache if fresh
  if (cache.data && Date.now() - cache.ts < CACHE_TTL) return cache.data;

  const text = await fetchCftcReport();
  const data = parseCsvReport(text);

  if (data) {
    cache = { ts: Date.now(), data };
  }
  return data;
}

module.exports = { getCotPositioning, CONTRACTS };
