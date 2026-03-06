-- Add per-channel toggles for including asset prices in the daily digest (default ON).
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS daily_digest_include_prices_email boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS daily_digest_include_prices_sms boolean NOT NULL DEFAULT true;

UPDATE public.app_metadata
  SET value = '20260306130000_add_daily_digest_include_prices'
  WHERE key = 'schema_version';
