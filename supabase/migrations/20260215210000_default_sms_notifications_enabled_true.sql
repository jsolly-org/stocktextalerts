ALTER TABLE public.users
  ALTER COLUMN sms_notifications_enabled SET DEFAULT true;

-- Backfill: enable for all existing users who have not opted out.
UPDATE public.users
SET sms_notifications_enabled = true
WHERE sms_notifications_enabled = false
  AND sms_opted_out = false;
