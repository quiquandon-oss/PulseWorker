-- Rollback of 0002_server_composite. Unset SERVER_COMPOSITE first, export the tables, then (owner approval):
--   wrangler d1 execute sentiment-history --remote --file db/rollback/0002_server_composite.sql
DROP TRIGGER IF EXISTS server_composite_readings_no_delete;
DROP TRIGGER IF EXISTS server_composite_readings_no_update;
DROP TRIGGER IF EXISTS server_source_observations_no_delete;
DROP TRIGGER IF EXISTS server_source_observations_no_update;
DROP TABLE IF EXISTS server_composite_readings;
DROP TABLE IF EXISTS server_source_observations;
