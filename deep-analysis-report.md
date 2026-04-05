
======================================================================
  PROMPT 1 — BETA OSCILLATION DIAGNOSIS
======================================================================

HOW BETA IS COMPUTED:
- Initial OLS beta: fitted on 252 trading days BEFORE trade entry
  Formula: logA = alpha + beta * logB (simple OLS)
  Window: fixed 252-day lookback at entry time

- During the trade: BETA IS NEVER RECOMPUTED
  server.js uses: const beta = pos.kalman_beta ?? pos.hedge_ratio
  This is frozen at entry. The Kalman beta was estimated at scan time
  and never updated during the trade's lifetime.

- The backtest's generate-report.js DOES compute a "currentBeta" for
  diagnostic purposes using a rolling 20-day window, but this is NOT
  used for P&L or exit decisions — it's only logged.

BETA DRIFT COMPUTATION:
  betaDriftPct = ((currentBeta - entryBeta) / entryBeta) * 100
  Where currentBeta = OLS on last 20 bars, entryBeta = OLS at entry

BETA DRIFT DISTRIBUTION AT EXIT:
  Min:    0.0%
  p25:    13.0%
  Median: 50.8%
  p75:    92.2%
  p95:    763.9%
  Max:    3932.5%

MAX BETA DRIFT DURING TRADE:
  Median: 84.8%
  p95:    1104.9%

WIN RATE BY BETA DRIFT AT EXIT:
  Drift <10%      :   596 trades | 49% win | avg -1.192%
  Drift 10-50%    :   702 trades | 72% win | avg 1.532%
  Drift 50-100%   :   734 trades | 54% win | avg -0.083%
  Drift 100-500%  :   379 trades | 54% win | avg -0.380%
  Drift >500%     :   204 trades | 52% win | avg -1.256%

CRITICAL FINDING: Beta is FROZEN at entry. A 252-day OLS window
estimates a long-term relationship, but during a 10-20 day trade,
the actual relationship can shift dramatically. The "hedge leak"
is caused by holding a stale hedge against a moving target.

======================================================================
  PROMPT 2 — TIME_CUT TRADE ANATOMY
======================================================================

TIME_CUT trades: 322 of 2615 (12.3%)

AVERAGE |ROLLING Z| AT SPECIFIC DAYS (TIME_CUT trades):
  Day  5: avg |z| = 1.692 (322 trades)
  Day 10: avg |z| = 1.437 (322 trades)
  Day 15: avg |z| = 1.344 (322 trades)
  Day 20: avg |z| = 1.412 (322 trades)

MISSED EXIT WINDOW (P&L went positive then turned negative):
  172 of 322 TIME_CUT trades (53.4%)
  Avg peak P&L before reversal: +1.458%
  Max peak P&L missed: +7.192%

Z DIRECTION IN LAST 5 DAYS BEFORE TIME_CUT:
  Moving toward zero (reverting): 156 (48%)
  Moving away (diverging): 166 (52%)

======================================================================
  PROMPT 3 — PAIR ADMISSION FILTER ANALYSIS
======================================================================

ENERGY:
  Unique pairs: 64
  Total trades: 587
  OLS R² distribution: min=0.000 p25=0.097 med=0.274 p75=0.513 max=0.865
  Half-life distribution: min=4.2 med=14.8 max=56.3
  Win rate by R² bucket:
    R² <0.3    :  299 trades | 59% win | avg -0.291%
    R² 0.3-0.5 :  122 trades | 57% win | avg -1.204%
    R² 0.5-0.7 :   97 trades | 70% win | avg 1.173%
    R² 0.7+    :   69 trades | 48% win | avg -1.007%
  If R² threshold raised to 0.5:
    Kept: 166 trades (28%) | WR 61%
    Cut:  421 trades (72%) | WR 58%

DEFENSE:
  Unique pairs: 64
  Total trades: 626
  OLS R² distribution: min=0.000 p25=0.042 med=0.296 p75=0.564 max=0.973
  Half-life distribution: min=6.0 med=28.7 max=78.9
  Win rate by R² bucket:
    R² <0.3    :  318 trades | 55% win | avg -0.313%
    R² 0.3-0.5 :  126 trades | 49% win | avg -0.780%
    R² 0.5-0.7 :   72 trades | 65% win | avg -0.521%
    R² 0.7+    :  110 trades | 57% win | avg -0.291%
  If R² threshold raised to 0.5:
    Kept: 182 trades (29%) | WR 60%
    Cut:  444 trades (71%) | WR 54%

