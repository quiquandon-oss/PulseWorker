# Sentiment history: provenance, write token and append-only mode

**Status:** code shipped inert. Nothing changes in production until the owner performs the steps below. No migration
has been applied and no secret or variable has been set.

## What it adds

| Switch | Effect when set | Default (unset) |
|---|---|---|
| `HISTORY_WRITE_TOKEN` (secret) | `POST /history` and `POST /backfill-sources` require the header `X-History-Token`, compared in constant time. It is deliberately not `X-App-Secret`, whose value is embedded in the public V1 page. | Open, as today |
| `HISTORY_PROVENANCE = "1"` (var) | Each composite's inputs are recorded in `history_provenance`, together with a server-side recomputation (formula `v1-composite-1`). Retries are idempotent. Readings skipped for low completeness are recorded with their reason. | Not recorded |
| `HISTORY_APPEND_ONLY = "1"` (var) | `history` is no longer pruned to the latest 500 rows, and `/backfill-sources` (which rewrites stored rows) returns 409. | Pruned to 500, backfill allowed |

**Provenance fields:**
- **Per source:** score, base weight, confidence, boost factor (Foufi driver ×1.5), effective weight %, and
  observation time where the client knows it.
- **Per missing source:** id, base weight and reason.
- **Per reading:**
  - client and server composite, and whether they agree after rounding (`reproducible`);
  - completeness, and counts of active, missing and boosted sources;
  - oldest source age, weights version, and whether weights were overridden;
  - auth state.

**Append-only table:** `history_provenance` is append-only by triggers: UPDATE and DELETE abort.

**Failure handling:** a provenance failure (invalid payload, table missing) never blocks the history write; it is
reported in the response.

**Server-side composite:** this is a server-side *recomputation* from the inputs the browser sends. Collecting the
~20 sources server-side on a fixed schedule is the remaining step (see "Not done"). PEV-1 showed that browser-driven
writes leave 23 gaps over 4.8 h in 22 days.

## Activation (owner, from a computer with wrangler)

1. Back up: `wrangler d1 export sentiment-history --remote --output backup-$(date +%F).sql`
2. Apply the migration (additive; `history` is untouched):
   `wrangler d1 execute sentiment-history --remote --file db/migrations/0001_history_provenance.sql`
3. Verify: `wrangler d1 execute sentiment-history --remote --command "SELECT name FROM sqlite_master WHERE name LIKE '%provenance%'"`
   should list the table, 2 indexes and 2 triggers.
4. Set `HISTORY_PROVENANCE = "1"` (dashboard: Worker → Settings → Variables).
5. Token, optional and separate:
   - **Set the secret:** `wrangler secret put HISTORY_WRITE_TOKEN`.
   - **Enter the same value on each device:** V1 Settings → "History write token".
   - **Order matters:** set the device value first. Devices without it can no longer write history.
   - **Earlier failure:** the 2026-08-11 auth attempt (cc896bb, reverted in ef54a29) failed because the dashboard
     did not store the secret reliably. Use the CLI.
6. Append-only, optional: set `HISTORY_APPEND_ONLY = "1"`.
   - **Effect:** `history` grows by about 10 rows a day. V2's k-NN reads the whole table each run; at this rate D1
     reads stay well within the free plan.

## Rollback

- **Switches:** unset any variable or secret. The behaviour returns to legacy immediately; no deploy is needed.
- **Table:**
  1. Unset `HISTORY_PROVENANCE`.
  2. Export: `wrangler d1 export sentiment-history --remote --table history_provenance --output provenance-backup.sql`.
  3. Run `wrangler d1 execute sentiment-history --remote --file db/rollback/0001_history_provenance.sql`.

**Testing:** the migration and rollback are tested in isolation in `tests/history-provenance.test.js`, against
in-memory SQLite.

**File location:** the files live under `db/`, not `migrations/`, so `wrangler d1 migrations apply` can never pick up
the rollback file as a forward migration.

## Not done

- **Server-side collection** of the composite's sources on a cron. Many sources are browser-fetched today (some use
  CORS proxies and localStorage overrides). Porting them is a multi-source change that needs its own plan.
- **Rows already pruned.** `history` holds only the latest 500 rows. Older readings exist only where V2's Experiment 5
  archive copied them. Nothing is reconstructed here.
