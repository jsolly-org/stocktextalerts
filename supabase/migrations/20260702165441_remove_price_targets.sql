-- squawk-ignore-file ban-drop-table,constraint-missing-not-valid
-- Remove the price-targets feature end to end: the per-user price_targets table,
-- its enum, the 'price_targets' notification-preference type, and the
-- price_targets cleanup inside replace_user_assets. The table is empty in prod
-- (0 rows ever); the only live data are notification_preferences toggle rows,
-- deleted below before the CHECK tightens.

set lock_timeout = '5s';
set statement_timeout = '120s';

-- 1. Re-emit replace_user_assets without the price_targets DELETEs. Must run
-- before the table drop: plpgsql resolves table refs at runtime, so a stale
-- body would start throwing once the relation is gone.
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
END;
$$;

-- CREATE OR REPLACE preserves existing privileges, but re-assert the tightened
-- set (20260608180652) so this migration stands alone.
REVOKE ALL ON FUNCTION public.replace_user_assets(uuid, text[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.replace_user_assets(uuid, text[]) TO authenticated, service_role;

-- 2. Clear the live price_targets preference rows before the CHECK tightens.
delete from public.notification_preferences
where notification_type = 'price_targets';

-- 3. Tighten the allowed notification types (drops 'price_targets').
alter table public.notification_preferences
	drop constraint notification_preferences_notification_type_check;

alter table public.notification_preferences
	add constraint notification_preferences_notification_type_check check (
		notification_type in (
			'daily_notification',
			'market_asset_price_alerts',
			'market_scheduled_asset_price',
			'price_move_alerts'
		)
	);

-- 4. Drop the table (cascades PK, FKs, RLS policies, and grants), then the
-- enum once its last user (the direction column) is gone.
drop table public.price_targets;

drop type public.price_target_direction;

update public.app_metadata
set value = '20260702165441_remove_price_targets'
where key = 'schema_version';
