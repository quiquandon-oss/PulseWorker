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

| Source | Weight | Collected by the Worker | Reachability from Cloudflare |
|---|---|---|---|
| funding, longshort, hypefunding, oil, usd, gold | 15, 10, 4, 6, 8, 5 | **yes** (Hyperliquid) | **Evidenced (indirect):** this Worker's hourly `hloi` snapshot already calls Hyperliquid in production, and `hloi` appears in 136 / 206 post-seal readings. The same calls also worked from the sandbox and from local workerd. |
| cryptonews, macrogeo, geopolitics, regulatory | 15, 8, 10, 12 | **yes** (the RSS feeds `/news-proxy` fetches) | **Evidenced (indirect):** the page gets these through this Worker's `/news-proxy`, and all four appear in 206 / 206 readings. |
| ninemag, strc | 8, 5 | **yes** (the Yahoo chart call `/stock-proxy` and `/strc-proxy` make) | **Evidenced (indirect):** through those routes, 206 / 206 readings. |
| hloi, riskregime, foufi | 4, 4, 6 | **yes** (this Worker's own tables) | Internal. |
| fng, global, onchain | 14, 6, 8 | **yes** (alternative.me, keyless CoinGecko, mempool.space) | **Not demonstrated:** the page calls these hosts directly, not through the Worker, and the sandbox blocks them. CoinGecko answered only 124 / 206 times even from the browser (rate limits). |
| yield10y, nasdaq, sp500 | 5, 6, 6 | only with the `FRED_API_KEY` secret | FRED is reached through `/macro-proxy` (202–204 / 206). Server-side collection needs the secret. |
| sosovalue | 15 | only with the `SOSO_API_KEY` secret | Not demonstrated from Cloudflare (the page calls it directly). |
| etfflows | 10 | **not ported** | Depends on the browser ETF panel logic. |

**Base-weight coverage** (total 190):
- **Collectable without secrets:** 148 / 190 = **78%**.
- **Of that, upstream reachability from Cloudflare is evidenced for 120 / 190 = 63%.** The rest (fng, global, onchain = 28) is unproven until activation.
- **With the FRED and SoSoValue secrets:** 180 / 190 = **95%**.

**Floor:** below 50% completeness a reading is still stored but flagged `below_floor`, which is the browser rule.

**Evidence basis:** the 206 post-seal V1 readings, by source key only (committed in PulseWorkerV2
`research/evaluations/pev1-inputs`). Where a reading contains a source, the page obtained it through this Worker's
proxy at that time. That is indirect evidence that Cloudflare reaches the upstream, not a test of the collector
itself.

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
