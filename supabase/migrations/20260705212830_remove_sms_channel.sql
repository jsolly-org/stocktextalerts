-- squawk-ignore-file ban-drop-table,ban-drop-column,changing-column-type,adding-foreign-key-constraint,constraint-missing-not-valid
-- Remove the SMS (Twilio) delivery channel end to end. Going forward the app
-- delivers only via email and Telegram. This drops:
--   · every notification_preferences / notification_options row for channel='sms',
--   · the 'sms' value from the delivery_method enum (recreated, since Postgres
--     cannot DROP VALUE and the type survives for email+telegram),
--   · the users phone/SMS columns (+ their CHECK/UNIQUE constraints and the
--     full_phone generated column),
--   · the short_urls table (the SMS-only URL shortener) and its RPCs,
--   · the SMS verification RPCs.
-- Email + Telegram delivery, and the shared claim_scheduled_notification hot-path
-- RPC (recreated verbatim, only to rebind it to the new enum), are KEPT.

set lock_timeout = '5s';
-- Generous ceiling: the enum recreate rewrites four delivery_method columns under
-- ACCESS EXCLUSIVE (text↔enum is not binary-coercible), incl. notification_log twice.
set statement_timeout = '300s';

-- 1. Drop the SMS preference rows FIRST — the notification_preferences →
--    notification_options FK would block the catalog delete otherwise.
DELETE FROM public.notification_preferences WHERE channel = 'sms';

-- 2. Remove the SMS option-catalog rows (must match NOTIFICATION_OPTION_MATRIX,
--    which drops its `sms` keys in the same change; check:option-catalog enforces it).
DELETE FROM public.notification_options WHERE channel = 'sms';

-- 2b. Remove historical SMS delivery-log rows. These MUST go before the enum is
--     recreated — a leftover 'sms' value can't be cast to the new type.
DELETE FROM public.notification_log WHERE delivery_method = 'sms';

-- 2c. Remove SMS rows from the scheduled-notification claim/dedup ledger. It keeps
--     one row per scheduled send (status='sent' rows persist; there is no purge job),
--     so prod holds a 'sms' row for every SMS ever scheduled. These MUST go before
--     the enum recreate or `channel::delivery_method` aborts on 'sms'. `channel` is
--     part of the PK, so the delete is safe. Invisible locally (seed has no sms rows).
DELETE FROM public.scheduled_notifications WHERE channel = 'sms';

-- 3. Drop the SMS-only RPCs (verification reservation + the short-url purger).
DROP FUNCTION IF EXISTS public.reserve_sms_verification(uuid, text, text, integer);
DROP FUNCTION IF EXISTS public.rollback_sms_verification_reservation(uuid, timestamp with time zone, timestamp with time zone);
DROP FUNCTION IF EXISTS public.purge_expired_short_urls();

-- 4. Drop the SMS URL-shortener table (indexes + RLS drop with it). Its sole
--    writer (shortenUrls, in the SMS delivery path), reader (/r/[id]) and purger
--    (above) are all removed in this change.
DROP TABLE IF EXISTS public.short_urls;

-- 5. Recreate delivery_method without 'sms'. The type SURVIVES (email+telegram
--    remain) so `DROP VALUE` is impossible — swap all dependent columns to text,
--    rename+recreate the type, swap them back. claim_scheduled_notification embeds
--    the type in its signature, so it is dropped here and recreated verbatim below.
DROP FUNCTION IF EXISTS public.claim_scheduled_notification(
  uuid, public.scheduled_notification_type, date, integer, public.delivery_method
);

-- The preferences→options FK pairs the two `channel` columns, so both must be the
-- same type throughout the swap. Drop it now and recreate it once both are back.
ALTER TABLE public.notification_preferences DROP CONSTRAINT notification_preferences_option_fkey;

ALTER TABLE public.scheduled_notifications ALTER COLUMN channel TYPE text;
ALTER TABLE public.notification_preferences ALTER COLUMN channel TYPE text;
ALTER TABLE public.notification_options ALTER COLUMN channel TYPE text;
ALTER TABLE public.notification_log ALTER COLUMN delivery_method TYPE text;

