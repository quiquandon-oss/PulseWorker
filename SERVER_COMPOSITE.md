# Server-side V1 sentiment collection (scomp-v1)

**Why.**
- **Today the V1 composite exists only while a browser has V1 open.** PEV-1 measured 23 gaps longer than 4.8 h in 22
  days, and only 6 of 19 daily units had a reading.
- **The collector fixes that.** It runs on the Worker's existing hourly cron, independent of any browser.
- **It is faithful to the browser.** Each source is scored with a port of the browser's scorer (contract-tested
  against `index.html`), and the result is stored with full provenance.

**Status:** code complete and tested. **Inert**: nothing runs and nothing is written until the owner activates it
(below). It never writes to `history`; feeding V2 from it is a separate decision.

## Source registry (`SCOMP_SOURCE_REGISTRY` in `worker.js`)

| Source | Weight | Collected by the Worker | Notes |
|---|---|---|---|
| fng, funding, longshort, hypefunding, oil, usd, gold, global, onchain | 14, 15, 10, 4, 6, 8, 5, 6, 8 | **yes** (public APIs) | `fng` and `global` carry the publisher's timestamp and are marked stale past 36 h and 2 h respectively. The others are live snapshots stamped at fetch time. |
| cryptonews, macrogeo, geopolitics, regulatory | 15, 8, 10, 12 | **yes** (RSS, the same feeds `/news-proxy` already fetches) | Investing.com's terms for automated RSS polling should be confirmed by the owner. |
| hloi, riskregime, foufi | 4, 4, 6 | **yes** (this Worker's own tables) | Excluded unless status is OK. Foufi is excluded when more than 30 h old. |
| yield10y, nasdaq, sp500 | 5, 6, 6 | only when the `FRED_API_KEY` secret is set | The observation date is recorded. |
| sosovalue | 15 | only when the `SOSO_API_KEY` secret is set | |
| etfflows, ninemag, strc | 10, 8, 5 | **not ported** | `etfflows` depends on the browser ETF panel logic. `ninemag` and `strc` use an unofficial Yahoo endpoint whose terms are unclear. |

**Base-weight coverage** (total base weight 190):
- **Without secrets:** 135 / 190 = **71%**.
- **With both secrets:** 167 / 190 = **88%**.
- The browser rule is preserved: a reading is still stored below the 50% floor, but flagged `below_floor`.

## Behaviour

- **Fetching:** each request has an 8 s timeout. It is retried once on a network error, timeout, 429 or 5xx; a 4xx
  is not retried.
- **Failures:**
  - A failed, stale or unavailable source is recorded with its status and reason.
  - It is excluded, and the remaining weights are renormalised exactly as in the browser.
  - It never gets a score: the table has a CHECK constraint enforcing this.
- **Composite:**
  - It uses the V1 default weights (`SENTIMENT_DEFAULT_WEIGHTS`, mirrored from V1 and tested) and formula
    `v1-composite-1`.
  - **Differences from the browser:**
    - Weights are the defaults, not one device's localStorage overrides.
    - The Foufi driver boost is not applied; `boost_applied: false` is recorded.
    - Gold's competing-haven inversion applies only when nasdaq or sp500 answered in the same run, which is the
      browser's own rule.
- **Idempotency:** one reading per hour slot (`slot_ts` primary key, `INSERT OR IGNORE`), so a re-run of a slot
  writes nothing.
- **Append-only:** triggers block UPDATE and DELETE.
- **Monitoring:** `GET /server-composite/status?hours=168` reports, per source, the ok count, coverage of expected
  slots, the last ok observation and the mean age; for readings, the count, below-floor count and completeness. It is
  read-only and reports "tables not created" when the migration has not been applied.

## Verification done (2026-11-01)

- **Unit and contract tests:** `tests/server-composite.test.js` (14 tests).
  - **Parity with the browser:** the lexicon is identical, and headline scoring matches `scoreHeadline` on a
    600-title fuzz corpus. Funding, long/short, HYPE funding, oil, USD, gold (3 regime contexts), on-chain and
    global give exactly the browser `src*` results.
  - **Failure handling:** timeouts with a retry; 429 retried and 404 not; stale publisher timestamps; failures
    recorded without a score.
  - **Persistence and monitoring:** composite renormalisation, the below-floor flag, slot idempotency, the status
    endpoint, and migration 0002 append-only behaviour and rollback, all in isolation.
- **Live smoke run from the development sandbox** (in-memory database, no production access):
  - **Reached:** the Hyperliquid main and xyz calls. Six sources scored, with fetch latency of 0.2–0.8 s.
  - **Not reached:** the other hosts are blocked by the sandbox's network policy (proxy 403), so their reachability
    *from Cloudflare* is **not yet verified**.
  - **Risk for CoinGecko:** the keyless tier rate-limits by IP, and Workers share egress IPs, so expect occasional
    429s. The status endpoint will show the real rate within 24 h of activation.

## Activation (owner)

1. **Migration:**
   `wrangler d1 execute sentiment-history --remote --file db/migrations/0002_server_composite.sql`. It is additive and
   independent of 0001.
2. **Optional secrets.** `FRED_API_KEY` and `SOSO_API_KEY` add yield10y, nasdaq, sp500 and sosovalue (17% of base
   weight). Without them those sources are recorded as `unavailable` with that reason.
3. **Switch on:** set the variable `SERVER_COMPOSITE = "1"`. The next `0 * * * *` tick collects.
4. **Check after 24 h:** `GET /server-composite/status?hours=24`. Coverage should be at least 0.9 for the public
   sources; any source with low coverage has its error recorded.

## Rollback

- **Stop collecting:** unset `SERVER_COMPOSITE`. No deploy is needed.
- **Remove the tables:** export them, then run `db/rollback/0002_server_composite.sql`.

## Cost (Workers Free plan)

- **Subrequests:** about 15 per hourly run.
- **D1 writes:** 24 per run (23 observations and 1 reading), about 576 a day against the free 100,000 a day.
- **CPU:** headline scoring tokenises each headline instead of running about 120 regexes per headline.
