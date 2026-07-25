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

-- Pending reclaim must cover SQS VisibilityTimeout × maxReceiveCount (see
-- PriceMoveWhyQueue). 20 minutes > 360s × 3 ≈ 18 minutes.
CREATE OR REPLACE FUNCTION public.reserve_flat_price_alert(
  p_user_id uuid,
  p_symbol text,
  p_baseline_price numeric,
  p_new_price numeric,
  p_threshold_value numeric,
  p_threshold_unit text
) RETURNS boolean
  LANGUAGE plpgsql
  SET search_path TO public, pg_temp
AS $$
DECLARE
  current_row public.price_move_alert_state%ROWTYPE;
  today_et date;
  move_amount numeric;
  move_direction smallint;
BEGIN
  IF p_baseline_price IS NULL OR p_baseline_price <= 0 THEN
    RETURN false;
  END IF;
  IF p_new_price IS NULL OR p_new_price <= 0 THEN
    RETURN false;
  END IF;
  IF p_threshold_value IS NULL OR p_threshold_value <= 0 THEN
    RETURN false;
  END IF;

  IF p_threshold_unit = 'percent' THEN
    move_amount := abs((p_new_price - p_baseline_price) / p_baseline_price * 100);
  ELSIF p_threshold_unit = 'dollar' THEN
    move_amount := abs(p_new_price - p_baseline_price);
  ELSE
    RETURN false;
  END IF;

  IF move_amount < p_threshold_value THEN
    RETURN false;
  END IF;

  IF p_new_price > p_baseline_price THEN
    move_direction := 1;
  ELSIF p_new_price < p_baseline_price THEN
    move_direction := -1;
  ELSE
    RETURN false;
  END IF;

  today_et := (now() AT TIME ZONE 'America/New_York')::date;

  SELECT * INTO current_row
  FROM public.price_move_alert_state
  WHERE user_id = p_user_id AND symbol = p_symbol
  FOR UPDATE;

  IF NOT FOUND THEN
    BEGIN
      INSERT INTO public.price_move_alert_state (
        user_id,
        symbol,
        last_notification_price,
        last_notification_at,
        pending_delivery,
        pending_new_price,
        pending_alert_direction,
        reserved_at,
        first_of_day_reservation
      ) VALUES (
        p_user_id,
        p_symbol,
        p_baseline_price,
        now(),
        true,
        p_new_price,
        move_direction,
        now(),
        true
      );
      RETURN true;
    EXCEPTION WHEN unique_violation THEN
      RETURN false;
    END;
  END IF;

  IF current_row.pending_delivery
    AND current_row.reserved_at IS NOT NULL
    AND current_row.reserved_at >= now() - interval '20 minutes' THEN
    RETURN false;
  END IF;

  IF (current_row.last_notification_at AT TIME ZONE 'America/New_York')::date < today_et THEN
    UPDATE public.price_move_alert_state
    SET
      pending_delivery = true,
      pending_new_price = p_new_price,
      pending_alert_direction = move_direction,
      reserved_at = now()
    WHERE user_id = p_user_id AND symbol = p_symbol;
    RETURN true;
  END IF;

  IF current_row.last_notification_price = p_baseline_price THEN
    UPDATE public.price_move_alert_state
    SET
      pending_delivery = true,
      pending_new_price = p_new_price,
      pending_alert_direction = move_direction,
      reserved_at = now()
    WHERE user_id = p_user_id AND symbol = p_symbol;
    RETURN true;
  END IF;

  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_flat_price_alert(uuid, text, numeric, numeric, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_flat_price_alert(uuid, text, numeric, numeric, numeric, text) TO service_role;

-- Atomically reserve one slot in the 20/24h why budget before calling Grok.
CREATE OR REPLACE FUNCTION public.claim_price_move_why_budget(p_user_id uuid)
RETURNS boolean
  LANGUAGE plpgsql
  SET search_path TO public, pg_temp
AS $$
DECLARE
  w_start timestamptz;
  sends integer;
  now_ts timestamptz := clock_timestamp();
BEGIN
  SELECT price_move_why_window_start, price_move_why_sends_in_window
    INTO w_start, sends
  FROM public.users
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF w_start IS NULL OR (now_ts - w_start) >= interval '24 hours' THEN
    UPDATE public.users
    SET
      price_move_why_window_start = now_ts,
      price_move_why_sends_in_window = 1
    WHERE id = p_user_id;
    RETURN true;
  END IF;

  IF sends >= 20 THEN
    RETURN false;
  END IF;

  UPDATE public.users
  SET price_move_why_sends_in_window = sends + 1
  WHERE id = p_user_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_price_move_why_budget(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_price_move_why_budget(uuid) TO service_role;
