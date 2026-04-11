# Hedge Rebalancing Challenge

## The problem

This pairs trading system has a 97.8% z-score reversion rate but only 48% dollar win rate. The gap is the "hedge leak": the OLS beta (hedge ratio) used to size the short leg at entry drifts 163-360% by the time the trade exits. The position becomes structurally wrong — one leg is over/under-hedged.

Currently `shares_a` and `shares_b` are fixed at entry and never adjusted. The Kalman filter computes a live beta at each poll but it's only used for spread/z-score calculation, NOT for adjusting the actual position.

## What needs to change

In `server.js`, function `updatePairPnL`, the P&L computation must account for dynamic hedge rebalancing. When the live Kalman beta changes significantly (>5% from current hedge), the system should:

1. Lock in the B-leg P&L from the last rebalance point
2. Deduct rebalancing transaction costs (bid-ask + slippage on the delta shares)
3. Reset shares_b to match the new beta at current prices
4. Track cumulative realized P&L, unrealized P&L, and rebalancing costs separately

The total P&L becomes: A-leg unrealized + B-leg realized (from all rebalances) + B-leg unrealized (current) - total rebalancing costs.

## Constraints

- The `pos` object persists between polls (it comes from SQLite via `db.getOpenPairPositions()`)
- Runtime state can be stored on the pos object (e.g., `pos._rebal`) — it persists in memory between polls but not across server restarts
- `shares_a` never changes (the A-leg is fixed)
- Only `shares_b` gets rebalanced to track the Kalman beta
- Transaction costs: `CONFIG.costs.bidAskBps + CONFIG.costs.slippageBps` bps per leg
- The Kalman update function `kalmanUpdate(pos, logA, logB)` already exists and returns the current live beta

## Current P&L code to replace

```javascript
// P&L in USD, then convert to EUR
const longA    = pos.direction === 'LONG_A_SHORT_B';
const pnlA_usd = pos.shares_a * (spotA_usd - entryA_usd) * (longA ?  1 : -1);
const pnlB_usd = pos.shares_b * (spotB_usd - entryB_usd) * (longA ? -1 :  1);
const pnlUsd   = pnlA_usd + pnlB_usd;
```

## Deliver

A complete replacement for the P&L block in `updatePairPnL`. Include initialization of any state on `pos`, the rebalancing logic, and the final P&L calculation. The result should be `pnlUsd` (total dollar P&L including rebalancing effects and costs).

The output must be a complete `server.js` file that I can drop in as a replacement.
