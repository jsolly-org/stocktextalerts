-- squawk-ignore-file constraint-missing-not-valid
-- (Supabase applies each migration in ONE transaction, so NOT VALID + VALIDATE
-- in the same file is the only option; squawk still wants them split.)
--
-- Same-direction re-triggers (acceleration) use half the user threshold; reverse
-- moves still need the full threshold. Persist the last successful alert's
-- direction so the next tick can choose half vs full.
--
-- Direction is stashed at reserve time from (p_new_price - p_baseline_price), not
-- derived at finalize from last_notification_price: on cross-day first-of-day the
-- row still holds yesterday's fire price while the app baselines on prevClose.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE public.price_move_alert_state
  ADD COLUMN last_alert_direction smallint,
  ADD COLUMN pending_alert_direction smallint;

ALTER TABLE public.price_move_alert_state
  ADD CONSTRAINT price_move_alert_state_last_alert_direction_check
  CHECK (last_alert_direction IS NULL OR last_alert_direction IN (-1, 1)) NOT VALID;

ALTER TABLE public.price_move_alert_state
  ADD CONSTRAINT price_move_alert_state_pending_alert_direction_check
  CHECK (pending_alert_direction IS NULL OR pending_alert_direction IN (-1, 1)) NOT VALID;

ALTER TABLE public.price_move_alert_state
  VALIDATE CONSTRAINT price_move_alert_state_last_alert_direction_check;

ALTER TABLE public.price_move_alert_state
  VALIDATE CONSTRAINT price_move_alert_state_pending_alert_direction_check;

COMMENT ON COLUMN public.price_move_alert_state.last_alert_direction IS
  'Sign of the last finalized alert move: 1 = up, -1 = down. NULL for legacy rows until the next successful finalize.';

COMMENT ON COLUMN public.price_move_alert_state.pending_alert_direction IS
  'Direction of the in-flight reservation, computed at reserve from new price vs baseline. Copied to last_alert_direction on finalize.';

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
    AND current_row.reserved_at >= now() - interval '10 minutes' THEN
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

CREATE OR REPLACE FUNCTION public.finalize_flat_price_alert(
  p_user_id uuid,
  p_symbol text
) RETURNS boolean
  LANGUAGE plpgsql
  SET search_path TO public, pg_temp
AS $$
DECLARE
  finalized boolean;
BEGIN
  UPDATE public.price_move_alert_state
  SET
    last_alert_direction = pending_alert_direction,
    last_notification_price = pending_new_price,
    last_notification_at = now(),
    pending_delivery = false,
    pending_new_price = NULL,
    pending_alert_direction = NULL,
    reserved_at = NULL,
    first_of_day_reservation = false
  WHERE user_id = p_user_id
    AND symbol = p_symbol
    AND pending_delivery = true
    AND pending_new_price IS NOT NULL
    AND pending_alert_direction IS NOT NULL
  RETURNING true INTO finalized;

  RETURN COALESCE(finalized, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.release_flat_price_alert(
  p_user_id uuid,
  p_symbol text
) RETURNS boolean
  LANGUAGE plpgsql
  SET search_path TO public, pg_temp
AS $$
DECLARE
  released boolean;
BEGIN
  DELETE FROM public.price_move_alert_state
  WHERE user_id = p_user_id
    AND symbol = p_symbol
    AND pending_delivery = true
    AND first_of_day_reservation = true
  RETURNING true INTO released;

  IF released THEN
    RETURN true;
  END IF;

  UPDATE public.price_move_alert_state
  SET
    pending_delivery = false,
    pending_new_price = NULL,
    pending_alert_direction = NULL,
    reserved_at = NULL
  WHERE user_id = p_user_id
    AND symbol = p_symbol
    AND pending_delivery = true
  RETURNING true INTO released;

  RETURN COALESCE(released, false);
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_flat_price_alert(uuid, text, numeric, numeric, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_flat_price_alert(uuid, text, numeric, numeric, numeric, text) TO service_role;

REVOKE ALL ON FUNCTION public.finalize_flat_price_alert(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_flat_price_alert(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.release_flat_price_alert(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_flat_price_alert(uuid, text) TO service_role;

UPDATE public.app_metadata
SET value = '20260725114030_price_move_alert_acceleration'
WHERE key = 'schema_version';
