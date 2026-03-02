-- scheduled_notifications is used only by service_role (cron/scheduler).
-- Explicitly revoke access from anon and authenticated for defense in depth.
REVOKE ALL ON TABLE public.scheduled_notifications FROM anon, authenticated;
