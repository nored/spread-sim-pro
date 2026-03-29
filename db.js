'use strict';
// ═══════════════════════════════════════════════════════
//  db.js  –  SQLite persistence layer  (v2: + capital)
// ═══════════════════════════════════════════════════════

const Database = require('better-sqlite3');
const path     = require('path');

const DB_PATH = path.join(__dirname, 'spreadsim.db');
let   db;

// Capital configuration: set via environment variables or default to safe values.
//   CAPITAL=50000 node server.js    → start with €50,000
//   RISK_PCT=0.01 node server.js    → 1% risk per trade (default 2%)
// These only take effect on first run (when capital table is empty).
// After that, balance is tracked in the DB. Use POST /capital/deposit to add funds.
const STARTING_CAPITAL = parseFloat(process.env.CAPITAL  || '5000');
const MAX_RISK_PCT     = parseFloat(process.env.RISK_PCT  || '0.02');


function init() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS signals (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          TEXT    NOT NULL,
      ticker      TEXT    NOT NULL,
      name        TEXT    NOT NULL,
      sector      TEXT    NOT NULL,
      spot        REAL    NOT NULL,
      direction   TEXT    NOT NULL,
      score       INTEGER NOT NULL,
      rsi         REAL,
      momentum    REAL,
      vol_ratio   REAL,
      traded      INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS positions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id   INTEGER REFERENCES signals(id),
      ticker      TEXT    NOT NULL,
      name        TEXT    NOT NULL,
      direction   TEXT    NOT NULL,
      opened_at   TEXT    NOT NULL,
      closed_at   TEXT,
      status      TEXT    NOT NULL DEFAULT 'OPEN',
      spot_entry  REAL    NOT NULL,
      k_buy       REAL    NOT NULL,
      k_sell      REAL    NOT NULL,
      iv          REAL    NOT NULL,
      debit       REAL    NOT NULL,
      max_profit  REAL    NOT NULL,
      breakeven   REAL    NOT NULL,
      tp_trigger  REAL    NOT NULL,
      sl_trigger  REAL    NOT NULL,
      t_days      INTEGER NOT NULL,
      contracts   INTEGER NOT NULL DEFAULT 1,
      cost_basis  REAL    NOT NULL DEFAULT 0,
      exit_pnl    REAL,
      exit_pnl_eur REAL,
      ibkr_order  TEXT
    );

    CREATE TABLE IF NOT EXISTS pnl_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL REFERENCES positions(id),
      ts          TEXT    NOT NULL,
      spot        REAL    NOT NULL,
      spread_val  REAL    NOT NULL,
      pnl_pct     REAL    NOT NULL,
      pnl_eur     REAL    NOT NULL,
      delta       REAL,
      theta       REAL
    );

    CREATE TABLE IF NOT EXISTS order_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER REFERENCES positions(id),
      ts          TEXT    NOT NULL,
      action      TEXT    NOT NULL,
      ticker      TEXT    NOT NULL,
      strike      REAL    NOT NULL,
      order_type  TEXT    NOT NULL,
      qty         INTEGER NOT NULL,
      status      TEXT    NOT NULL,
      ibkr_id     TEXT,
      fill_price  REAL,
      note        TEXT
    );

    CREATE TABLE IF NOT EXISTS capital (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          TEXT    NOT NULL,
      event       TEXT    NOT NULL,
      position_id INTEGER,
      amount      REAL    NOT NULL,
      balance     REAL    NOT NULL,
      note        TEXT
    );

    CREATE TABLE IF NOT EXISTS event_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          TEXT    NOT NULL,
      event       TEXT    NOT NULL,
      details     TEXT
    );

    CREATE TABLE IF NOT EXISTS spread_signals (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          TEXT    NOT NULL,
      ticker_a    TEXT    NOT NULL,
      name_a      TEXT    NOT NULL,
      ticker_b    TEXT    NOT NULL,
      name_b      TEXT    NOT NULL,
      sector      TEXT    NOT NULL,
      hedge_ratio REAL    NOT NULL,
      adf_stat    REAL    NOT NULL,
      coint_pval  REAL    NOT NULL,
      half_life   REAL    NOT NULL,
      ou_theta    REAL    NOT NULL,
      ou_sigma    REAL    NOT NULL,
      ou_kappa    REAL    NOT NULL,
      ou_r2       REAL    NOT NULL,
      z_score     REAL    NOT NULL,
      z_window    INTEGER NOT NULL,
      direction   TEXT    NOT NULL,
      confidence  TEXT    NOT NULL,
      score       INTEGER NOT NULL,
      spot_a      REAL    NOT NULL,
      spot_b      REAL    NOT NULL,
      hl_cv       REAL,
      oos_pvalue  REAL
    );

    CREATE INDEX IF NOT EXISTS idx_signals_ts       ON signals(ts);
    CREATE INDEX IF NOT EXISTS idx_spread_signals_ts ON spread_signals(ts);
    CREATE INDEX IF NOT EXISTS idx_positions_open   ON positions(status);
    CREATE INDEX IF NOT EXISTS idx_pnl_pos          ON pnl_history(position_id);
    CREATE INDEX IF NOT EXISTS idx_capital_ts       ON capital(ts);

    CREATE TABLE IF NOT EXISTS pair_positions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id     INTEGER REFERENCES spread_signals(id),
      ticker_a      TEXT    NOT NULL,
      ticker_b      TEXT    NOT NULL,
      name_a        TEXT    NOT NULL,
      name_b        TEXT    NOT NULL,
      sector        TEXT    NOT NULL,
      direction     TEXT    NOT NULL,
      opened_at     TEXT    NOT NULL,
      closed_at     TEXT,
      status        TEXT    NOT NULL DEFAULT 'OPEN',
      spot_a_entry  REAL    NOT NULL,
      spot_b_entry  REAL    NOT NULL,
      hedge_ratio   REAL    NOT NULL,
      notional_eur  REAL    NOT NULL,
      shares_a      REAL    NOT NULL,
      shares_b      REAL    NOT NULL,
      z_entry       REAL    NOT NULL,
      half_life     REAL    NOT NULL,
      ou_theta      REAL    NOT NULL,
      ou_sigma      REAL    NOT NULL,
      ou_kappa      REAL    NOT NULL,
      tp_z          REAL    NOT NULL DEFAULT 0.5,
      sl_z          REAL    NOT NULL DEFAULT 4.0,
      exit_pnl_eur  REAL,
      exit_reason   TEXT
    );

    CREATE TABLE IF NOT EXISTS pair_pnl (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id  INTEGER NOT NULL REFERENCES pair_positions(id),
      ts           TEXT    NOT NULL,
      spot_a       REAL    NOT NULL,
      spot_b       REAL    NOT NULL,
      z_current    REAL    NOT NULL,
      pnl_eur      REAL    NOT NULL,
      pnl_pct      REAL    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pair_positions_open ON pair_positions(status);
    CREATE INDEX IF NOT EXISTS idx_pair_pnl_pos        ON pair_pnl(position_id);
  `);

  const existing = db.prepare("SELECT COUNT(*) as n FROM capital").get().n;
  if (existing === 0) {
    db.prepare(`
      INSERT INTO capital (ts,event,position_id,amount,balance,note)
      VALUES (?,?,NULL,?,?,?)
    `).run(new Date().toISOString(), 'INIT', STARTING_CAPITAL, STARTING_CAPITAL, 'Starting capital');
    log('CAPITAL_INIT', `€${STARTING_CAPITAL} starting capital`);
  }

  // Migration: add columns introduced in v5.1 if they don't already exist
  ['hl_cv REAL', 'oos_pvalue REAL'].forEach(col => {
    try { db.exec(`ALTER TABLE spread_signals ADD COLUMN ${col}`); } catch(_) {}
  });

  // Migration: add cross_sector column (Phase 2)
  try { db.exec('ALTER TABLE spread_signals ADD COLUMN cross_sector INTEGER DEFAULT 0'); } catch(_) {}

  // Migration: add Kalman beta columns to pair_positions (v5.2)
  ['kalman_beta REAL', 'kalman_beta_updated_at TEXT'].forEach(col => {
    try { db.exec(`ALTER TABLE pair_positions ADD COLUMN ${col}`); } catch(_) {}
  });

  // Migration: add hurst column to spread_signals
  try { db.exec('ALTER TABLE spread_signals ADD COLUMN hurst REAL'); } catch(_) {}

  // Migration: add fx_ok reliability flag to pair_pnl
  try { db.exec('ALTER TABLE pair_pnl ADD COLUMN fx_ok INTEGER DEFAULT 1'); } catch(_) {}

  log('DB_INIT', `SQLite ready: ${DB_PATH}`);
  return db;
}

// ── Capital ────────────────────────────────────────────
// Returns the original starting capital from the INIT row in the DB.
// This is what was actually seeded, not the current env var value.
// Ensures totalReturn is always calculated correctly after restarts.
function getStartingCapital() {
  const row = db.prepare("SELECT amount FROM capital WHERE event='INIT' LIMIT 1").get();
  return row ? row.amount : STARTING_CAPITAL;
}

function getBalance() {
  const row = db.prepare('SELECT balance FROM capital ORDER BY id DESC LIMIT 1').get();
  return row ? row.balance : STARTING_CAPITAL;
}

function getPeakBalance() {
  const row = db.prepare('SELECT MAX(balance) as peak FROM capital').get();
  return row?.peak ?? getStartingCapital();
}

function getCapitalHistory() {
  return db.prepare('SELECT * FROM capital ORDER BY ts').all();
}

function bookCapital({ event, position_id, amount, note }) {
  const balance = +(getBalance() + amount).toFixed(4);
  db.prepare(`
    INSERT INTO capital (ts,event,position_id,amount,balance,note)
    VALUES (?,?,?,?,?,?)
  `).run(new Date().toISOString(), event, position_id || null, amount, balance, note || '');
  return balance;
}

// (Options signal/position/order helpers removed in v5.2 — tables retained for historical data)

// ── Events ─────────────────────────────────────────────
function log(event, details='') {
  if (!db) return;
  db.prepare('INSERT INTO event_log (ts,event,details) VALUES (?,?,?)')
    .run(new Date().toISOString(), event, String(details));
  console.log(`[${new Date().toISOString().slice(11,19)}] ${event}${details?' – '+details:''}`);
}
function getRecentEvents(n=50) { return db.prepare('SELECT * FROM event_log ORDER BY ts DESC LIMIT ?').all(n); }

// ── Stats ───────────────────────────────────────────────
function getStats() {
  const balance   = getBalance();
  const realized  = db.prepare("SELECT COALESCE(SUM(exit_pnl_eur),0) as v FROM positions WHERE exit_pnl_eur IS NOT NULL").get().v;
  return {
    total:           db.prepare("SELECT COUNT(*) as n FROM positions").get().n,
    open:            db.prepare("SELECT COUNT(*) as n FROM positions WHERE status='OPEN'").get().n,
    tp:              db.prepare("SELECT COUNT(*) as n FROM positions WHERE status='TAKE_PROFIT'").get().n,
    sl:              db.prepare("SELECT COUNT(*) as n FROM positions WHERE status='STOP_LOSS'").get().n,
    avgPnl:          db.prepare("SELECT AVG(exit_pnl) as v FROM positions WHERE exit_pnl IS NOT NULL").get().v,
    signals24:       db.prepare("SELECT COUNT(*) as n FROM signals WHERE ts > datetime('now','-1 day')").get().n,
    balance:         +balance.toFixed(2),
    startingCapital: getStartingCapital(),
    realizedEur:     +realized.toFixed(2),
    totalReturn:     +(((balance - getStartingCapital()) / getStartingCapital()) * 100).toFixed(2),
  };
}


// ── Spread Signals (Cointegration + OU model) ──────────
function insertSpreadSignal(s) {
  return db.prepare(`
    INSERT INTO spread_signals
      (ts,ticker_a,name_a,ticker_b,name_b,sector,
       hedge_ratio,adf_stat,coint_pval,half_life,
       ou_theta,ou_sigma,ou_kappa,ou_r2,
       z_score,z_window,direction,confidence,score,
       spot_a,spot_b,hl_cv,oos_pvalue,cross_sector,hurst)
    VALUES
      (@ts,@ticker_a,@name_a,@ticker_b,@name_b,@sector,
       @hedge_ratio,@adf_stat,@coint_pval,@half_life,
       @ou_theta,@ou_sigma,@ou_kappa,@ou_r2,
       @z_score,@z_window,@direction,@confidence,@score,
       @spot_a,@spot_b,@hl_cv,@oos_pvalue,@cross_sector,@hurst)
  `).run(s).lastInsertRowid;
}
function getRecentSpreadSignals(n = 50) {
  return db.prepare('SELECT * FROM spread_signals ORDER BY ts DESC LIMIT ?').all(n);
}
function getSpreadSignalsBySector(sector, n = 20) {
  return db.prepare(
    'SELECT * FROM spread_signals WHERE sector=? ORDER BY ABS(z_score) DESC LIMIT ?'
  ).all(sector, n);
}


// ── Pair Positions (equity pairs trading) ──────────────
function insertPairPosition(p) {
  return db.prepare(`
    INSERT INTO pair_positions
      (signal_id,ticker_a,ticker_b,name_a,name_b,sector,direction,
       opened_at,status,spot_a_entry,spot_b_entry,hedge_ratio,
       notional_eur,shares_a,shares_b,z_entry,half_life,
       ou_theta,ou_sigma,ou_kappa,tp_z,sl_z,
       kalman_beta,kalman_beta_updated_at)
    VALUES
      (@signal_id,@ticker_a,@ticker_b,@name_a,@name_b,@sector,@direction,
       @opened_at,'OPEN',@spot_a_entry,@spot_b_entry,@hedge_ratio,
       @notional_eur,@shares_a,@shares_b,@z_entry,@half_life,
       @ou_theta,@ou_sigma,@ou_kappa,@tp_z,@sl_z,
       @kalman_beta,@kalman_beta_updated_at)
  `).run(p).lastInsertRowid;
}

function getOpenPairPositions() {
  return db.prepare("SELECT * FROM pair_positions WHERE status='OPEN'").all();
}

function getAllPairPositions() {
  return db.prepare('SELECT * FROM pair_positions ORDER BY opened_at DESC').all();
}

function closePairPosition(id, reason, pnlEur) {
  const pos      = db.prepare('SELECT * FROM pair_positions WHERE id=?').get(id);
  const returned = +(pos.notional_eur + pnlEur).toFixed(4);
  db.prepare('UPDATE pair_positions SET status=?,closed_at=?,exit_pnl_eur=?,exit_reason=? WHERE id=?')
    .run(reason, new Date().toISOString(), pnlEur, reason, id);
  bookCapital({ event: 'PAIR_CLOSE', position_id: id, amount: returned,
    note: `${reason} ${pos.ticker_a}/${pos.ticker_b} ${pnlEur >= 0 ? '+' : ''}${pnlEur.toFixed(2)}` });
  return pnlEur;
}

function insertPairPnl(p) {
  db.prepare(`
    INSERT INTO pair_pnl (position_id,ts,spot_a,spot_b,z_current,pnl_eur,pnl_pct,fx_ok)
    VALUES (@position_id,@ts,@spot_a,@spot_b,@z_current,@pnl_eur,@pnl_pct,@fx_ok)
  `).run(p);
}

function getPairPnlHistory(posId) {
  return db.prepare('SELECT * FROM pair_pnl WHERE position_id=? ORDER BY ts').all(posId);
}

function getRecentSpreadMean(posId, n = 20) {
  const rows = db.prepare(
    'SELECT spot_a, spot_b FROM pair_pnl WHERE position_id=? ORDER BY ts DESC LIMIT ?'
  ).all(posId, n);
  if (rows.length < 5) return null;
  const pos = db.prepare('SELECT hedge_ratio, kalman_beta FROM pair_positions WHERE id=?').get(posId);
  const beta = pos.kalman_beta ?? pos.hedge_ratio;
  const spreads = rows.map(r => Math.log(r.spot_a) - beta * Math.log(r.spot_b));
  return spreads.reduce((a, b) => a + b, 0) / spreads.length;
}

module.exports = {
  init, db: () => db,
  STARTING_CAPITAL, MAX_RISK_PCT,
  getBalance, getPeakBalance, getStartingCapital, getCapitalHistory, bookCapital,
  insertSpreadSignal, getRecentSpreadSignals, getSpreadSignalsBySector,
  insertPairPosition, getOpenPairPositions, getAllPairPositions, closePairPosition,
  insertPairPnl, getPairPnlHistory, getRecentSpreadMean,
  log, getRecentEvents,
  getStats,
};
