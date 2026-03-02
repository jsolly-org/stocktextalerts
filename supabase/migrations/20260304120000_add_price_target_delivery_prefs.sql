-- Add independent delivery preferences for price targets.
-- Previously price targets reused the realtime alert delivery columns.

ALTER TABLE public.users
  ADD COLUMN price_targets_include_email BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN price_targets_include_sms   BOOLEAN NOT NULL DEFAULT true;

-- Update schema version
UPDATE public.app_metadata
  SET value = '20260304120000_add_price_target_delivery_prefs'
  WHERE key = 'schema_version';
