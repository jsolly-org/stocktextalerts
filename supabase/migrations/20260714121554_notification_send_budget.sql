-- Per-user ET-day notification volume budgets.
-- Global: 40 delivered channel messages / user / America/New_York day.
-- Price-move local: 20 / user / day (also counts toward global).
-- Market + daily scheduled types consume global only (structural slot caps
-- remain their local bound). Ops emails (delisting / registration-admin) are
-- outside this table.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS public.notification_budget (
  user_id uuid NOT NULL,
  window_date date NOT NULL,
  global_count integer NOT NULL DEFAULT 0,
  price_move_count integer NOT NULL DEFAULT 0,
  CONSTRAINT notification_budget_pkey PRIMARY KEY (user_id, window_date),
  CONSTRAINT notification_budget_global_count_check CHECK (global_count >= 0),
  CONSTRAINT notification_budget_price_move_count_check CHECK (price_move_count >= 0),
  CONSTRAINT notification_budget_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
);

ALTER TABLE public.notification_budget OWNER TO postgres;

COMMENT ON TABLE public.notification_budget IS
  'Per-user America/New_York calendar-day counters for outbound product notification volume. global_count caps all product sends; price_move_count caps price-move alerts only.';

REVOKE ALL ON TABLE public.notification_budget FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.notification_budget TO service_role;

-- Server-only counters: no client policies. service_role bypasses RLS.
ALTER TABLE public.notification_budget ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- try_consume_notification_budget — atomic reserve before send (fail closed).
-- p_kind: price_move_alerts | market_scheduled_asset_price | daily_notification
-- ============================================================================
CREATE OR REPLACE FUNCTION public.try_consume_notification_budget(
  p_user_id uuid,
  p_kind text,
  p_count integer DEFAULT 1
) RETURNS boolean
  LANGUAGE plpgsql
  SET search_path TO public, pg_temp
AS $$
DECLARE
  today_et date;
  row_global integer;
  row_price_move integer;
  global_cap constant integer := 40;
  price_move_cap constant integer := 20;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN false;
  END IF;
  IF p_count IS NULL OR p_count < 1 THEN
    RETURN false;
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN (
    'price_move_alerts',
    'market_scheduled_asset_price',
    'daily_notification'
  ) THEN
    RETURN false;
  END IF;

  today_et := (now() AT TIME ZONE 'America/New_York')::date;

  INSERT INTO public.notification_budget (user_id, window_date, global_count, price_move_count)
  VALUES (p_user_id, today_et, 0, 0)
  ON CONFLICT (user_id, window_date) DO NOTHING;

  SELECT global_count, price_move_count
  INTO row_global, row_price_move
  FROM public.notification_budget
  WHERE user_id = p_user_id AND window_date = today_et
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF row_global + p_count > global_cap THEN
    RETURN false;
  END IF;

  IF p_kind = 'price_move_alerts' AND row_price_move + p_count > price_move_cap THEN
    RETURN false;
  END IF;

  IF p_kind = 'price_move_alerts' THEN
    UPDATE public.notification_budget
    SET
      global_count = global_count + p_count,
      price_move_count = price_move_count + p_count
    WHERE user_id = p_user_id AND window_date = today_et;
  ELSE
    UPDATE public.notification_budget
    SET global_count = global_count + p_count
    WHERE user_id = p_user_id AND window_date = today_et;
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.try_consume_notification_budget(uuid, text, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.try_consume_notification_budget(uuid, text, integer)
  TO service_role;

-- ============================================================================
-- release_notification_budget — refund after a failed send that already consumed.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.release_notification_budget(
  p_user_id uuid,
  p_kind text,
  p_count integer DEFAULT 1
) RETURNS void
  LANGUAGE plpgsql
  SET search_path TO public, pg_temp
AS $$
DECLARE
  today_et date;
BEGIN
  IF p_user_id IS NULL OR p_count IS NULL OR p_count < 1 THEN
    RETURN;
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN (
    'price_move_alerts',
    'market_scheduled_asset_price',
    'daily_notification'
  ) THEN
    RETURN;
  END IF;

  today_et := (now() AT TIME ZONE 'America/New_York')::date;

  IF p_kind = 'price_move_alerts' THEN
    UPDATE public.notification_budget
    SET
      global_count = GREATEST(0, global_count - p_count),
      price_move_count = GREATEST(0, price_move_count - p_count)
    WHERE user_id = p_user_id AND window_date = today_et;
  ELSE
    UPDATE public.notification_budget
    SET global_count = GREATEST(0, global_count - p_count)
    WHERE user_id = p_user_id AND window_date = today_et;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.release_notification_budget(uuid, text, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.release_notification_budget(uuid, text, integer)
  TO service_role;

UPDATE public.app_metadata
SET value = '20260714121554_notification_send_budget'
WHERE key = 'schema_version';
