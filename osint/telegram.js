'use strict';
// ═══════════════════════════════════════════════════════
//  Telegram Alert Module
//
//  Sends trade alerts, scan summaries, and error warnings
//  to the user via Telegram bot.
//
//  Env:
//    TELEGRAM_KEY     — Bot token
//    TELEGRAM_CHAT_ID — Your personal chat ID (send /start to the bot first)
//
//  If either is missing, all sends silently skip.
// ═══════════════════════════════════════════════════════

const https = require('https');

const BOT_TOKEN = process.env.TELEGRAM_KEY     || '';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID || '';

function send(text, parseMode) {
  if (!BOT_TOKEN || !CHAT_ID) return Promise.resolve(false);
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 8000);
    const body = JSON.stringify({
      chat_id:    CHAT_ID,
      text:       text,
      parse_mode: parseMode || 'HTML',
      disable_web_page_preview: true,
    });
    const opts = {
      hostname: 'api.telegram.org',
      path:     `/bot${BOT_TOKEN}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { clearTimeout(timer); resolve(res.statusCode === 200); });
    });
    req.on('error', () => { clearTimeout(timer); resolve(false); });
    req.write(body);
    req.end();
  });
}

// ── Formatted alert types ────────────────────────────

function tradeOpened(sig, notional, phase) {
  return send(
    `<b>PAIR OPENED</b>\n` +
    `${sig.ticker_a} / ${sig.ticker_b}\n` +
    `Sector: ${sig.sector} | ${sig.direction}\n` +
    `Z: ${sig.z_score} | Score: ${sig.score}/100\n` +
    `Half-life: ${sig.half_life}d | Coint p: ${sig.coint_pval}\n` +
    `Notional: \u20AC${notional.toFixed(2)} | Phase: ${phase}`
  );
}

function tradeClosed(pos, exitReason, pnlEur, pnlPct) {
  const icon = pnlEur >= 0 ? '\u2705' : '\u274C';
  return send(
    `${icon} <b>${exitReason}</b>\n` +
    `${pos.ticker_a} / ${pos.ticker_b}\n` +
    `P&L: \u20AC${pnlEur.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct}%)\n` +
    `Z entry: ${pos.z_entry} | Age: ${((Date.now() - new Date(pos.opened_at).getTime()) / 86400000).toFixed(1)}d`
  );
}

function scanSummary(signalCount, decisions, phase, vix) {
  const opened  = decisions.filter(d => d.action === 'OPENED').length;
  const blocked = decisions.filter(d => d.action === 'BLOCKED').length;
  const watching = decisions.filter(d => d.action === 'WATCHING').length;

  // Only send if something happened
  if (opened === 0 && signalCount === 0) return Promise.resolve(false);

  let text = `<b>SCAN COMPLETE</b>\n` +
    `Signals: ${signalCount} | Phase: ${phase}\n`;
  if (vix) text += `VIX: ${vix}\n`;
  if (opened)  text += `Opened: ${opened}\n`;
  if (blocked) text += `Blocked: ${blocked}\n`;
  if (watching) text += `Watching: ${watching}\n`;

  // List opened trades
  for (const d of decisions.filter(d => d.action === 'OPENED')) {
    text += `\n\u2192 ${d.pair} z=${d.z} score=${d.score}`;
  }
  return send(text);
}

function dailySummary(stats, openPositions, phase) {
  let text = `<b>DAILY SUMMARY</b>\n` +
    `Balance: \u20AC${stats.balance.toFixed(2)}\n` +
    `Return: ${stats.totalReturn >= 0 ? '+' : ''}${stats.totalReturn}%\n` +
    `Phase: ${phase}\n` +
    `Open: ${stats.open} | TP: ${stats.tp} | SL: ${stats.sl}\n`;

  if (openPositions.length > 0) {
    text += `\n<b>Open positions:</b>\n`;
    for (const p of openPositions) {
      const latest = p.latest;
      if (latest) {
        text += `${p.ticker_a}/${p.ticker_b} z=${latest.z_current.toFixed(2)} pnl=\u20AC${latest.pnl_eur.toFixed(2)}\n`;
      }
    }
  }
  return send(text);
}

function alert(message) {
  return send(`\u26A0\uFE0F ${message}`);
}

function isConfigured() {
  return !!(BOT_TOKEN && CHAT_ID);
}

module.exports = { send, tradeOpened, tradeClosed, scanSummary, dailySummary, alert, isConfigured };
