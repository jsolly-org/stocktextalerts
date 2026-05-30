-- Exponential backoff for scheduled notification delivery retries.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE public.scheduled_notifications
  ADD COLUMN IF NOT EXISTS next_retry_at timestamp with time zone;

CREATE OR REPLACE FUNCTION public.claim_scheduled_notification(
  p_user_id uuid,
  p_notification_type public.scheduled_notification_type,
  p_scheduled_date date,
  p_scheduled_minutes integer,
  p_channel public.delivery_method
) RETURNS boolean
  LANGUAGE plpgsql
  SET search_path TO public, pg_temp
AS $$
DECLARE
  claimed boolean;
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
  RETURNING true INTO claimed;

  RETURN COALESCE(claimed, false);
END;
$$;

UPDATE public.app_metadata
SET value = '20260530233000_scheduled_notification_retry_backoff'
WHERE key = 'schema_version';
