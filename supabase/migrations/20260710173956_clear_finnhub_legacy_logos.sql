-- Clear Finnhub-era logo URLs / caches and requeue those symbols (plus Finnhub-era
-- checked-no-logo rows) for the Massive branding drip.
--
-- Massive now owns logos. Legacy `static*.finnhub.io` icon_url values are no longer
-- on the allowlist; leaving them would 404 in the proxy and block re-probe because
-- icon_checked_at is already set. Rows stamped "no logo" under the Finnhub drip
-- may still have a Massive branding icon — reset those too.

set lock_timeout = '5s';
set statement_timeout = '300s';

-- 1. Drop Finnhub CDN URLs and any cached base64 for those rows; requeue for Massive.
UPDATE public.assets
SET
  icon_url = NULL,
  icon_base64 = NULL,
  icon_checked_at = NULL
WHERE icon_url ILIKE '%finnhub.io%';

-- 2. Requeue Finnhub-era (and any other) checked-no-logo rows so Massive can answer.
UPDATE public.assets
SET icon_checked_at = NULL
WHERE icon_url IS NULL
  AND icon_checked_at IS NOT NULL;

-- 3. Bump the tracked schema version.
UPDATE public.app_metadata
SET value = '20260710173956_clear_finnhub_legacy_logos'
WHERE key = 'schema_version';
