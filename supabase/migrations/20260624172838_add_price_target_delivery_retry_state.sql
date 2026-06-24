-- Price-target delivery retry state: per-channel terminal tracking + attempt
-- ceiling so (a) a single channel's success no longer deletes the row and drops
-- a transiently-failed sibling channel, and (b) a permanently-undeliverable
-- target stops re-sending every market-minute. Mirrors the scheduled_notifications
-- attempt_count / next_retry_at backoff model.
--
-- One row per (user_id, symbol) — the price_targets primary key — so per-channel
-- delivery timestamps live on the single row.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE public.price_targets
  -- Number of delivery rounds attempted for the currently-triggered target.
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  -- When the next retry round is eligible (backoff). NULL = no pending retry.
  ADD COLUMN IF NOT EXISTS next_retry_at timestamp with time zone,
  -- Per-channel delivery timestamps. Non-NULL = that channel has been delivered
  -- for the current trigger; the resume path skips it so it is never re-sent.
  ADD COLUMN IF NOT EXISTS email_delivered_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS sms_delivered_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS telegram_delivered_at timestamp with time zone;

-- New columns inherit the table-level grants already in place
-- (GRANT DELETE, INSERT, SELECT, UPDATE TO authenticated, service_role — see
-- 20260610182813_tighten_table_privileges), so no per-column grant is needed.

UPDATE public.app_metadata
SET value = '20260624172838_add_price_target_delivery_retry_state'
WHERE key = 'schema_version';
