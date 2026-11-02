# Release: sentiment evidence collection (PulseWorker #2 + #3, CryptoPulse #6)

**Purpose.** Make V1 sentiment readings reproducible (provenance) and collected on a schedule (server-side collector),
independent of any browser. Model C in PEV-1 could not be evaluated because browser-driven writes left most daily
units without a reading.

**Status.** Not executed. Merging, applying migrations and setting variables are owner actions.

**Rehearsed locally:** every step marked **[rehearsed]** passed in `scripts/rehearse-sentiment-release.sh` (workerd
via `wrangler dev --local` and a local D1; no account and no production data): **28 / 28 checks** on 2026-11-02.

**No dependency on other PRs.** In particular this release needs no token and no secret.

## Order

| Step | Action | Production effect |
|---|---|---|
| 1 | Merge PulseWorker #2, then #3. Each merge deploys through `deploy.yml`. **[rehearsed]** | None: history writes behave exactly as today, responses add `"provenance": {"recorded": false, "reason": "provenance disabled"}`, and the collector does not run. |
| 2 | Merge CryptoPulse #6. | The page sends provenance and an idempotency key; the Worker ignores them until step 4. On a 503 it retries once with the same key. |
| 3 | Back up, then apply the migrations (below). **[rehearsed, including re-apply]** | Adds 3 tables (append-only through triggers); `history` is untouched. |
| 4 | Set `HISTORY_PROVENANCE = 1` and `SERVER_COMPOSITE = 1`. **[rehearsed]** | Provenance is recorded; the hourly cron collects one reading per hour slot. |
| 5 | After 2 h and after 24 h: check the status endpoint. | Read-only. |

### Step 3 commands

```bash
npx wrangler@3 d1 export sentiment-history --remote --output backup-$(date +%F).sql
npx wrangler@3 d1 execute sentiment-history --remote --file db/migrations/0001_history_provenance.sql   # expect: 5 commands executed successfully
npx wrangler@3 d1 execute sentiment-history --remote --file db/migrations/0002_server_composite.sql    # expect: 6 commands executed successfully
npx wrangler@3 d1 execute sentiment-history --remote --command \
  "SELECT type,name FROM sqlite_master WHERE name LIKE '%provenance%' OR name LIKE 'server_%' ORDER BY 1,2"
#   expect: 3 tables, 3 indexes, 6 triggers
```

### Step 4

Cloudflare dashboard → Workers → `sentiment-ff75` → Settings → Variables (plain text):
`HISTORY_PROVENANCE = 1`, `SERVER_COMPOSITE = 1`.

### Step 5: first real-world evidence of source availability

```bash
curl -s "https://sentiment-ff75.quiquandon.workers.dev/server-composite/status?hours=24" \
  | jq '{readings, sources: [.sources[] | {id, n_ok, n, coverage}]}'
```

**Expected:**
- `readings.n` is roughly the number of hours since activation.
- `readings.n_below_floor` is low.

**Per source:**
- `coverage` is the share of expected hourly slots with an ok reading.
- **Expected to work, with indirect production evidence:** Hyperliquid, the RSS feeds and Yahoo. See the table in
  `SERVER_COMPOSITE.md`.
- **First real evidence, either way:** alternative.me (`fng`), CoinGecko (`global`) and mempool.space (`onchain`).

**Sources without credentials:** yield10y, nasdaq, sp500 and sosovalue show `unavailable` with the reason "requires
…_API_KEY secret" unless those secrets exist.

## Rollback **[rehearsed]**

| What | How | Effect |
|---|---|---|
| Behaviour | Unset the two variables. | Immediate. |
| Code | `npx wrangler@3 rollback`, or revert the merge commit. | The previous code runs fine on the migrated database (rehearsed: POST and GET `/history` return 200). |
| Data | Unset the variables, export the tables, then run `db/rollback/0002_server_composite.sql` and `db/rollback/0001_history_provenance.sql`. | The new code reports the missing tables. History writes continue, with the reason "provenance store unavailable" in the response. |

## Optional, separate

- **`HISTORY_APPEND_ONLY = 1`:** stops the 500-row pruning of `history` and refuses `/backfill-sources`. See
  `HISTORY_PROVENANCE.md`.
- **`HISTORY_WRITE_TOKEN`:** opt-in write check for `POST /history`. It is not needed for this release.
