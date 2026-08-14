-- squawk-ignore-file ban-drop-column
-- Digest send is derived from any daily_notification facet being on.
-- Do not rewrite 20260813161550 (it added this column).

SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- Master-off nulled daily_notification_next_send_at while leaving facets on.
-- Restore the 09:00 ET weekday cursor so those humans become due again.
UPDATE public.users u
SET daily_notification_next_send_at = (
  SELECT ((gs::date + time '09:00') AT TIME ZONE 'America/New_York')
  FROM generate_series(
    (timezone('America/New_York', now()))::date,
    (timezone('America/New_York', now()))::date + 14,
    interval '1 day'
  ) AS gs
  WHERE EXTRACT(ISODOW FROM gs) BETWEEN 1 AND 5
    AND ((gs::date + time '09:00') AT TIME ZONE 'America/New_York') > now()
  ORDER BY gs
  LIMIT 1
)
WHERE u.delivery_channel IN ('email', 'telegram')
  AND u.daily_notification_next_send_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM public.notification_preferences np
    WHERE np.user_id = u.id
      AND np.notification_type = 'daily_notification'
      AND np.enabled = true
  );

ALTER TABLE public.users
  DROP COLUMN IF EXISTS daily_notification_enabled;

UPDATE public.app_metadata
SET value = '20260814032629_drop_daily_notification_enabled'
WHERE key = 'schema_version';
