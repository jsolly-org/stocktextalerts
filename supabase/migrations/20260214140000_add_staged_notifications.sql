-- Pre-computed notification staging table.
-- Stores fully rendered notification content that is ready to send
-- once the user's scheduled time arrives.

CREATE TABLE IF NOT EXISTS public.staged_notifications (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL CHECK (notification_type IN ('market', 'daily')),
  scheduled_for TIMESTAMPTZ NOT NULL,
  staged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  staged_data JSONB NOT NULL,
  UNIQUE (user_id, notification_type, scheduled_for)
);

CREATE INDEX idx_staged_notifications_delivery
  ON public.staged_notifications (scheduled_for);

ALTER TABLE public.staged_notifications ENABLE ROW LEVEL SECURITY;

-- Only service_role (cron/admin) should access this table.
REVOKE ALL ON TABLE public.staged_notifications FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.staged_notifications TO service_role;
