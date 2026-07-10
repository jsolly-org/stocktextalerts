-- Restore Massive's per-row last_updated_utc on public.assets so universe
-- reconcile can gate ticker refreshes (name + icon) on provider watermark
-- advances instead of age-based icon drips.
--
-- Semantics (owned by runUniverseReconcile):
--   - NULL  → bootstrap: stamp from the list feed without a detail probe
--   - set   → full refresh (name/type/icon) only when Massive's
--             last_updated_utc is strictly newer than the stored value
--
-- Column was added in 20260620165957 and dropped in 20260707005431 when the
-- enrichment gate moved to icon_checked_at. Re-adding it for the watermark
-- gate; no backfill — first reconcile after deploy stamps from the list.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE public.assets
  ADD COLUMN IF NOT EXISTS reference_updated_utc timestamptz;

UPDATE public.app_metadata
SET value = '20260710214140_restore_reference_updated_utc'
WHERE key = 'schema_version';
