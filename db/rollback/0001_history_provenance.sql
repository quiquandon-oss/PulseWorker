-- Rollback of 0001_history_provenance. Destroys the recorded provenance: export it first
--   wrangler d1 export sentiment-history --remote --table history_provenance --output provenance-backup.sql
-- then, with owner approval:
--   wrangler d1 execute sentiment-history --remote --file db/rollback/0001_history_provenance.sql
-- Set HISTORY_PROVENANCE to anything but "1" BEFORE rolling back; the Worker then stops writing provenance.
DROP TRIGGER IF EXISTS history_provenance_no_delete;
DROP TRIGGER IF EXISTS history_provenance_no_update;
DROP INDEX IF EXISTS idx_history_provenance_received_ts;
DROP INDEX IF EXISTS idx_history_provenance_history_ts;
DROP TABLE IF EXISTS history_provenance;
