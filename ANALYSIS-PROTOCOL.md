# Full Analysis Protocol — Spread Trading System

## System Overview
Pairs/spread trading system. Engle-Granger cointegration + OU model on 105 tickers across 14 sectors. EUR 5,000 starting capital. Paper trading.

## Core Problem
The system ran for a week and made zero trades. After fixing broken filters, the backtest over 24 months (Apr 2024–Apr 2026) is still net negative under every configuration tested.

## What We Know Works (proven by data)

### 1. The Mean-Reversion Signal Is Real
- Gap analysis: using **rolling z-score** (20-bar window), 97.8% of z>2.0 entries revert to z<0.5
- 2,514 reversion events in 12 months across 416 same-sector pairs
- The spread DOES mean-revert. This is not in question.

### 2. The OU Model Z-Score Is Broken
- **Rolling z entry + rolling z exit: 97.8% win rate**
- **OU z entry + OU z exit: 28.4% win rate**
- The OU theta (equilibrium) and sigma (vol) are trained on historical data and drift away from reality
- The live system was using OU z for everything — this was the original catastrophic bug

### 3. Z-Score Reversion ≠ Dollar Profit
- Of 253 backtested trades, **ALL** z-scores reverted (100%)
- But only **48.6%** made actual dollar profit
- **130 trades** had the z-score revert but still lost money ("hedge leak")
- Winners and losers have IDENTICAL entry characteristics (z=2.83 vs 2.84, same beta, halfLife, kappa)
- The only difference: winners hold 8.3 days, losers hold 10.6 days

### 4. Gross P&L Is Positive, Costs Kill It
- Total P&L before costs: **+€1,755** (24 months, 3x leverage)
- Transaction costs: **€1,429** (20bps round-trip per leg)
- Net: **+€327** — barely positive
- Cost per trade averages €5.65, which is 22% of average win (€26.20)

### 5. Sector Performance (12-month signal analysis, 4,064 trades)
```
SHIPPING:     +1.29% avg expectancy (203 trades, 68% WR)
AUTOS:        +0.69% (219 trades, 66% WR)
PHARMA:       +0.66% (262 trades, 71% WR)  ← highest win rate
INFRA:        +0.38% (135 trades, 64% WR)
MINING:       +0.33% (296 trades, 62% WR)
US_BANKS:     +0.32% (233 trades, 69% WR)
FX_COMMODITY: +0.06% (93 trades, 69% WR)
FX_MAJOR:     -0.02% (82 trades, 61% WR)
ENERGY:       -0.25% (936 trades, 66% WR)  ← high WR but negative expectancy
BANKS:        -0.27% (204 trades, 66% WR)
TECH:         -0.32% (226 trades, 62% WR)
DEFENSE:      -0.74% (904 trades, 59% WR)  ← worst sector
COMMODITY:    -1.21% (57 trades, 60% WR)
```

### 6. Hold Time Analysis (most important finding)
```
1-5 days:   77% win rate, +1.48% avg P&L (1,728 trades)
5-10 days:  85% win rate, +1.57% avg P&L (1,075 trades)  ← sweet spot
10-20 days: 35% win rate, -1.44% avg P&L (914 trades)    ← death zone
20-40 days: 11% win rate, -8.33% avg P&L (321 trades)
40+ days:   4% win rate, -22.23% avg P&L (26 trades)
```
NOTE: This was measured on z-score movement, NOT dollar P&L. The dollar P&L doesn't follow this pattern — see "hedge leak" problem above.

### 7. Feature Importance (what predicts winning)
```
Feature            TOP 20%         BOTTOM 20%
|z| at entry       2.1625          2.0093         ← higher z slightly better
half-life (days)   24.2467         24.4094        ← no difference
kappa              0.0421          0.0422         ← no difference
OU R²              0.9182          0.9187         ← no difference
hold days          6.2066         15.9791         ← BIG difference: fast exits win
```

## Fundamental Problems Identified

### Problem 1: Hedge Ratio Imprecision
The OLS beta (hedge ratio) is estimated from training data. During the trade, the actual hedge changes. A spread with beta=0.85 might need beta=0.90 by day 5. The dollar-neutral position drifts, and what looks like a z-score win becomes a P&L loss because one leg moved more than the hedge accounts for.

### Problem 2: Static Parameters in a Dynamic Market
All filters (z-entry, half-life range, hold time, SL/TP) are static thresholds. A z=2.5 entry in a low-vol regime is different from z=2.5 in a high-vol regime. A 10-day hold limit makes no sense for a pair with 7-day half-life vs 18-day half-life. The system needs to adapt to current conditions, not use fixed rules.

### Problem 3: Position Sizing Ignores Signal Quality
The system sizes every position the same (6% of capital). A grade-A signal in PHARMA with z=3.0 and hl=8 gets the same notional as a grade-C signal in ENERGY with z=2.5 and hl=19. Should size proportional to expected edge.

### Problem 4: No Real-Time Hedge Adjustment
Once a position opens, the hedge ratio is frozen. The spread can drift structurally while the system holds a stale hedge. Rolling the hedge (adjusting sharesB during the trade) would reduce the hedge leak.

### Problem 5: Entry Timing
The system scans every 30 minutes and enters at whatever z-score it finds. It doesn't wait for the optimal entry — z might be 2.5 now but 3.0 tomorrow. Patience on entry could dramatically improve the average win.

## Backtest Results Summary (all negative)
| Config | Trades | WR | Return | Note |
|---|---|---|---|---|
| Static filters, OU z, 55d hold | 48 | 69% | -15% | Original |
| Rolling z, 10d cap, 1x | 253 | 49% | -13% | Rolling z fix |
| Rolling z, 10d cap, 3x | 253 | 49% | -28% | Leverage amplifies losses |
| Rolling z, 20d cap, 3x | 239 | 59% | -24% | Longer hold helps WR |
| Scorer + rolling z, 3x | 253 | 49% | -28% | Scorer doesn't help hedge leak |

## What Hasn't Been Tried
1. **Dynamic hedge adjustment** — update beta during the trade based on recent price action
2. **Adaptive hold time** — exit based on spread velocity/acceleration, not fixed days
3. **Signal-proportional sizing** — bet more on high-conviction signals
4. **Regime-conditional entry** — only enter when VIX/credit conditions favor reversion
5. **Intraday data** — the best opportunities revert within hours, not days
6. **Portfolio-level optimization** — select signals that diversify the overall portfolio risk

## File Inventory
- `server.js` — Express server, P&L updater, scanner orchestration
- `scanner.js` — Cointegration analysis, signal generation (105 tickers, 14 sectors)
- `scorer.js` — Data-driven signal quality scorer (bucket-based, 6 features)
- `backtest.js` — Walk-forward backtester with realistic costs
- `backtest-potential.js` — Full potential analysis (z-score movement proxy)
- `analyze-signals.js` — Feature importance and optimal config analysis
- `analyze-gap.js` — Bridge analysis: what breaks between potential and execution
- `signal-analysis.json` — 4,064 labeled signals with full metadata
- `backtest-results.json` — Latest backtest trade-by-trade results
- `scorer-config.json` — Logistic regression weights (deprecated, bucket scorer used now)
- `db.js` — SQLite persistence
- `osint/` — FRED, GDELT, EIA, USASpending, yields, COT, short interest, Telegram

## Key Data Files for Fresh Analysis
- `signal-analysis.json` — 4,064 signals with: sector, z_score, halfLife, kappa, sigma, ouR2, beta, hurst, pnlPct, age, exitReason
- `backtest-results.json` — 253 trades with actual dollar P&L, entry/exit z, hold time
