-- 0002_server_composite (2026-11-01). Server-side V1 sentiment collection (scomp-v1). Additive; append-only.
-- NOT applied to production by this change. Apply only with owner approval:
--   wrangler d1 execute sentiment-history --remote --file db/migrations/0002_server_composite.sql
-- Rollback: db/rollback/0002_server_composite.sql. Independent of 0001 (either can be applied alone).
CREATE TABLE IF NOT EXISTS server_source_observations (
  slot_ts INTEGER NOT NULL,              -- hour slot of the collection run
  source_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'timeout', 'stale', 'unavailable')),
  score REAL CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  observed_at INTEGER,                   -- publisher time when the API gives one, else fetch time (see registry)
  fetched_at INTEGER NOT NULL,
  latency_ms INTEGER,
  attempts INTEGER,
  error TEXT,
  collector_version TEXT NOT NULL,
  PRIMARY KEY (slot_ts, source_id),
  CHECK ((status = 'ok') = (score IS NOT NULL))  -- a failed source never carries a score
);
CREATE TABLE IF NOT EXISTS server_composite_readings (
  slot_ts INTEGER PRIMARY KEY,
  computed_ts INTEGER NOT NULL,
  version TEXT NOT NULL,
  weights_version TEXT NOT NULL,
  composite INTEGER,
  composite_exact REAL,
  completeness REAL NOT NULL,
  below_floor INTEGER NOT NULL CHECK (below_floor IN (0, 1)),
  n_ok INTEGER NOT NULL,
  n_missing INTEGER NOT NULL,
  provenance_json TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS server_source_observations_no_update BEFORE UPDATE ON server_source_observations
BEGIN SELECT RAISE(ABORT, 'server_source_observations is append-only'); END;
CREATE TRIGGER IF NOT EXISTS server_source_observations_no_delete BEFORE DELETE ON server_source_observations
BEGIN SELECT RAISE(ABORT, 'server_source_observations is append-only'); END;
CREATE TRIGGER IF NOT EXISTS server_composite_readings_no_update BEFORE UPDATE ON server_composite_readings
BEGIN SELECT RAISE(ABORT, 'server_composite_readings is append-only'); END;
CREATE TRIGGER IF NOT EXISTS server_composite_readings_no_delete BEFORE DELETE ON server_composite_readings
BEGIN SELECT RAISE(ABORT, 'server_composite_readings is append-only'); END;
