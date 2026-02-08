ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS price_notifications_enabled BOOLEAN DEFAULT true NOT NULL;
