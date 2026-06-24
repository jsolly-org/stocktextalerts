-- ineff-3: have claim_scheduled_notification RETURN the post-claim attempt_count instead of
-- a bare boolean, so the failed-delivery path (updateScheduledNotificationRow) can compute the
-- backoff from the count the claim already incremented — no redundant SELECT.
--
-- Returns the post-claim attempt_count (>= 1) when this run won the claim, or NULL when the
-- claim was denied (row already sent / retries exhausted / not yet due). The return TYPE changes
-- (boolean -> integer), which CREATE OR REPLACE cannot do, so drop + recreate + re-grant.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

DROP FUNCTION IF EXISTS public.claim_scheduled_notification(
  uuid, public.scheduled_notification_type, date, integer, public.delivery_method
);

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

UPDATE public.app_metadata
SET value = '20260624212024_claim_returns_attempt_count'
WHERE key = 'schema_version';
