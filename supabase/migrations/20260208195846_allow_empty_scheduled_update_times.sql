-- Allow scheduled_update_times to be an empty array when scheduled_updates_enabled is true.
-- Previously the constraint required at least 1 element.
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_scheduled_updates_requires_time;

ALTER TABLE public.users ADD CONSTRAINT users_scheduled_updates_requires_time CHECK (
  (scheduled_updates_enabled = false) OR (
    scheduled_update_times IS NOT NULL
    AND COALESCE(array_length(scheduled_update_times, 1), 0) >= 0
  )
);
