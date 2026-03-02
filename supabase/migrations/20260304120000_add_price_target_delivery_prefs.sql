-- Add independent delivery preferences for price targets.
-- Previously price targets reused the realtime alert delivery columns.

ALTER TABLE public.users
  ADD COLUMN price_targets_include_email BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN price_targets_include_sms   BOOLEAN NOT NULL DEFAULT true;

-- Preserve existing user preferences: copy from market_asset_price_alerts_* columns
UPDATE public.users
SET
  price_targets_include_email = market_asset_price_alerts_include_email,
  price_targets_include_sms   = market_asset_price_alerts_include_sms;

-- Update schema version
UPDATE public.app_metadata
  SET value = '20260304120000_add_price_target_delivery_prefs'
  WHERE key = 'schema_version';
