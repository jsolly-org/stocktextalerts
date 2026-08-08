-- Raise replace_user_assets tracked-asset ceiling from 10 → 50 (matches
-- MAX_TRACKED_ASSETS in src/lib/db/database-errors.ts). Function body copied from
-- 20260710133830_prediction_market_event_cards.sql with only the limit changed.

SET lock_timeout = '5s';
SET statement_timeout = '60s';

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

  IF symbols IS NULL OR array_length(symbols, 1) IS NULL THEN
    DELETE FROM user_assets WHERE user_assets.user_id = replace_user_assets.user_id;
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
    DELETE FROM user_assets WHERE user_assets.user_id = replace_user_assets.user_id;
    DELETE FROM price_move_alert_state WHERE price_move_alert_state.user_id = replace_user_assets.user_id;
    DELETE FROM price_move_alert_thresholds WHERE price_move_alert_thresholds.user_id = replace_user_assets.user_id;
    RETURN;
  END IF;

  SELECT array_length(sanitized_symbols, 1) INTO sanitized_count;
  IF sanitized_count > 50 THEN
    RAISE EXCEPTION 'Tracked assets limit exceeded'
      USING ERRCODE = 'check_violation',
        CONSTRAINT = 'user_assets_max_limit';
  END IF;

  -- Drop symbols no longer in the list (preserves created_at for survivors).
  DELETE FROM user_assets
  WHERE user_assets.user_id = replace_user_assets.user_id
    AND user_assets.symbol <> ALL(sanitized_symbols);

  -- Insert only newly tracked symbols; existing rows keep their created_at.
  -- Use ON CONSTRAINT (not column inference) so the function parameter `user_id`
  -- does not collide with ON CONFLICT target columns.
  INSERT INTO user_assets (user_id, symbol)
  SELECT replace_user_assets.user_id, entry
  FROM unnest(sanitized_symbols) AS raw(entry)
  ON CONFLICT ON CONSTRAINT user_assets_pkey DO NOTHING;

  DELETE FROM price_move_alert_state
  WHERE price_move_alert_state.user_id = replace_user_assets.user_id
    AND price_move_alert_state.symbol <> ALL(sanitized_symbols);

  DELETE FROM price_move_alert_thresholds
  WHERE price_move_alert_thresholds.user_id = replace_user_assets.user_id
    AND price_move_alert_thresholds.symbol <> ALL(sanitized_symbols);
END;
$$;

REVOKE ALL ON FUNCTION public.replace_user_assets(uuid, text[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.replace_user_assets(uuid, text[]) TO authenticated, service_role;

UPDATE public.app_metadata
SET value = '20260808165201_raise_tracked_assets_limit_50'
WHERE key = 'schema_version';
