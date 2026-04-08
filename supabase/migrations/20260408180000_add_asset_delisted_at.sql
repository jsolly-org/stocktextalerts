-- Track when an asset was delisted from its primary exchange.
-- Populated by the daily delisting sweep in the AssetEvents Lambda.
-- NULL means listed or unknown status.
--
-- We preserve the assets row after delisting because asset_events,
-- daily_asset_stats, and historical notification_log entries reference
-- it via FK. Only user_assets and price_targets rows get cleaned up
-- when a symbol gets flagged.
--
-- Relisting: the sweep never clears this column. If a ticker is
-- legitimately re-activated, a human operator runs
--   UPDATE public.assets SET delisted_at = NULL WHERE symbol = '...';

ALTER TABLE public.assets
  ADD COLUMN delisted_at TIMESTAMPTZ;

-- Partial index on the small set of delisted assets. Used by the
-- batchLoadUserAssets filter, the /api/assets POST guard, and the sweep
-- itself when partitioning already-flagged vs. to-check symbols.
CREATE INDEX IF NOT EXISTS idx_assets_delisted_at
  ON public.assets (delisted_at)
  WHERE delisted_at IS NOT NULL;

UPDATE public.app_metadata
  SET value = '20260408180000_add_asset_delisted_at'
  WHERE key = 'schema_version';
