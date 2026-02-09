-- Add per-channel preferences for price (frequent) notifications.
-- Default to false — channels are auto-checked in the UI when the user enables them.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS price_include_email boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS price_include_sms   boolean NOT NULL DEFAULT false;
