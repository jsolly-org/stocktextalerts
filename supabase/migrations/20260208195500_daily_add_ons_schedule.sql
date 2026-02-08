ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS add_ons_notifications_enabled boolean NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS add_ons_delivery_time integer DEFAULT 540,
ADD COLUMN IF NOT EXISTS add_ons_next_send_at timestamp with time zone;

ALTER TABLE public.users
ADD CONSTRAINT users_add_ons_delivery_time_range CHECK (
  add_ons_delivery_time IS NULL OR (add_ons_delivery_time >= 0 AND add_ons_delivery_time <= 1439)
);

ALTER TABLE public.users
ADD CONSTRAINT users_add_ons_schedule_requires_time CHECK (
  add_ons_notifications_enabled = false OR add_ons_delivery_time IS NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_add_ons_next_send_at
  ON users (add_ons_next_send_at)
  WHERE add_ons_notifications_enabled = true
    AND add_ons_next_send_at IS NOT NULL;

