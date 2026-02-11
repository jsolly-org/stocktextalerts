-- Ensure defaults are applied in existing environments (forward migration).
-- These columns exist in `public.users` and should default to `false`.

ALTER TABLE public.users
  ALTER COLUMN price_notifications_enabled SET DEFAULT false,
  ALTER COLUMN price_include_email SET DEFAULT false,
  ALTER COLUMN price_include_sms SET DEFAULT false;
