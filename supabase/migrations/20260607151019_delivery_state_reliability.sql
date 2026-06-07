-- Delivery-state reliability: pending price targets, alert reserve/finalize semantics.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE public.price_targets
  ADD COLUMN IF NOT EXISTS triggered_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS triggered_price numeric(12, 4);

ALTER TABLE public.market_asset_price_alert_cooldowns
  ADD COLUMN IF NOT EXISTS delivery_status text NOT NULL DEFAULT 'finalized',
  ADD COLUMN IF NOT EXISTS reserved_at timestamp with time zone;

ALTER TABLE public.price_move_alert_state
  ADD COLUMN IF NOT EXISTS pending_delivery boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pending_new_price numeric(20, 6),
  ADD COLUMN IF NOT EXISTS reserved_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS first_of_day_reservation boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.reserve_market_asset_price_alert_slot(
  p_user_id uuid,
  p_symbol text,
  p_abs_move_percent numeric DEFAULT 0,
  p_abs_move_dollar numeric DEFAULT 0
) RETURNS boolean
  LANGUAGE plpgsql
  SET search_path TO public, pg_temp
AS $$
DECLARE
  reserved boolean;
  claim_local_ts timestamp;
  claim_trading_day date;
  v_abs_move_percent numeric;
  v_abs_move_dollar numeric;
BEGIN
  v_abs_move_percent := GREATEST(COALESCE(p_abs_move_percent, 0), 0);
  v_abs_move_dollar := GREATEST(COALESCE(p_abs_move_dollar, 0), 0);

  claim_local_ts := now() AT TIME ZONE 'America/New_York';
  claim_trading_day := claim_local_ts::date;
  IF claim_local_ts::time >= time '16:00:00' THEN
    claim_trading_day := claim_trading_day + 1;
  END IF;

  INSERT INTO public.market_asset_price_alert_cooldowns (
    user_id,
    symbol,
    last_alerted_at,
    trading_day_key,
    alerts_sent_count,
    max_abs_move_percent,
    max_abs_move_dollar,
    delivery_status,
    reserved_at
  )
  VALUES (
    p_user_id,
    p_symbol,
    now(),
    claim_trading_day,
    0,
    v_abs_move_percent,
    v_abs_move_dollar,
    'reserved',
    now()
  )
  ON CONFLICT (user_id, symbol) DO UPDATE
    SET
      delivery_status = 'reserved',
      reserved_at = now(),
      trading_day_key = claim_trading_day,
      max_abs_move_percent = v_abs_move_percent,
      max_abs_move_dollar = v_abs_move_dollar
    WHERE
      public.market_asset_price_alert_cooldowns.trading_day_key < claim_trading_day
      OR (
        public.market_asset_price_alert_cooldowns.delivery_status = 'reserved'
        AND public.market_asset_price_alert_cooldowns.reserved_at < now() - interval '10 minutes'
      )
  RETURNING true INTO reserved;

  RETURN COALESCE(reserved, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_market_asset_price_alert_slot(
  p_user_id uuid,
  p_symbol text
) RETURNS boolean
  LANGUAGE plpgsql
  SET search_path TO public, pg_temp
AS $$
DECLARE
  finalized boolean;
BEGIN
  UPDATE public.market_asset_price_alert_cooldowns
  SET
    delivery_status = 'finalized',
    last_alerted_at = now(),
    reserved_at = NULL,
    alerts_sent_count = 1
  WHERE user_id = p_user_id
    AND symbol = p_symbol
    AND delivery_status = 'reserved'
  RETURNING true INTO finalized;

  RETURN COALESCE(finalized, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.release_market_asset_price_alert_slot(
  p_user_id uuid,
  p_symbol text
) RETURNS boolean
  LANGUAGE plpgsql
  SET search_path TO public, pg_temp
AS $$
DECLARE
  released boolean;
BEGIN
  DELETE FROM public.market_asset_price_alert_cooldowns
  WHERE user_id = p_user_id
    AND symbol = p_symbol
    AND delivery_status = 'reserved'
  RETURNING true INTO released;

  RETURN COALESCE(released, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.reserve_flat_price_alert(
  p_user_id uuid,
  p_symbol text,
  p_baseline_price numeric,
  p_new_price numeric,
  p_threshold_percent numeric
) RETURNS boolean
  LANGUAGE plpgsql
  SET search_path TO public, pg_temp
AS $$
DECLARE
  current_row public.price_move_alert_state%ROWTYPE;
  today_et date;
  move_pct numeric;
  reserved boolean;
BEGIN
  IF p_baseline_price IS NULL OR p_baseline_price <= 0 THEN
    RETURN false;
  END IF;
  IF p_new_price IS NULL OR p_new_price <= 0 THEN
    RETURN false;
  END IF;
  IF p_threshold_percent IS NULL OR p_threshold_percent <= 0 THEN
    RETURN false;
  END IF;

  today_et := (now() AT TIME ZONE 'America/New_York')::date;
  move_pct := abs((p_new_price - p_baseline_price) / p_baseline_price * 100);

  IF move_pct < p_threshold_percent THEN
    RETURN false;
  END IF;

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
        reserved_at,
        first_of_day_reservation
      ) VALUES (
        p_user_id,
        p_symbol,
        p_baseline_price,
        now(),
        true,
        p_new_price,
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
      reserved_at = now()
    WHERE user_id = p_user_id AND symbol = p_symbol;
    RETURN true;
  END IF;

  IF current_row.last_notification_price = p_baseline_price THEN
    UPDATE public.price_move_alert_state
    SET
      pending_delivery = true,
      pending_new_price = p_new_price,
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
    last_notification_price = pending_new_price,
    last_notification_at = now(),
    pending_delivery = false,
    pending_new_price = NULL,
    reserved_at = NULL,
    first_of_day_reservation = false
  WHERE user_id = p_user_id
    AND symbol = p_symbol
    AND pending_delivery = true
    AND pending_new_price IS NOT NULL
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
    reserved_at = NULL
  WHERE user_id = p_user_id
    AND symbol = p_symbol
    AND pending_delivery = true
  RETURNING true INTO released;

  RETURN COALESCE(released, false);
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_market_asset_price_alert_slot(uuid, text, numeric, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_market_asset_price_alert_slot(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_market_asset_price_alert_slot(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reserve_flat_price_alert(uuid, text, numeric, numeric, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_flat_price_alert(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_flat_price_alert(uuid, text) FROM PUBLIC;

UPDATE public.app_metadata
SET value = '20260607151019_delivery_state_reliability'
WHERE key = 'schema_version';