======================================================================
  PROMPT 4 — CURRENT EXIT LOGIC
======================================================================

EXIT CONDITIONS IN server.js (updatePairPnL):

1. TAKE_PROFIT: |zCurrent| <= pos.tp_z
   - tp_z = max(0.3, |z_entry| * 0.15)  [AGGRESSIVE phase]
   - Uses OU z-score: (currentSpread - equilibrium) / ouStd
   - equilibrium = rolling mean of last 20 spread values (or ou_theta if <5 history)

2. STOP_LOSS: |zCurrent| >= dynamicSL
   - dynamicSL = sl_z * max(0.70, 1 - 0.10 * max(0, ageFraction - 1))
   - sl_z = min(4.0, |z_entry| * 1.30)  [AGGRESSIVE phase]
   - Tightens by 10% per half-life beyond the first, floors at 70%

3. TIME_CUT: ageDays >= CONFIG.scanner.maxHoldDays (currently 10)
   - Hard exit regardless of z-score or P&L

4. TIMEOUT: ageDays >= 3 * pos.half_life
   - Legacy fallback, rarely triggers because TIME_CUT is usually shorter

WHAT'S MISSING:
- NO spread velocity check (rate of z change)
- NO P&L deterioration check
- NO check for P&L peak then decline (missed exit window)
- NO dynamic TP that adjusts based on how the trade is evolving
- Exit uses OU z in server.js but report analysis uses rolling z
  → These give DIFFERENT answers (gap analysis proved OU z = 28% WR)

EXIT REASON DISTRIBUTION:
  REVERT      :  2238 trades | 66% win | avg 1.525%
  TIME_CUT    :   322 trades | 10% win | avg -9.917%
  STOP        :    55 trades | 9% win | avg -5.742%

======================================================================
  PROMPT 5 — SPREAD VELOCITY ANALYSIS
======================================================================

REVERT trades (2238 trades):
  Last 5 days: avg z-velocity = 0.3330/day (positive = reverting)
  First 5 days: avg z-velocity = 0.2315/day
  Last 5 days stalling (velocity < 0.05): 26%

TIME_CUT trades (322 trades):
  Last 5 days: avg z-velocity = -0.0113/day (positive = reverting)
  First 5 days: avg z-velocity = 0.1216/day
  Last 5 days stalling (velocity < 0.05): 56%

VELOCITY COMPARISON:
  REVERT last 5d velocity:   0.3330/day
  TIME_CUT last 5d velocity: -0.0113/day
  Difference: 0.3443/day

VELOCITY-STALL EXIT RULE TEST:
Rule: exit if |z| velocity < 0.05 for 3 consecutive days
  Would have triggered on: 239 of 322 TIME_CUT trades
  Improved P&L: 169 trades (saved avg 6.219% per trade)
  Made worse:   70 trades (lost avg 2.960% per trade)
  Net benefit:  843.76% total

======================================================================
  SYNTHESIS — WHAT NEEDS TO CHANGE
======================================================================

ROOT CAUSES OF LOSS (in priority order):

1. FROZEN HEDGE RATIO
   Beta is computed once at entry and never updated. Average drift: 236%.
   The position is structurally wrong by exit. This alone explains why
   z-score reversion (97.8%) doesn't translate to P&L (48.6%).
   FIX: Recompute beta daily using a short rolling window. Adjust position
   shares to match the new hedge ratio.

2. OU Z-SCORE FOR EXITS
   The live system (server.js) uses OU z for exit decisions. The gap
   analysis proved OU z has 28% WR vs rolling z at 97.8%. The backtest
   partially fixed this but the live system still uses OU z.
   FIX: Switch server.js exit logic to rolling z-score.

3. NO ADAPTIVE EXIT
   Static TP/SL/time limits. No awareness of whether the trade is
   working (velocity toward zero) or dying (stalling/reversing).
   FIX: Add velocity-based exit. If z is not moving toward zero for
   3 consecutive polls, exit early. Don't wait for TIME_CUT.

4. MISSED EXIT WINDOWS
   Many TIME_CUT trades had positive P&L earlier in the trade that
   reversed before the hard time limit. A trailing stop on P&L or
   z-score would capture these.
   FIX: Add trailing TP — once P&L exceeds +1%, set a floor at 0%.
   Exit if P&L drops below the floor.
