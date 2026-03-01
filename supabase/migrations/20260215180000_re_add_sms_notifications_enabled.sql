BEGIN;

-- Re-add the global SMS toggle column.
-- Two separate fields serve two purposes:
--   sms_notifications_enabled — user-controlled global SMS preference (UI toggle)
--   sms_opted_out            — carrier regulatory opt-out (locks/disables the toggle)
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS sms_notifications_enabled boolean NOT NULL DEFAULT false;

-- Backfill: enable for every user who has not opted out via STOP.
UPDATE public.users
SET sms_notifications_enabled = true
WHERE sms_opted_out = false;

-- Enforce: a user cannot have SMS enabled while opted out.
ALTER TABLE public.users
  ADD CONSTRAINT users_sms_opted_out_blocks_sms_enabled
  CHECK (NOT (sms_opted_out AND sms_notifications_enabled));

COMMIT;
