ALTER TABLE public.users
  ALTER COLUMN email_notifications_enabled SET DEFAULT true;

-- Backfill: enable for all existing users so they continue receiving emails.
UPDATE public.users
SET email_notifications_enabled = true
WHERE email_notifications_enabled = false;
