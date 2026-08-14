-- Recreate reserve_flat_price_alert without p_threshold_unit (percent-only).
-- Column drop is a follow-up: this ship only adds DEFAULT 'percent' so web
-- can keep writing the column until db push (Vercel-first).

SET lock_timeout = '5s';
SET statement_timeout = '30s';

DROP FUNCTION IF EXISTS public.reserve_flat_price_alert(uuid, text, numeric, numeric, numeric, text);

CREATE FUNCTION public.reserve_flat_price_alert(
  p_user_id uuid,
  p_symbol text,
  p_baseline_price numeric,
  p_new_price numeric,
  p_threshold_value numeric
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

REVOKE ALL ON FUNCTION public.reserve_flat_price_alert(uuid, text, numeric, numeric, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_flat_price_alert(uuid, text, numeric, numeric, numeric) TO service_role;

-- Two-phase: Vercel ships web before db push. Keep writing threshold_unit and
-- add a DEFAULT so a later omit+DROP COLUMN cannot 500 PMA upserts in the window.
ALTER TABLE public.price_move_alert_thresholds
  ALTER COLUMN threshold_unit SET DEFAULT 'percent';

COMMENT ON TABLE public.price_move_alert_thresholds IS
  'Row presence = opt-in to Price Move Alerts. Stored value is always 5% percent; same-direction accelerations evaluate at 2.5%. threshold_unit is DEFAULT percent pending a follow-up column drop.';

UPDATE public.app_metadata
SET value = '20260813222000_drop_price_move_threshold_unit'
WHERE key = 'schema_version';
