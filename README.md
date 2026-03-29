# spread-sim-pro

Pair Intelligence Scanner for statistical arbitrage via cointegration-based spread trading. Paper trading mode by default, IBKR API ready.

## What it does

Scans 60 equities across 9 sectors (Defense, Energy, Shipping, Commodity, Volatility, Tech, Banks, Infra) for cointegrated pairs. When a pair's spread deviates from equilibrium, it opens a dollar-neutral position and waits for mean reversion.

**Statistical pipeline:**
1. Engle-Granger cointegration test (bidirectional OLS)
2. Benjamini-Hochberg FDR correction across all pairs
3. Kalman-filtered hedge ratio with drift detection
4. Hurst exponent filter (reject non-mean-reverting spreads)
5. Ornstein-Uhlenbeck model fit (half-life, kappa, sigma)
6. Walk-forward out-of-sample validation
7. Half-life stability check across sub-periods
8. Z-score entry trigger with dynamic TP/SL

**OSINT overlay:**
- FRED VIX term structure regime filter
- GDELT defense tension index
- EIA crude inventory signal
- USASpending defense contract filter

## Quick start

```bash
npm install
node server.js
# http://localhost:3000
```

Trigger a scan:
```bash
curl -X POST http://localhost:3000/scan
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CAPITAL` | `5000` | Starting capital in EUR |
| `RISK_PCT` | `0.02` | Max risk per trade (Kelly-capped) |
| `IBKR_PAPER` | `true` | Paper mode (set `false` for live) |
| `FRED_API_KEY` | — | Enable VIX regime filter |
| `EIA_API_KEY` | — | Enable petroleum inventory signal |
| `API_KEY` | — | Protect control endpoints (POST /scan, etc.) |
| `SMTP_FROM` | — | Email alerts sender |
| `SMTP_PASSWORD` | — | Email alerts password |
| `SMTP_TO` | — | Email alerts recipient (defaults to SMTP_FROM) |
| `DRAWDOWN_LIMIT` | `0.15` | Max drawdown before halting new positions |
| `VIX_THRESHOLD` | `25` | Flat VIX fallback threshold |
| `BID_ASK_BPS` | `15` | Bid-ask spread cost assumption |
| `SLIPPAGE_BPS` | `5` | Slippage cost assumption |

## API

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/` | — | Dashboard |
| GET | `/state` | — | Full state JSON |
| GET | `/events` | — | SSE stream |
| GET | `/scan/status` | — | Scan progress |
| GET | `/config` | — | Current config |
| PATCH | `/config` | key | Update runtime config |
| POST | `/scan` | key | Trigger scan |
| POST | `/update` | key | Update pair P&L |
| POST | `/capital/deposit` | key | Add capital |
| POST | `/capital/withdraw` | key | Withdraw capital |

When `API_KEY` is set, control endpoints require `x-api-key` header or `?key=` query param.

## Stack

Node.js, Express, better-sqlite3, yahoo-finance2, vanilla JS dashboard.

## Risk controls

- Paper mode by default
- Max 6 open positions, max 2 per sector
- Drawdown circuit breaker (15% from peak)
- Earnings proximity filter
- Spread correlation gate (prevents correlated positions)
- Time-decaying stop loss (tightens after 1 half-life)
- Kelly-capped position sizing
- Transaction cost modeling (bid-ask + slippage)
