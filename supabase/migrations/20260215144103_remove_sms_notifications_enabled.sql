BEGIN;

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_sms_opted_out_blocks_sms_enabled;

ALTER TABLE public.users
  DROP COLUMN IF EXISTS sms_notifications_enabled;

COMMIT;
