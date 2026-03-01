-- Revert sms_notifications_enabled default back to false.
-- Migration 20260215210000 changed it to true, but new users should start
-- with SMS off until they explicitly enable it and verify a phone number.
-- The users_sms_requires_phone constraint already enforces that
-- sms_notifications_enabled can only be true when phone details exist.

ALTER TABLE public.users
  ALTER COLUMN sms_notifications_enabled SET DEFAULT false;

-- Update schema version for test infrastructure.
UPDATE public.app_metadata
  SET value = '20260302000000_default_sms_notifications_enabled_false'
  WHERE key = 'schema_version';
