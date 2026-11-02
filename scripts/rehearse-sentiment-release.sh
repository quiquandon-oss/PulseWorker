#!/usr/bin/env bash
# Isolated rehearsal of the sentiment-evidence release (PulseWorker #2 history provenance + #3 server-side collector)
# on its own, without any other PR: workerd via `wrangler dev --local` and a local D1. No Cloudflare account, no
# production data, no secrets.
#   scripts/rehearse-sentiment-release.sh [new-ref] [old-ref]   (defaults: origin/feat/server-composite, origin/main)
set -euo pipefail
NEW="${1:-origin/feat/server-composite}"; OLD="${2:-origin/main}"
REPO="$(pwd)"; WORK="$(mktemp -d)"; PGID=""
export WRANGLER_SEND_METRICS=false
W="npx --yes wrangler@3.114.0"
start() { cp "$1" .dev.vars; setsid $W dev --local --port 8787 --ip 127.0.0.1 --test-scheduled >>"$WORK/dev.log" 2>&1 < /dev/null & PGID=$!
  for _ in $(seq 60); do curl -s -o /dev/null --noproxy '*' localhost:8787/history && return; sleep 1; done; echo "FAIL dev server did not start"; exit 1; }
stop() { [ -n "$PGID" ] && kill -- -"$PGID" 2>/dev/null || true; for _ in $(seq 20); do curl -s -o /dev/null --noproxy '*' localhost:8787/ || return 0; sleep 0.5; done; echo "FAIL dev server did not stop"; exit 1; }
trap 'stop 2>/dev/null || true' EXIT
code() { curl -s --noproxy '*' -o "$WORK/body" -w '%{http_code}' "$@"; }
check() { if [ "$2" = "$3" ]; then echo "PASS $1 ($2)"; else echo "FAIL $1: got $2, want $3 :: $(head -c 200 "$WORK/body")"; exit 1; fi; }
has() { if grep -q "$2" "$WORK/body"; then echo "PASS $1"; else echo "FAIL $1 :: $(head -c 200 "$WORK/body")"; exit 1; fi; }
use() { git -C "$REPO" show "$1:worker.js" > worker.js; }
cd "$WORK"; git -C "$REPO" archive "$NEW" db | tar -x
printf 'name = "sentiment-release-rehearsal"\nmain = "worker.js"\ncompatibility_date = "2024-11-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "local"\ndatabase_id = "00000000-0000-0000-0000-000000000000"\n' > wrangler.toml
$W d1 execute DB --local --command "CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, score REAL NOT NULL, technical_score REAL, btc_price REAL, gold_regime TEXT, sources_json TEXT, regime_mag REAL, bottom_score REAL, global_mcap REAL); CREATE TABLE foufi_digest (published_ts INTEGER, transcript_status TEXT, summary_json TEXT)" >/dev/null
: > off.vars; printf 'HISTORY_PROVENANCE=1\nSERVER_COMPOSITE=1\n' > on.vars
BODY='{"score":61,"idempotencyKey":"cp:rehearsal-0001","provenance":{"formula_version":"v1-composite-1","computed_at":1793600000000,"sources":[{"id":"fng","score":70,"base_weight":10,"confidence":1,"boost":1},{"id":"foufi","score":30,"base_weight":4,"confidence":0.5,"boost":1.5}],"missing":[{"id":"oil","base_weight":6,"reason":"HTTP 429"}]}}'
post() { code -X POST -H 'Content-Type: application/json' -d "$1" localhost:8787/history; }

echo "== 1. new code deployed, nothing configured: legacy behaviour"
use "$NEW"; start off.vars
check "POST /history (no token needed, as today)" "$(post "$BODY")" 200; has "provenance reported as disabled, not silently dropped" '"provenance disabled"'
check "GET /history" "$(code localhost:8787/history)" 200
check "status endpoint before migration" "$(code localhost:8787/server-composite/status)" 200; has "status says tables not created" 'tables not created'
check "cron tick with collector off" "$(code 'localhost:8787/__scheduled?cron=0+*+*+*+*')" 200
stop; grep -q "Server composite failed" "$WORK/dev.log" && { echo "FAIL collector ran while off"; exit 1; } || echo "PASS collector did not run while SERVER_COMPOSITE is unset"

echo "== 2. migrations (applied twice: idempotent)"
for f in db/migrations/0001_history_provenance.sql db/migrations/0002_server_composite.sql db/migrations/0001_history_provenance.sql db/migrations/0002_server_composite.sql; do $W d1 execute DB --local --file "$f" >/dev/null; echo "PASS applied $f"; done

echo "== 3. switches on"
start on.vars
check "POST /history with provenance" "$(post "$BODY")" 200; has "provenance recorded and reproducible" '"recorded":true,"idempotency_key":"cp:rehearsal-0001","reproducible":true'
check "retry" "$(post "$BODY")" 200; has "retry deduplicated" '"duplicate":true'
check "cron tick" "$(code 'localhost:8787/__scheduled?cron=0+*+*+*+*')" 200
sleep 15; check "status" "$(code 'localhost:8787/server-composite/status?hours=2')" 200; has "one composite reading for the slot" '"readings":{"n":1'
check "second tick in the same hour" "$(code 'localhost:8787/__scheduled?cron=0+*+*+*+*')" 200
sleep 10; code 'localhost:8787/server-composite/status?hours=2' >/dev/null; has "still one reading (slot idempotent)" '"readings":{"n":1'
stop

echo "== 4. code rollback to $OLD on the migrated database"
use "$OLD"; start on.vars
check "old code: POST /history" "$(post '{"score":55}')" 200
check "old code: GET /history" "$(code localhost:8787/history)" 200
stop

echo "== 5. data rollback with the new code"
for f in db/rollback/0002_server_composite.sql db/rollback/0001_history_provenance.sql; do $W d1 execute DB --local --file "$f" >/dev/null; echo "PASS rolled back $f"; done
use "$NEW"; start on.vars
check "status after rollback" "$(code localhost:8787/server-composite/status)" 200; has "status reports missing tables" 'tables not created'
check "history write still works (provenance store unavailable)" "$(post "$BODY")" 200; has "reason reported" 'provenance store unavailable'
stop
echo "REHEARSAL OK"
