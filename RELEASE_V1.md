# V1 and V2 release checklist (security first)

**Status: not executed.** Every step that touches Cloudflare, a provider account, GitHub merges or production data
needs the owner.

**Rehearsed locally:** the steps marked **[rehearsed]** passed in an isolated `wrangler dev --local` (workerd) run with
a local D1 (`scripts/release-rehearsal.sh`: 18 / 18 checks, 2026-11-02). That run used no account, no production data
and a random throwaway token.

**Never paste secret values into chat, commits, issues or logs.** Every command below reads them from your terminal.

## Order (mandatory)

The V1 gate is **fail-closed**: once PR #4 is deployed, protected routes refuse until the token exists. The order
follows from that.

| Step | What | Who | Reversible |
|---|---|---|---|
| 0 | Prerequisites | owner | — |
| 1 | Rotate the exposed provider credentials | owner (provider dashboards) | new keys only |
| 2 | Set the Worker secrets (before any deploy) | owner (wrangler) | yes |
| 3 | Merge PulseWorker #4, which deploys automatically after tests | owner | yes (rollback) |
| 4 | Verify the gate | anyone | — |
| 5 | Merge CryptoPulse #7; enter the token on each device | owner | yes (revert) |
| 6 | Merge PulseWorker #2 and #3 (Claude updates them onto `main` first) | owner | yes |
| 7 | Back up, then apply migrations 0001 and 0002 | owner | yes (rollback SQL) |
| 8 | Switch on provenance and the collector | owner | yes (unset variables) |
| 9 | Merge CryptoPulse #6 | owner | yes |
| 10 | V2: #113, then #110 (each pauses for the approval-gated deploy) | owner | yes |

### 0. Prerequisites

- **Computer:** one with Node 20+ and `npx wrangler@3` logged in (`npx wrangler@3 whoami` shows the account that owns
  `sentiment-ff75`).
- **Why not the dashboard:** on 2026-08-11 the dashboard failed to store a secret reliably. Use the CLI.
- **Working directory:** a checkout of `quiquandon-oss/PulseWorker` at `main`.

### 1. Rotate the exposed credentials

All four have been public since 2026-08-07 (repository history and GitHub Pages), so revoke the old values.

| Credential | Where | Action |
|---|---|---|
| FRED API key | fredaccount.stlouisfed.org → API Keys | Request a new key, then delete the old one. |
| CoinGecko demo key | CoinGecko developer dashboard → API keys | Create a new key, then delete the old one. |
| SoSoValue API key | SoSoValue account → API | Regenerate the key. |
| DCA alert sheet secret | Google Apps Script project behind `ALERTCONFIG_WRITE_URL` | Change the shared secret the script compares, then Deploy → Manage deployments → new version. The URL can stay. |

`APP_SECRET` needs no rotation: the Worker never enforced it, and it is retired.

### 2. Set the Worker secrets (before step 3)

```bash
umask 077; openssl rand -hex 32 > /tmp/v1token          # 64 hex chars; the gate requires >= 32
npx wrangler@3 secret put V1_ACCESS_TOKEN < /tmp/v1token
npx wrangler@3 secret put FRED_API_KEY                   # paste the NEW key at the prompt
npx wrangler@3 secret put CG_API_KEY
npx wrangler@3 secret put SOSO_API_KEY
# Store the token in your password manager, then:
shred -u /tmp/v1token 2>/dev/null || rm -P /tmp/v1token 2>/dev/null || rm /tmp/v1token
npx wrangler@3 secret list                               # expect the four names (values are never shown)
```

**Expected:** each `put` prints `✨ Success! Uploaded secret …`. The **currently deployed** code ignores these
secrets, so this step changes nothing visible.

### 3. Merge PulseWorker #4

**What happens:** `deploy.yml` now runs `npm test` (117 tests), then `wrangler deploy`.

**Watch:** GitHub → PulseWorker → Actions → "Deploy Worker". Both jobs should be green.

### 4. Verify the gate [rehearsed]

```bash
W=https://sentiment-ff75.quiquandon.workers.dev
curl -s $W/security-status | jq '{route_auth, server_keys}'
#   expect: route_auth "enforced", server_keys all true
curl -s -o /dev/null -w '%{http_code}\n' $W/txs-backup                        # expect 401
curl -s -o /dev/null -w '%{http_code}\n' -H 'X-V1-Token: wrong' $W/txs-backup # expect 401
curl -s -o /dev/null -w '%{http_code}\n' $W/history                           # expect 200 (public read)
curl -s -o /dev/null -w '%{http_code}\n' -H "X-V1-Token: $(cat /path/to/your/token)" $W/txs-backup   # expect 200
```

**If `route_auth` is not "enforced":** the secret is missing or shorter than 32 characters. Every protected route
answers 503. Fix step 2. Nothing is written in this state.

**Between steps 3 and 5:** the V1 page's protected writes (history, portfolio log, transaction backup, AI panels, and
FRED/CoinGecko/SoSoValue data) fail with 401 until #7 is live and the token is entered. Do steps 3–5 together.

### 5. Merge CryptoPulse #7, then enter the token on each device

