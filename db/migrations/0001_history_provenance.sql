-- 0001_history_provenance (2026-11-01). Append-only provenance for V1 composite readings.
-- NOT applied to production by this change. Apply only with owner approval:
--   wrangler d1 execute sentiment-history --remote --file db/migrations/0001_history_provenance.sql
-- Rollback: db/rollback/0001_history_provenance.sql (drops only what this file creates).
-- Additive: the existing history table and every reader of it (V1 and V2) are untouched.
CREATE TABLE IF NOT EXISTS history_provenance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  history_ts INTEGER,                    -- ts of the history row written with it; NULL for a reading not stored (skip_reason)
  received_ts INTEGER NOT NULL,          -- server time the reading arrived
  client_computed_ts INTEGER NOT NULL,   -- client time the composite was computed
  formula_version TEXT NOT NULL,         -- v1-composite-1
  client_score REAL,                     -- composite as computed in the browser
  server_score REAL,                     -- composite recomputed server-side from the recorded inputs
  reproducible INTEGER NOT NULL CHECK (reproducible IN (0, 1)),
  completeness REAL,                     -- share of total base weight that answered
  n_active INTEGER NOT NULL,
  n_missing INTEGER NOT NULL,
  n_freshness_known INTEGER NOT NULL,    -- sources that reported an observation time
  max_source_age_ms INTEGER,             -- oldest source observation relative to client_computed_ts
  weights_version TEXT,
  weights_overridden INTEGER NOT NULL CHECK (weights_overridden IN (0, 1)),
  n_boosted INTEGER NOT NULL,            -- sources with a boost factor other than 1 (e.g. Foufi driver x1.5)
  skip_reason TEXT,                      -- e.g. low_completeness when the reading was not stored in history
  auth_state TEXT NOT NULL CHECK (auth_state IN ('token', 'open')),
  request_id TEXT NOT NULL,
  provenance_json TEXT NOT NULL          -- per source: score, base_weight, confidence, boost, effective_weight_pct, observed_at; missing: id, base_weight, reason
);
CREATE INDEX IF NOT EXISTS idx_history_provenance_history_ts ON history_provenance (history_ts);
CREATE INDEX IF NOT EXISTS idx_history_provenance_received_ts ON history_provenance (received_ts);
CREATE TRIGGER IF NOT EXISTS history_provenance_no_update BEFORE UPDATE ON history_provenance
BEGIN SELECT RAISE(ABORT, 'history_provenance is append-only'); END;
CREATE TRIGGER IF NOT EXISTS history_provenance_no_delete BEFORE DELETE ON history_provenance
BEGIN SELECT RAISE(ABORT, 'history_provenance is append-only'); END;
