-- Ticker universe reconcile: add enrichment-gate + stable-identity columns to
-- public.assets, and grant service_role INSERT so the daily reconcile can upsert
-- newly-listed symbols.
--
-- Columns (both nullable, populated opportunistically by runUniverseReconcile):
--   reference_updated_utc — Massive's per-row last_updated_utc; the enrichment
--     gate (re-enrich only when the incoming value is newer than what we stored).
--   composite_figi        — Massive's per-row composite_figi; captured now for a
--     future symbol-reuse / stable-identity defense (v1 still keys on symbol).
--
-- Grants: the reconcile upserts new rows, so service_role needs INSERT in
-- addition to its existing SELECT, UPDATE on public.assets (prod currently grants
-- only SELECT, UPDATE — every prior write was an UPDATE). The two new columns are
-- session-readable and ride the existing anon/authenticated SELECT grant on the
-- table (column adds inherit table-level grants); no per-column grant is needed.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE public.assets ADD COLUMN reference_updated_utc timestamptz;
ALTER TABLE public.assets ADD COLUMN composite_figi text;

-- service_role must INSERT new listings (it already has SELECT, UPDATE).
GRANT INSERT ON TABLE public.assets TO service_role;

-- Bump schema version (matches EXPECTED_DB_SCHEMA_VERSION in tests).
UPDATE public.app_metadata
SET value = '20260620165957_add_assets_reference_columns'
WHERE key = 'schema_version';