1. **Merge.** GitHub Pages publishes within about a minute (Actions → "Deploy to GitHub Pages").
2. **On each device:** V1 → Alerts section → **Device access**. Paste the V1 access token (and the new alert sheet
   secret if you use DCA sync), then Save. The status line should read "V1 access token: set on this device".
3. **Check:** reload. Prices and charts load through `/api-proxy`, and portfolio history appears. In the browser
   developer tools, no request goes to `api.coingecko.com`, `openapi.sosovalue.com` or `api.stlouisfed.org`.

### 6. Merge PulseWorker #2, then #3

1. **Ask Claude to bring #2 and #3 up to date with `main`.** The conflict with #4 is in `worker.js`. Its resolution
   is already proven on branch `integration/v1-release`: 151 tests pass and the rehearsal passes.
2. **Merge #2, then #3.** Each merge deploys code that stays inert until step 8.

### 7. Back up, then apply the migrations [rehearsed]

```bash
npx wrangler@3 d1 export sentiment-history --remote --output backup-$(date +%F).sql
npx wrangler@3 d1 execute sentiment-history --remote --file db/migrations/0001_history_provenance.sql
#   expect: 5 commands executed successfully
npx wrangler@3 d1 execute sentiment-history --remote --file db/migrations/0002_server_composite.sql
#   expect: 6 commands executed successfully
npx wrangler@3 d1 execute sentiment-history --remote --command \
  "SELECT type,name FROM sqlite_master WHERE name LIKE '%provenance%' OR name LIKE 'server_%' ORDER BY 1,2"
#   expect: 3 tables, 3 indexes (one is sqlite_autoindex_history_provenance_1), 6 triggers
```

Both migrations are additive and idempotent. The existing `history` table, and every V1 and V2 reader of it, are
untouched.

### 8. Switch on provenance and the collector [rehearsed]

1. **Set the variables:** Cloudflare dashboard → Workers → `sentiment-ff75` → Settings → Variables (plain text):
   `HISTORY_PROVENANCE = 1` and `SERVER_COMPOSITE = 1`. Optionally `HISTORY_APPEND_ONLY = 1`; see
   `HISTORY_PROVENANCE.md` before choosing it.
2. **Check the status page after 2 hours:**
   `curl -s $W/server-composite/status?hours=2 | jq '.readings, [.sources[] | {id, n_ok, n}]'`.
   - **Expect** `readings.n ≥ 1`.
   - **Per source:** `n_ok` shows which sources Cloudflare actually reaches.
   - **This is the first real-world evidence of source availability.** It has not been demonstrated yet: the
     sandbox only reached Hyperliquid.

### 9. Merge CryptoPulse #6

History writes then carry provenance and an idempotency key. The #7 wrapper adds the V1 token to them.

**Check:** `curl -s "$W/server-composite/status"` stays healthy. Within a few minutes of a page visit, the next
browser reading appears in D1 `history_provenance`.

### 10. V2 (PulseWorkerV2)

- **#113 (owner-only operational routes):** merge. `deploy.yml` pauses at the `production` environment; approve it.
  - **Verify:** `curl -s -o /dev/null -w '%{http_code}' https://pulseworker-v2.quiquandon.workers.dev/btc-backfill`
    should return **503**, because `OPS_ADMIN_TOKEN` is unset by design.
- **#110 (prediction integrity):** follow `research/evaluations/2026-11-01-knn-core-v2-release-checklist.md` in that
  PR.
  - **Effect:** it changes production predictions. EXP-002/003 are then stratified by `model_version`.

## Rollback

| Change | Rollback | Rehearsed |
|---|---|---|
| #4 deployed | `npx wrangler@3 rollback` (or dashboard → Deployments → previous version), then revert the merge commit so the next deploy does not re-ship it. **Deleting `V1_ACCESS_TOKEN` does NOT reopen the gate: it closes it.** | code rollback onto the migrated DB: yes |
| #7 published | Revert the merge commit; Pages republishes. **Do not** restore the old keys: they are compromised. | — |
| Migrations | Unset `SERVER_COMPOSITE` and `HISTORY_PROVENANCE`, export the tables, then run `db/rollback/0002_server_composite.sql` and `db/rollback/0001_history_provenance.sql`. | yes: status reports the missing tables, history writes continue, the collector logs and stops |
| Variables | Unset them in the dashboard. Takes effect immediately. | yes |
| V2 #110 / #113 | Revert, then approve the gated deploy. | — |

## Evidence summary

- **Unit tests:**
  - PulseWorker: #4 alone 117, integration (#2 + #3 + #4) 151;
  - CryptoPulse: #7 94, #6 97;
  - PulseWorkerV2: JS 1090–1094, Python 958–960 depending on branch.
- **workerd rehearsal:** the fail-closed state, enforced auth, migrations (with re-apply), the history provenance
  write and retry deduplication, the collector writing one reading per slot, the token absent from logs, and both
  rollbacks.
- **Browser smoke (#7):**
  - no page errors;
  - no direct third-party calls;
  - the token is sent on protected routes only (0 public routes carry it; 0 protected requests lack it).
- **Not demonstrated:** real-world reachability from Cloudflare of alternative.me, CoinGecko, mempool.space and the
  RSS feeds. The sandbox network policy blocks them. Step 8's status endpoint is the first real evidence.
