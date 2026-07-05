-- Redesign flat "5%" price-move alerts into per-stock configurable thresholds.
-- Each tracked asset can carry its own threshold expressed as a percent OR an
-- absolute-dollar single-day move (one unit per stock, opt-in). Adds the
-- per-(user, symbol) threshold table, generalizes the reserve RPC to be
-- unit-aware, prunes thresholds on watchlist edits, and seeds a 5%-percent
-- threshold for every tracked asset of users who currently have the alert on.

set lock_timeout = '5s';
set statement_timeout = '120s';

-- ============================================================================
-- 1. Per-(user, symbol) threshold. Row presence = alerts enabled for that
--    asset. Mirrors the FK + grant shape of price_move_alert_state. The unit is
--    a Postgres enum (repo convention since 20260626173000) so generated types
--    narrow at the source instead of via casts.
-- ============================================================================
CREATE TYPE public.price_move_threshold_unit AS ENUM ('percent', 'dollar');

CREATE TABLE IF NOT EXISTS public.price_move_alert_thresholds (
  user_id uuid NOT NULL,
  symbol varchar(10) NOT NULL,
  threshold_value numeric(12,4) NOT NULL,
  threshold_unit public.price_move_threshold_unit NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT price_move_alert_thresholds_pkey PRIMARY KEY (user_id, symbol),
  CONSTRAINT price_move_alert_thresholds_value_check CHECK (threshold_value > 0),
  CONSTRAINT price_move_alert_thresholds_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT price_move_alert_thresholds_symbol_fkey
    FOREIGN KEY (symbol) REFERENCES public.assets(symbol) ON DELETE CASCADE
);

ALTER TABLE public.price_move_alert_thresholds OWNER TO postgres;

-- Covering index for the symbol FK (the PK leads with user_id); the delisting
-- sweep deletes assets rows, and each delete FK-checks this table.
CREATE INDEX idx_price_move_alert_thresholds_symbol
  ON public.price_move_alert_thresholds USING btree (symbol);

COMMENT ON TABLE public.price_move_alert_thresholds IS
  'Per-user per-symbol price-move alert threshold (opt-in). Row presence enables alerts for that asset; threshold_unit selects percent vs absolute-dollar single-day move.';

-- Session client (via replace_user_assets, SECURITY INVOKER) prunes rows on
-- watchlist edits; the server (service_role) reads them in the scheduler and
-- writes them from the dashboard endpoint. Mirrors price_move_alert_state.
GRANT DELETE, SELECT ON TABLE public.price_move_alert_thresholds TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.price_move_alert_thresholds TO service_role;

-- User-authored settings ride the nightly user-settings backup (row presence =
-- alerts enabled, so a restore without this table silently disables alerts).
-- Pair with the BACKUP_TABLES entry in src/lib/backup/constants.ts.
GRANT SELECT ON TABLE public.price_move_alert_thresholds TO backup_readonly;

-- RLS scopes the authenticated grants to the owner's rows (mirrors
-- price_move_alert_state). service_role (dashboard endpoint writes) bypasses RLS;
-- INSERT/UPDATE therefore go through the server only — no authenticated policy for
-- them. SELECT (dashboard read) and DELETE (replace_user_assets, SECURITY INVOKER)
-- are owner-scoped.
ALTER TABLE public.price_move_alert_thresholds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view their own price-move thresholds" ON public.price_move_alert_thresholds
  FOR SELECT
  USING (auth.uid() = user_id AND public.is_approved());

CREATE POLICY "Users delete their own price-move thresholds" ON public.price_move_alert_thresholds
  FOR DELETE
  USING (auth.uid() = user_id AND public.is_approved());

-- ============================================================================
-- 2. Generalize reserve_flat_price_alert: swap the fixed p_threshold_percent
--    for a (value, unit) pair and compute the move in the requested unit.
--    Baseline / first-of-day / re-trigger semantics are unchanged.
-- ============================================================================
DROP FUNCTION IF EXISTS public.reserve_flat_price_alert(uuid, text, numeric, numeric, numeric);

