-- Remove the price_target_alerts_enabled column from users.
-- Price targets are now always available (no opt-in toggle).

ALTER TABLE public.users
  DROP COLUMN price_target_alerts_enabled;

-- Update schema version
UPDATE public.app_metadata
  SET value = '20260303130000_drop_price_target_alerts_enabled'
  WHERE key = 'schema_version';
