-- Rename scheduled_updates_enabled to price_notifications_enabled
ALTER TABLE public.users RENAME COLUMN scheduled_updates_enabled TO price_notifications_enabled;

-- Change default from false to true
ALTER TABLE public.users ALTER COLUMN price_notifications_enabled SET DEFAULT true;

-- Drop the old constraint that referenced scheduled_updates_enabled
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_scheduled_updates_requires_time;

-- Add missing columns
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS only_notify_when_market_open BOOLEAN DEFAULT true NOT NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_market_closed_skip_scheduled_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_market_closed_skip_recorded_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS add_ons_delivery_time INTEGER;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS add_ons_next_send_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_grok_rumors_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS first_notification_include_news BOOLEAN DEFAULT false NOT NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS first_notification_include_rumors BOOLEAN DEFAULT false NOT NULL;

-- Add missing constraint for add_ons_delivery_time
ALTER TABLE public.users ADD CONSTRAINT users_add_ons_delivery_time_range CHECK (
  add_ons_delivery_time IS NULL OR (
    add_ons_delivery_time >= 0 AND add_ons_delivery_time <= 1439
  )
);

-- Add missing index for add-ons scheduling
CREATE INDEX IF NOT EXISTS idx_users_add_ons_next_send_at
  ON public.users (add_ons_next_send_at)
  WHERE add_ons_delivery_time IS NOT NULL
    AND add_ons_next_send_at IS NOT NULL;
