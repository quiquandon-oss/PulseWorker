#!/usr/bin/env bash
# Local, isolated rehearsal of the V1 release (PulseWorker #2 + #3 + #4): workerd via `wrangler dev --local`, a local
# D1, a random throwaway token that is never printed. Touches no Cloudflare account and no production data.
#   scripts/release-rehearsal.sh [git-ref]      (default: origin/integration/v1-release)
set -euo pipefail
REF="${1:-origin/integration/v1-release}"
WORK="$(mktemp -d)"; trap 'stop 2>/dev/null || true' EXIT
export WRANGLER_SEND_METRICS=false
git archive "$REF" worker.js db | tar -x -C "$WORK"
cd "$WORK"
printf 'name = "v1-local-rehearsal"\nmain = "worker.js"\ncompatibility_date = "2024-11-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "local"\ndatabase_id = "00000000-0000-0000-0000-000000000000"\n' > wrangler.toml
W="npx --yes wrangler@3.114.0"
$W d1 execute DB --local --command "CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, score REAL NOT NULL, technical_score REAL, btc_price REAL, gold_regime TEXT, sources_json TEXT, regime_mag REAL, bottom_score REAL, global_mcap REAL); CREATE TABLE foufi_digest (published_ts INTEGER, transcript_status TEXT, summary_json TEXT)" >/dev/null
TOKEN="$(openssl rand -hex 32)"
PGID=""
start() { cp "$1" .dev.vars; setsid $W dev --local --port 8787 --ip 127.0.0.1 --test-scheduled >>"$WORK/dev.log" 2>&1 < /dev/null & PGID=$!
  for _ in $(seq 60); do curl -s -o /dev/null --noproxy '*' localhost:8787/security-status && return; sleep 1; done; exit 1; }
stop() { [ -n "$PGID" ] && kill -- -"$PGID" 2>/dev/null || true; for _ in $(seq 20); do curl -s -o /dev/null --noproxy '*' localhost:8787/ || return 0; sleep 0.5; done; echo "FAIL dev server did not stop"; exit 1; }
code() { curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "$@"; }
check() { if [ "$2" = "$3" ]; then echo "PASS $1 ($2)"; else echo "FAIL $1: got $2, want $3"; exit 1; fi; }
: > closed.vars; printf 'V1_ACCESS_TOKEN=%s\nHISTORY_PROVENANCE=1\nSERVER_COMPOSITE=1\n' "$TOKEN" > enforced.vars
start closed.vars
check "closed: GET /txs-backup" "$(code localhost:8787/txs-backup)" 503
check "closed: POST /history" "$(code -X POST -H 'Content-Type: application/json' -d '{"score":50}' localhost:8787/history)" 503
check "closed: GET /history (public)" "$(code localhost:8787/history)" 200
stop
for f in db/migrations/0001_history_provenance.sql db/migrations/0002_server_composite.sql db/migrations/0001_history_provenance.sql; do $W d1 execute DB --local --file "$f" >/dev/null; echo "PASS applied $f"; done
start enforced.vars
check "enforced: no token" "$(code localhost:8787/txs-backup)" 401
check "enforced: wrong token" "$(code -H 'X-V1-Token: wrong' localhost:8787/txs-backup)" 401
check "enforced: X-App-Secret not accepted" "$(code -H "X-App-Secret: $TOKEN" localhost:8787/txs-backup)" 401
BODY='{"score":61,"idempotencyKey":"cp:rehearsal-0001","provenance":{"formula_version":"v1-composite-1","computed_at":1793600000000,"sources":[{"id":"fng","score":70,"base_weight":10,"confidence":1,"boost":1},{"id":"foufi","score":30,"base_weight":4,"confidence":0.5,"boost":1.5}],"missing":[{"id":"oil","base_weight":6,"reason":"HTTP 429"}]}}'
check "enforced: POST /history with token" "$(code -X POST -H "X-V1-Token: $TOKEN" -H 'Content-Type: application/json' -d "$BODY" localhost:8787/history)" 200
curl -s --noproxy '*' -X POST -H "X-V1-Token: $TOKEN" -H 'Content-Type: application/json' -d "$BODY" localhost:8787/history | grep -q '"duplicate":true' && echo "PASS retry deduplicated"
check "cron tick" "$(code 'localhost:8787/__scheduled?cron=0+*+*+*+*')" 200
sleep 15; curl -s --noproxy '*' 'localhost:8787/server-composite/status?hours=2' | grep -q '"readings":{"n":1' && echo "PASS collector wrote one reading for the slot"
grep -q "$TOKEN" "$WORK/dev.log" && { echo "FAIL token found in log"; exit 1; } || echo "PASS token absent from logs"
stop
for f in db/rollback/0002_server_composite.sql db/rollback/0001_history_provenance.sql; do $W d1 execute DB --local --file "$f" >/dev/null; echo "PASS rolled back $f"; done
start enforced.vars
curl -s --noproxy '*' localhost:8787/server-composite/status | grep -q 'tables not created' && echo "PASS status reports missing tables after rollback"
check "history still writable after data rollback" "$(code -X POST -H "X-V1-Token: $TOKEN" -H 'Content-Type: application/json' -d '{"score":52}' localhost:8787/history)" 200
stop; echo "REHEARSAL OK"
