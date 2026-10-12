# Risk Regime Shock: V1 composite source `riskregime` (rule `rrs-v1`)

**What it measures:** a broad, abnormal cross-asset move. It is the market component of the Risk Regime Shock research in PulseWorkerV2 (`research/risk_regime_shock.py` and `RISK_REGIME_SHOCK_RESEARCH.md`, branch `claude/sweet-meitner-66ntx8`). It applies the research's own rules and adds the mapping to V1's 0–100 scale.

**What it is not:** a validated predictor. The research verdict was *INSUFFICIENT DATA*, and nothing here claims predictive value.

## Data
- **Source:** Hyperliquid `candleSnapshot`, 1-hour candles. This is the public Info API that V1 already uses for gold, oil, usd and hloi.
- **Instruments:** `xyz:SP500`, `xyz:XYZ100`, `xyz:GOLD`, `xyz:SILVER`, `xyz:COPPER`, `xyz:BRENTOIL`, `xyz:EUR`, `para:10Y`.
- **No look-ahead:** each hour is scored at the top of the hour using only candles that closed before it.
- **Storage:** the hourly cron, or the first `GET /risk-regime` of an hour, stores exactly one row per hour in `risk_regime_readings`. The insert ignores an hour that is already stored, so re-running never duplicates. Retention is 45 days.
- **Audit:** each row keeps the version, status, score, regime and every input (value, percentile, last close time, age, status, vote), plus any rejected inputs and the generation time.

## Rule
1. **Abnormal move.** An instrument is abnormal when its 6-hour return falls outside its own trailing 7-day 5th–95th percentile of 6-hour returns. At least 120 of the 168 hourly baseline points are needed. These are the research's thresholds.
2. **Valid instrument.** A closed candle no more than 2 hours old, and some trading in the last 6 hours. Otherwise the instrument is `STALE` or `INACTIVE` and never counts.
3. **Shock.** At least 3 of the 7 breadth instruments are abnormal. The breadth set is all instruments except `xyz:XYZ100`.
4. **Direction** uses the a-priori "classic risk-off" signs:

   | Instrument | Risk-off direction |
   |---|---|
   | S&P 500, Nasdaq 100 | down |
   | Gold | up |
   | Copper | down |
   | EUR/USD | down |
   | 10Y yield | down |
   | Silver, Brent | none (count for breadth only) |

   Each abnormal directional instrument votes risk-off or risk-on.
5. **Score.** `50 + 40 × (risk-on votes − risk-off votes) / measurable directional instruments`, which ranges from 10 to 90. The winning side must be confirmed by at least 2 asset groups (equity, commodity, fx, rates).

| Case | Status | Score | Used in the composite |
|---|---|---|---|
| No abnormal instrument (`CALM`) or 1–2 only (`ISOLATED`) | OK | 50 (a real "no shock" reading) | yes |
| Shock, but the votes cancel (`MIXED`, contradictory) or the winner rests on one group (`UNCONFIRMED`) | OK | 50 | yes |
| `RISK_OFF_SHOCK` / `RISK_ON_SHOCK` | OK | below / above 50 | yes |
| Underlying markets shut (Fri 21:00 – Sun 22:00 UTC) | `MARKETS_CLOSED` | none | excluded |
| Fewer than 5 breadth instruments measurable | `INSUFFICIENT_DATA` | none | excluded |
| Stored reading older than 2 hours / nothing stored | `STALE` / `NO_DATA` | none | excluded |

A rising risk appetite in one market is never bullish on its own. It takes breadth (3+ abnormal moves) and confirmation across groups. An excluded reading is never replaced by 50, and its weight goes to the other sources through V1's normal renormalisation.

## In V1
- **Composite:** source id `riskregime`, default weight 4 × confidence 0.3. That is the lowest existing tier, the same as hloi, and about 0.9% of effective weight when every source answers.
- **Settings:** the weight and confidence can each be changed. Weight 0 disables the source, and "Reset to defaults" restores 4 × 0.3.
- **Shadow adaptation:** the worker's shadow weight adaptation lists it like every other source (shadow only; applying a proposal stays owner-gated).

**Why so low:**
- Its markets overlap gold, oil, usd, sp500, nasdaq and yield10y. This source tests a joint abnormal move rather than each market's level, but they are the same markets.
- There is no validated evidence for it.

At this weight, its effect on the integer composite is normally below rounding: at most about ±0.3 points at the extremes.

## Limitations
- The GDELT geopolitical component and the GEO × MARKET convergence state are not used, because the research found convergence at chance level.
- Hyperliquid `xyz`/`para` markets are synthetic perpetuals; `para:10Y` is thin.
- Holidays and the daily maintenance break are not modelled.
- The research covered 40 days and found the market component contemporaneous with BTC stress, not leading it.
