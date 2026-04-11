'use strict';
// ═══════════════════════════════════════════════════════
//  alpaca-client.js — Alpaca Markets data + trading API
//
//  Replaces all Yahoo Finance calls. Used by scanner.js,
//  server.js, market-potential.js, backtest-potential.js.
//
//  Env: ALPACA_KEY_ID, ALPACA_SECRET
// ═══════════════════════════════════════════════════════

const KEY = process.env.ALPACA_KEY_ID;
const SECRET = process.env.ALPACA_SECRET;
const DATA_URL = 'https://data.alpaca.markets/v2';
const PAPER_URL = 'https://paper-api.alpaca.markets/v2';

const DELAY_MS = 350; // 200 req/min free tier
const delay = ms => new Promise(r => setTimeout(r, ms));

async function alpacaFetch(url) {
  const resp = await fetch(url, {
    headers: {
      'APCA-API-KEY-ID': KEY,
      'APCA-API-SECRET-KEY': SECRET,
    },
  });
  if (!resp.ok) throw new Error(`Alpaca ${resp.status}: ${resp.statusText}`);
  return resp.json();
}

async function getDailyBars(symbol, startDate, endDate) {
  const bars = [];
  let pageToken = null;
  do {
    let url = `${DATA_URL}/stocks/${symbol}/bars?timeframe=1Day&start=${startDate}&end=${endDate}&limit=10000&adjustment=split&feed=iex`;
    if (pageToken) url += `&page_token=${pageToken}`;
    const data = await alpacaFetch(url);
    if (data.bars) {
      for (const bar of data.bars) {
        bars.push({ date: bar.t.split('T')[0], close: bar.c, volume: bar.v });
      }
    }
    pageToken = data.next_page_token || null;
  } while (pageToken);
  return bars.sort((a, b) => a.date.localeCompare(b.date));
}

async function getLatestQuote(symbol) {
  const data = await alpacaFetch(`${DATA_URL}/stocks/${symbol}/quotes/latest?feed=iex`);
  if (!data.quote) return null;
  const mid = (data.quote.bp + data.quote.ap) / 2;
  return mid > 0 ? mid : null;
}

async function getLatestTrade(symbol) {
  const data = await alpacaFetch(`${DATA_URL}/stocks/${symbol}/trades/latest?feed=iex`);
  return data.trade ? data.trade.p : null;
}

async function getAllDailyBars(symbols, startDate, endDate) {
  const priceMap = {};
  let done = 0;
  for (const sym of symbols) {
    try {
      const bars = await getDailyBars(sym, startDate, endDate);
      if (bars.length >= 120) priceMap[sym] = bars;
    } catch {}
    done++;
    if (done % 20 === 0) process.stdout.write(`  ${done}/${symbols.length}\r`);
    await delay(DELAY_MS);
  }
  console.log(`Fetched ${Object.keys(priceMap).length}/${symbols.length} symbols\n`);
  return priceMap;
}

async function getAccount() {
  return alpacaFetch(`${PAPER_URL}/account`);
}

module.exports = { getDailyBars, getLatestQuote, getLatestTrade, getAllDailyBars, getAccount, DELAY_MS };
