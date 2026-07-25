-- squawk-ignore-file constraint-missing-not-valid
-- (Supabase applies each migration in ONE transaction, so NOT VALID + VALIDATE
-- in the same file is the only option; squawk still wants them split.)
--
-- Persist the last Grok "why" explanation per (user, symbol) so same-day
-- re-triggers can classify continuity (same / updated / new / unknown).
-- Dedicated rolling budget columns on users (20 / 24h) are separate from the
-- daily-digest Grok counters (10 / 24h).

SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE public.price_move_alert_state
  ADD COLUMN last_why_summary text,
  ADD COLUMN last_why_verdict text,
  ADD COLUMN last_why_at timestamptz;

ALTER TABLE public.price_move_alert_state
  ADD CONSTRAINT price_move_alert_state_last_why_verdict_check
  CHECK (
    last_why_verdict IS NULL
    OR last_why_verdict IN ('same', 'updated', 'new', 'unknown')
  ) NOT VALID;

ALTER TABLE public.price_move_alert_state
  VALIDATE CONSTRAINT price_move_alert_state_last_why_verdict_check;

COMMENT ON COLUMN public.price_move_alert_state.last_why_summary IS
  'Last Grok why blurb delivered with a price-move alert for this (user, symbol).';

COMMENT ON COLUMN public.price_move_alert_state.last_why_verdict IS
  'Continuity vs the prior same-day why: same, updated, new, or unknown.';

COMMENT ON COLUMN public.price_move_alert_state.last_why_at IS
  'When last_why_summary was persisted (UTC). Same-ET-day prior is reused for compare.';

ALTER TABLE public.users
  ADD COLUMN price_move_why_window_start timestamptz,
  ADD COLUMN price_move_why_sends_in_window integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.users.price_move_why_window_start IS
  'Start of the rolling 24h window for price-move why Grok sends.';

COMMENT ON COLUMN public.users.price_move_why_sends_in_window IS
  'Count of successful price-move why Grok invocations in the current window (cap 20).';

UPDATE public.app_metadata
SET value = '20260725124633_price_move_alert_why'
WHERE key = 'schema_version';