ALTER TYPE public.delivery_method RENAME TO delivery_method_old;
CREATE TYPE public.delivery_method AS ENUM ('email', 'telegram');
ALTER TYPE public.delivery_method OWNER TO postgres;

ALTER TABLE public.scheduled_notifications
  ALTER COLUMN channel TYPE public.delivery_method USING channel::public.delivery_method;
ALTER TABLE public.notification_preferences
  ALTER COLUMN channel TYPE public.delivery_method USING channel::public.delivery_method;
ALTER TABLE public.notification_options
  ALTER COLUMN channel TYPE public.delivery_method USING channel::public.delivery_method;
ALTER TABLE public.notification_log
  ALTER COLUMN delivery_method TYPE public.delivery_method USING delivery_method::public.delivery_method;

DROP TYPE public.delivery_method_old;

-- Recreate the preferences→options FK now that both channel columns are the enum again.
ALTER TABLE public.notification_preferences
  ADD CONSTRAINT notification_preferences_option_fkey
  FOREIGN KEY (notification_type, content, channel)
  REFERENCES public.notification_options (notification_type, content, channel)
  ON UPDATE CASCADE;

-- Recreate claim_scheduled_notification verbatim (from 20260624212024) so its
-- p_channel parameter binds to the new delivery_method type; re-grant to service_role.
CREATE FUNCTION public.claim_scheduled_notification(
  p_user_id uuid,
  p_notification_type public.scheduled_notification_type,
  p_scheduled_date date,
  p_scheduled_minutes integer,
  p_channel public.delivery_method
) RETURNS integer
  LANGUAGE plpgsql
  SET search_path TO public, pg_temp
AS $$
DECLARE
  v_attempt_count integer;
BEGIN
  INSERT INTO scheduled_notifications (
    user_id, notification_type, scheduled_date, scheduled_minutes, channel,
    status, attempt_count, last_attempt_at, error, next_retry_at
  )
  VALUES (
    p_user_id, p_notification_type, p_scheduled_date, p_scheduled_minutes, p_channel,
    'sending', 1, pg_catalog.now(), NULL, NULL
  )
  ON CONFLICT (user_id, notification_type, scheduled_date, scheduled_minutes, channel)
  DO UPDATE
    SET status = 'sending',
        attempt_count = scheduled_notifications.attempt_count + 1,
        last_attempt_at = pg_catalog.now(),
        error = NULL,
        next_retry_at = NULL
    WHERE scheduled_notifications.status <> 'sent'
      AND scheduled_notifications.attempt_count < 3
      AND (
        scheduled_notifications.next_retry_at IS NULL
        OR scheduled_notifications.next_retry_at <= pg_catalog.now()
      )
      AND (
        scheduled_notifications.status = 'failed'
        OR (
          scheduled_notifications.status = 'sending'
          AND scheduled_notifications.last_attempt_at < pg_catalog.now() - interval '10 minutes'
        )
      )
  RETURNING attempt_count INTO v_attempt_count;

  -- NULL = claim denied (no row inserted/updated). A non-NULL count (>= 1) = claimed.
  RETURN v_attempt_count;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_scheduled_notification(
  uuid, public.scheduled_notification_type, date, integer, public.delivery_method
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_scheduled_notification(
  uuid, public.scheduled_notification_type, date, integer, public.delivery_method
) TO service_role;

-- 6. Drop the users phone/SMS columns. full_phone is GENERATED from the phone
--    columns, so drop it first; the phone CHECK constraints, unique_phone, and
--    the sms-opt-out CHECK drop automatically with the columns they reference.
ALTER TABLE public.users
  DROP COLUMN IF EXISTS full_phone,
  DROP COLUMN IF EXISTS phone_verified,
  DROP COLUMN IF EXISTS sms_notifications_enabled,
  DROP COLUMN IF EXISTS sms_opted_out,
  DROP COLUMN IF EXISTS verification_sent_at,
  DROP COLUMN IF EXISTS phone_country_code,
  DROP COLUMN IF EXISTS phone_number;

-- 7. Bump the tracked schema version.
UPDATE public.app_metadata
SET value = '20260705212830_remove_sms_channel'
WHERE key = 'schema_version';
