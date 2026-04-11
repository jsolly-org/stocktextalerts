-- Flat Price Alerts: email-only notification that fires whenever a tracked
-- asset moves ≥5% in a trading day. First alert is measured from prev close;
-- re-triggers fire on each additional ±5% move from the last alert price.
-- Applies uniformly to every asset (stocks + ETFs), hard-coded 5% threshold.
-- Independent from the anomaly-based market_asset_price_alerts_*.

-- 1. Add price_move_alerts_enabled to users
ALTER TABLE public.users
  ADD COLUMN price_move_alerts_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.users.price_move_alerts_enabled IS
  'Email-only 5% price move alerts. First alert measured from prev close; re-triggers on each ±5% move from last alert price. Independent of market_asset_price_alerts_*.';

-- 2. Create price_move_alert_state table
CREATE TABLE public.price_move_alert_state (
  user_id                 UUID         NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  symbol                  VARCHAR(10)  NOT NULL REFERENCES public.assets(symbol) ON DELETE CASCADE,
  last_notification_price NUMERIC(20,6) NOT NULL CHECK (last_notification_price > 0),
  last_notification_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, symbol)
);

CREATE INDEX idx_price_move_alert_state_user
  ON public.price_move_alert_state (user_id);

COMMENT ON TABLE public.price_move_alert_state IS
  'Per-user per-symbol state for flat price alerts. Row presence + last_notification_at ET date drive baseline selection (last_notification_price vs quote.prev_close).';

-- 3. RLS: users can only access their own rows (enforced by policies).
--    The cron Lambda uses service_role which bypasses RLS. Authenticated
--    users need SELECT + DELETE on their own rows so replace_user_assets()
--    watchlist cleanup works — Postgres DELETE with a WHERE clause requires
--    SELECT privilege to evaluate the predicate. Matches the grant pattern
--    used by price_targets.
ALTER TABLE public.price_move_alert_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view their own flat price alert state"
  ON public.price_move_alert_state FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users delete their own flat price alert state"
  ON public.price_move_alert_state FOR DELETE
  USING (auth.uid() = user_id);

GRANT SELECT, DELETE ON public.price_move_alert_state TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.price_move_alert_state TO service_role;

