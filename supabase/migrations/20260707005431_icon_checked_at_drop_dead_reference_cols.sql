-- squawk-ignore-file ban-drop-column
-- Icon enrichment moves to a Finnhub-backed nightly drip keyed on icon_checked_at,
-- and the Massive-era reference columns lose their last readers.
--
-- 1. `icon_checked_at`: stamped when a symbol's logo has been definitively probed
--    (icon found OR confirmed none). Gating the drip on "never checked" instead of
--    "icon is null" fixes the enrichment treadmill where permanently logo-less
--    symbols re-qualified every night and wedged the cap window.
-- 2. Rows that already carry an icon were definitively checked by the old pipeline —
--    mark them so the drip only probes genuinely-unchecked symbols.
-- 3. `composite_figi` was write-only (no reader anywhere); `reference_updated_utc`'s
--    only reader was the old enrichment gate deleted with this change.

-- Bound lock/statement time like prior column-drop migrations: fail fast if the
-- table is contended rather than queueing behind traffic.
set lock_timeout = '5s';
set statement_timeout = '300s';

-- 1. Add the checked marker.
ALTER TABLE public.assets
  ADD COLUMN IF NOT EXISTS icon_checked_at timestamptz;

-- 2. Backfill: an existing icon means the symbol was checked and answered.
UPDATE public.assets
SET icon_checked_at = now()
WHERE icon_url IS NOT NULL;

-- 3. Drop the dead reference columns.
ALTER TABLE public.assets
  DROP COLUMN IF EXISTS composite_figi,
  DROP COLUMN IF EXISTS reference_updated_utc;

-- 4. Bump the tracked schema version.
UPDATE public.app_metadata
SET value = '20260707005431_icon_checked_at_drop_dead_reference_cols'
WHERE key = 'schema_version';
