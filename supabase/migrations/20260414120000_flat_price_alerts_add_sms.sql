-- Flat Price Alerts: add SMS channel.
--
-- Replaces the single price_move_alerts_enabled flag with two channel-specific
-- flags (include_email, include_sms). Existing opt-ins (enabled = true) carry
-- forward as include_email = true so no one loses their current alert delivery.
-- SMS stays false across the board — users must opt in explicitly.

ALTER TABLE public.users
  ADD COLUMN price_move_alerts_include_email BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN price_move_alerts_include_sms   BOOLEAN NOT NULL DEFAULT false;

UPDATE public.users
  SET price_move_alerts_include_email = true
  WHERE price_move_alerts_enabled = true;

ALTER TABLE public.users
  DROP COLUMN price_move_alerts_enabled;

COMMENT ON COLUMN public.users.price_move_alerts_include_email IS
  'Send 5% flat price move alerts over email. Requires email_notifications_enabled.';
COMMENT ON COLUMN public.users.price_move_alerts_include_sms IS
  'Send 5% flat price move alerts over SMS. Requires phone_verified + sms_notifications_enabled and not sms_opted_out.';

UPDATE public.app_metadata
  SET value = '20260414120000_flat_price_alerts_add_sms'
  WHERE key = 'schema_version';