-- 4. Atomic claim RPC.
--
-- Contract: caller computes the baseline externally (either quote.prev_close
-- on first-of-day, or their view of the row's last_notification_price on
-- re-trigger). RPC re-validates atomically under row lock and upserts only if
-- the move crosses the threshold AND the row state still matches the caller's
-- view. Returns true when an alert slot was claimed, false otherwise.
--
-- Race safety: SELECT ... FOR UPDATE serializes concurrent claims on the same
-- (user_id, symbol). If another cron tick updated the row between the caller's
-- read and this call, the optimistic check on last_notification_price fails
-- and we return false — caller skips this tick and will re-evaluate on the
-- next cron run with fresh state.
CREATE OR REPLACE FUNCTION public.claim_flat_price_alert(
  p_user_id uuid,
  p_symbol text,
  p_baseline_price numeric,
  p_new_price numeric,
  p_threshold_percent numeric
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  current_row public.price_move_alert_state%ROWTYPE;
  today_et date;
  move_pct numeric;
BEGIN
  -- Defensive input validation
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

  -- Lock the row (or no row) for the duration of the transaction
  SELECT * INTO current_row
  FROM public.price_move_alert_state
  WHERE user_id = p_user_id AND symbol = p_symbol
  FOR UPDATE;

  IF NOT FOUND THEN
    -- Case 1: first-of-day, no row exists
    BEGIN
      INSERT INTO public.price_move_alert_state (
        user_id, symbol, last_notification_price, last_notification_at
      ) VALUES (
        p_user_id, p_symbol, p_new_price, now()
      );
      RETURN true;
    EXCEPTION WHEN unique_violation THEN
      -- Another concurrent insert beat us
      RETURN false;
    END;
  END IF;

  -- Row exists. Check if it's from a prior trading day (ET).
  IF (current_row.last_notification_at AT TIME ZONE 'America/New_York')::date < today_et THEN
    -- Case 2: stale row from yesterday or earlier, refresh unconditionally
    UPDATE public.price_move_alert_state
    SET last_notification_price = p_new_price,
        last_notification_at = now()
    WHERE user_id = p_user_id AND symbol = p_symbol;
    RETURN true;
  END IF;

  -- Case 3: row from today. Caller's baseline must match the row's current
  -- last_notification_price (optimistic lock) to prevent double-alerts from
  -- overlapping cron ticks.
  IF current_row.last_notification_price = p_baseline_price THEN
    UPDATE public.price_move_alert_state
    SET last_notification_price = p_new_price,
        last_notification_at = now()
    WHERE user_id = p_user_id AND symbol = p_symbol;
    RETURN true;
  END IF;

  -- Race lost: another tick re-triggered this symbol between caller's read
  -- and this call. Back off.
  RETURN false;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_flat_price_alert(uuid, text, numeric, numeric, numeric)
  TO service_role;

-- 5. Update replace_user_assets to clean up orphaned price_move_alert_state
--    rows when a symbol is removed from a user's watchlist. Matches the
--    pattern used for price_targets cleanup.
CREATE OR REPLACE FUNCTION public.replace_user_assets(
  user_id uuid,
  symbols text[]
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
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
  END IF;

  DELETE FROM user_assets WHERE user_assets.user_id = replace_user_assets.user_id;

  -- Return without further modification when symbols is NULL/empty (DELETE already ran for clear-all case).
  IF symbols IS NULL OR array_length(symbols, 1) IS NULL THEN
    -- Clean up all price targets and flat-alert state since watchlist is now empty
    DELETE FROM price_targets WHERE price_targets.user_id = replace_user_assets.user_id;
    DELETE FROM price_move_alert_state WHERE price_move_alert_state.user_id = replace_user_assets.user_id;
    RETURN;
  END IF;

  -- Reject symbols with any whitespace
  SELECT entry INTO symbol_with_whitespace
  FROM unnest(symbols) AS raw(entry)
  WHERE NOT public.has_no_whitespace(entry)
  LIMIT 1;

  IF symbol_with_whitespace IS NOT NULL THEN
    RAISE EXCEPTION 'Asset symbol contains whitespace'
      USING ERRCODE = 'check_violation',
            DETAIL = symbol_with_whitespace;
  END IF;

  -- Reject symbols that are not uppercase
  SELECT entry INTO symbol_not_uppercase
  FROM unnest(symbols) AS raw(entry)
  WHERE entry <> '' AND entry <> UPPER(entry)
  LIMIT 1;

  IF symbol_not_uppercase IS NOT NULL THEN
    RAISE EXCEPTION 'Asset symbol is not uppercase: %', symbol_not_uppercase
      USING ERRCODE = 'check_violation';
  END IF;

  -- Reject duplicate symbols
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
    -- Clean up all price targets and flat-alert state since no valid symbols remain
    DELETE FROM price_targets WHERE price_targets.user_id = replace_user_assets.user_id;
    DELETE FROM price_move_alert_state WHERE price_move_alert_state.user_id = replace_user_assets.user_id;
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

  -- Clean up price targets for symbols no longer in the watchlist
  DELETE FROM price_targets
  WHERE price_targets.user_id = replace_user_assets.user_id
    AND price_targets.symbol <> ALL(sanitized_symbols);

  -- Clean up flat-alert state for symbols no longer in the watchlist
  DELETE FROM price_move_alert_state
  WHERE price_move_alert_state.user_id = replace_user_assets.user_id
    AND price_move_alert_state.symbol <> ALL(sanitized_symbols);
END;
$$;

-- 6. Update schema version
UPDATE public.app_metadata
  SET value = '20260410130000_add_flat_price_alerts'
  WHERE key = 'schema_version';