CREATE FUNCTION public.reserve_flat_price_alert(
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

REVOKE ALL ON FUNCTION public.reserve_flat_price_alert(uuid, text, numeric, numeric, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_flat_price_alert(uuid, text, numeric, numeric, numeric, text) TO service_role;

-- ============================================================================
-- 3. Prune threshold rows on watchlist edits, mirroring the existing
--    price_move_alert_state cleanup inside replace_user_assets.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.replace_user_assets(user_id uuid, symbols text[])
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  jwt_role text;
  sanitized_symbols text[];
  sanitized_count integer;
  symbol_with_whitespace text;
  symbol_not_uppercase text;
  duplicate_symbol text;
BEGIN
  jwt_role := COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::json->>'role';

  IF jwt_role IS NULL OR jwt_role NOT IN ('authenticated', 'service_role') THEN
    RAISE EXCEPTION 'replace_user_assets: role must be authenticated or service_role, got: %',
      COALESCE(jwt_role, '<null>')
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF jwt_role = 'authenticated' THEN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'replace_user_assets: authenticated role requires auth.uid() to be set'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF replace_user_assets.user_id <> auth.uid() THEN
      RAISE EXCEPTION 'replace_user_assets: cannot replace assets for another user (user_id=%, auth.uid=%)',
        replace_user_assets.user_id,
        auth.uid()
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT public.is_approved() THEN
      RAISE EXCEPTION 'replace_user_assets: user is not approved'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  DELETE FROM user_assets WHERE user_assets.user_id = replace_user_assets.user_id;

  IF symbols IS NULL OR array_length(symbols, 1) IS NULL THEN
    DELETE FROM price_move_alert_state WHERE price_move_alert_state.user_id = replace_user_assets.user_id;
    DELETE FROM price_move_alert_thresholds WHERE price_move_alert_thresholds.user_id = replace_user_assets.user_id;
    RETURN;
  END IF;

  SELECT entry INTO symbol_with_whitespace
  FROM unnest(symbols) AS raw(entry)
  WHERE NOT public.has_no_whitespace(entry)
  LIMIT 1;

  IF symbol_with_whitespace IS NOT NULL THEN
    RAISE EXCEPTION 'Asset symbol contains whitespace'
      USING ERRCODE = 'check_violation',
            DETAIL = symbol_with_whitespace;
  END IF;

  SELECT entry INTO symbol_not_uppercase
  FROM unnest(symbols) AS raw(entry)
  WHERE entry <> '' AND entry <> UPPER(entry)
  LIMIT 1;

  IF symbol_not_uppercase IS NOT NULL THEN
    RAISE EXCEPTION 'Asset symbol is not uppercase: %', symbol_not_uppercase
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT entry INTO duplicate_symbol
  FROM (
    SELECT entry, COUNT(*) as cnt
    FROM unnest(symbols) AS raw(entry)
    WHERE entry <> ''
    GROUP BY entry
    HAVING COUNT(*) > 1
    LIMIT 1
  ) duplicates;

  IF duplicate_symbol IS NOT NULL THEN
    RAISE EXCEPTION 'Duplicate asset symbol: %', duplicate_symbol
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT ARRAY(
    SELECT entry AS symbol
    FROM unnest(symbols) AS raw(entry)
    WHERE entry <> ''
  ) INTO sanitized_symbols;

  IF sanitized_symbols IS NULL OR array_length(sanitized_symbols, 1) IS NULL THEN
    DELETE FROM price_move_alert_state WHERE price_move_alert_state.user_id = replace_user_assets.user_id;
    DELETE FROM price_move_alert_thresholds WHERE price_move_alert_thresholds.user_id = replace_user_assets.user_id;
    RETURN;
  END IF;

  SELECT array_length(sanitized_symbols, 1) INTO sanitized_count;
  IF sanitized_count > 10 THEN
    RAISE EXCEPTION 'Tracked assets limit exceeded'
      USING ERRCODE = 'check_violation',
        CONSTRAINT = 'user_assets_max_limit';
  END IF;

  INSERT INTO user_assets (user_id, symbol)
  SELECT replace_user_assets.user_id, symbol
  FROM unnest(sanitized_symbols) AS symbol;

  DELETE FROM price_move_alert_state
  WHERE price_move_alert_state.user_id = replace_user_assets.user_id
    AND price_move_alert_state.symbol <> ALL(sanitized_symbols);

  DELETE FROM price_move_alert_thresholds
  WHERE price_move_alert_thresholds.user_id = replace_user_assets.user_id
    AND price_move_alert_thresholds.symbol <> ALL(sanitized_symbols);
END;
$$;

-- CREATE OR REPLACE preserves existing privileges, but re-assert the tightened
-- set (20260608180652) so this migration stands alone.
REVOKE ALL ON FUNCTION public.replace_user_assets(uuid, text[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.replace_user_assets(uuid, text[]) TO authenticated, service_role;

-- ============================================================================
-- 4. Migrate existing users: replicate a 5%-percent threshold for every tracked
--    asset of users who currently have the price-move alert on (any channel).
-- ============================================================================
INSERT INTO public.price_move_alert_thresholds (user_id, symbol, threshold_value, threshold_unit)
SELECT ua.user_id, ua.symbol, 5, 'percent'
FROM public.user_assets ua
WHERE EXISTS (
  SELECT 1 FROM public.notification_preferences np
  WHERE np.user_id = ua.user_id
    AND np.notification_type = 'price_move_alerts'
    AND np.enabled = true
)
ON CONFLICT (user_id, symbol) DO NOTHING;

-- Bump schema version (see AGENTS.md -> Testing schema_version).
UPDATE public.app_metadata
SET value = '20260704232147_price_move_alert_thresholds'
WHERE key = 'schema_version';
