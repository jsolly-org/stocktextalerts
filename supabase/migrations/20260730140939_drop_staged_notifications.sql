-- squawk-ignore-file ban-drop-table
-- Remove digest look-ahead staging. Daily digests build and send live at due time.
SET lock_timeout = '5s';
SET statement_timeout = '30s';

DROP TABLE IF EXISTS public.staged_notifications;
DROP TYPE IF EXISTS public.staged_notification_type;

UPDATE public.app_metadata
SET value = '20260730140939_drop_staged_notifications'
WHERE key = 'schema_version';
