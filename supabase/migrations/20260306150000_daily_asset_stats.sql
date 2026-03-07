CREATE TABLE IF NOT EXISTS public.daily_asset_stats (
  symbol VARCHAR(10) NOT NULL,
  computed_at DATE NOT NULL DEFAULT CURRENT_DATE,
  avg_volume_20d NUMERIC(16, 0),
  atr_14 NUMERIC(12, 4),
  PRIMARY KEY (symbol)
);

CREATE INDEX idx_daily_asset_stats_computed ON public.daily_asset_stats (computed_at);

-- Grant service_role full access (cron endpoint runs as service_role)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.daily_asset_stats TO service_role;

UPDATE public.app_metadata
  SET value = '20260306150000_daily_asset_stats'
  WHERE key = 'schema_version';
