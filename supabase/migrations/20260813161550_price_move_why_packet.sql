-- squawk-ignore-file constraint-missing-not-valid
-- (Supabase applies each migration in ONE transaction, so NOT VALID + VALIDATE
-- in the same file is the only option; squawk still wants them split.)
--
-- Price-move why packet + continuity fields, cemented 5% / percent-only thresholds.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE public.price_move_alert_state
  ADD COLUMN last_why_grade text,
  ADD COLUMN last_why_catalyst_type text,
  ADD COLUMN last_why_event_date date,
  ADD COLUMN last_why_key_entity text,
  ADD COLUMN last_why_packet jsonb;

ALTER TABLE public.price_move_alert_state
  ADD CONSTRAINT price_move_alert_state_last_why_grade_check
  CHECK (
    last_why_grade IS NULL
    OR last_why_grade IN ('confirmed', 'reported', 'narrative', 'sector', 'unexplained')
  ) NOT VALID;

ALTER TABLE public.price_move_alert_state
  VALIDATE CONSTRAINT price_move_alert_state_last_why_grade_check;

COMMENT ON COLUMN public.price_move_alert_state.last_why_grade IS
  'Internal catalyst grade for the last why. Never rendered to users.';

COMMENT ON COLUMN public.price_move_alert_state.last_why_catalyst_type IS
  'Structured catalyst type used for same-day continuity (not the human lede).';

COMMENT ON COLUMN public.price_move_alert_state.last_why_event_date IS
  'Catalyst event date (ET calendar) used for same-day continuity.';

COMMENT ON COLUMN public.price_move_alert_state.last_why_key_entity IS
  'Key entity named in the last why, used for same-day continuity.';

COMMENT ON COLUMN public.price_move_alert_state.last_why_packet IS
  'Full catalyst report (lede, grade, claims, move onset, retrieval version).';

DELETE FROM public.price_move_alert_thresholds
WHERE threshold_unit = 'dollar';

UPDATE public.price_move_alert_thresholds
SET threshold_value = 5
WHERE threshold_value IS DISTINCT FROM 5;

ALTER TABLE public.price_move_alert_thresholds
  DROP CONSTRAINT IF EXISTS price_move_alert_thresholds_value_check;

ALTER TABLE public.price_move_alert_thresholds
  ADD CONSTRAINT price_move_alert_thresholds_value_check
  CHECK (threshold_value = 5) NOT VALID;

ALTER TABLE public.price_move_alert_thresholds
  VALIDATE CONSTRAINT price_move_alert_thresholds_value_check;

ALTER TABLE public.price_move_alert_thresholds
  DROP CONSTRAINT IF EXISTS price_move_alert_thresholds_unit_percent_check;

ALTER TABLE public.price_move_alert_thresholds
  ADD CONSTRAINT price_move_alert_thresholds_unit_percent_check
  CHECK (threshold_unit = 'percent') NOT VALID;

ALTER TABLE public.price_move_alert_thresholds
  VALIDATE CONSTRAINT price_move_alert_thresholds_unit_percent_check;

COMMENT ON TABLE public.price_move_alert_thresholds IS
  'Row presence = opt-in to Price Move Alerts. Stored value is always 5% percent; same-direction accelerations evaluate at 2.5%.';

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
  IF p_threshold_unit IS DISTINCT FROM 'percent' THEN
    RETURN false;
  END IF;
  -- Callers pass the *effective* threshold (half the configured value on
  -- accelerations), so the floor here is half of the 5% table CHECK.
  IF p_threshold_value IS NULL OR p_threshold_value < 2.5 THEN
    RETURN false;
  END IF;

  move_amount := abs((p_new_price - p_baseline_price) / p_baseline_price * 100);

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

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS daily_notification_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.users.daily_notification_enabled IS
  'Master toggle for the human daily digest. Default ON. Asset-buyer sta_daily_digest wake is independent of this column.';

-- Lock stored local minutes to 09:00 America/New_York. Do not assign 540
-- (that is 09:00 in the user's timezone). Anchor on a Friday session so DST
-- conversion is a real weekday.
UPDATE public.users
SET daily_notification_time = (
  EXTRACT(HOUR FROM (
    (timestamp '2026-08-14 09:00:00' AT TIME ZONE 'America/New_York')
    AT TIME ZONE timezone
  ))::integer * 60
  + EXTRACT(MINUTE FROM (
    (timestamp '2026-08-14 09:00:00' AT TIME ZONE 'America/New_York')
    AT TIME ZONE timezone
  ))::integer
);

-- Lambda stock-buyer never receives the human digest (wake is independent).
UPDATE public.users
SET daily_notification_enabled = false
WHERE delivery_channel = 'lambda';

UPDATE public.users
SET daily_notification_next_send_at = NULL
WHERE daily_notification_enabled = false;

-- Snap UTC cursors to the next weekday 09:00 America/New_York after now()
-- so a leftover evening slot cannot skip the locked 09:00 window.
UPDATE public.users
SET daily_notification_next_send_at = (
  SELECT ((gs::date + time '09:00') AT TIME ZONE 'America/New_York')
  FROM generate_series(
    (timezone('America/New_York', now()))::date,
    (timezone('America/New_York', now()))::date + 14,
    interval '1 day'
  ) AS gs
  WHERE EXTRACT(ISODOW FROM gs) BETWEEN 1 AND 5
    AND ((gs::date + time '09:00') AT TIME ZONE 'America/New_York') > now()
  ORDER BY gs
  LIMIT 1
)
WHERE daily_notification_enabled = true;

INSERT INTO public.app_metadata (key, value)
VALUES ('asset_buyer_digest_wake_et_date', '')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.claim_asset_buyer_digest_wake(p_et_date text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated_count integer;
BEGIN
  IF p_et_date IS NULL OR p_et_date !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RAISE EXCEPTION 'invalid et date';
  END IF;

  UPDATE public.app_metadata
  SET value = p_et_date
  WHERE key = 'asset_buyer_digest_wake_et_date'
    AND value IS DISTINCT FROM p_et_date;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_asset_buyer_digest_wake(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_asset_buyer_digest_wake(text) TO service_role;

CREATE OR REPLACE FUNCTION public.release_asset_buyer_digest_wake(p_et_date text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated_count integer;
BEGIN
  IF p_et_date IS NULL OR p_et_date !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RAISE EXCEPTION 'invalid et date';
  END IF;

  UPDATE public.app_metadata
  SET value = ''
  WHERE key = 'asset_buyer_digest_wake_et_date'
    AND value = p_et_date;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.release_asset_buyer_digest_wake(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_asset_buyer_digest_wake(text) TO service_role;

UPDATE public.app_metadata
SET value = '20260813161550_price_move_why_packet'
WHERE key = 'schema_version';
