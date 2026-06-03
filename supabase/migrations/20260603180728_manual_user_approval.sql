-- Require manual approval before newly registered users can use the app.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE public.users
  ADD COLUMN approved_at timestamp with time zone,
  ADD COLUMN approved_by text;

COMMENT ON COLUMN public.users.approved_at IS
  'When non-null, the user has been manually approved for app access.';
COMMENT ON COLUMN public.users.approved_by IS
  'Free-form operator identifier for the person or process that approved the user.';

UPDATE public.users
SET approved_at = COALESCE(approved_at, now()),
    approved_by = COALESCE(approved_by, 'migration')
WHERE approved_at IS NULL;

CREATE OR REPLACE FUNCTION public.prevent_user_approval_self_change()
RETURNS trigger
  LANGUAGE plpgsql
  SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  jwt_role text;
BEGIN
  jwt_role := COALESCE(
    NULLIF(current_setting('request.jwt.claims', true), '')::json->>'role',
    ''
  );

  IF jwt_role = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT'
     AND (NEW.approved_at IS NOT NULL OR NEW.approved_by IS NOT NULL) THEN
    RAISE EXCEPTION 'approval fields can only be set by an administrator';
  END IF;

  IF TG_OP = 'UPDATE'
     AND (OLD.approved_at IS DISTINCT FROM NEW.approved_at
          OR OLD.approved_by IS DISTINCT FROM NEW.approved_by) THEN
    RAISE EXCEPTION 'approval fields can only be changed by an administrator';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER prevent_user_approval_self_change
  BEFORE INSERT OR UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_user_approval_self_change();

CREATE OR REPLACE FUNCTION public.is_approved()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    WHERE u.id = auth.uid()
      AND u.approved_at IS NOT NULL
  );
$$;

COMMENT ON FUNCTION public.is_approved() IS
  'True when the current JWT user has a non-null users.approved_at.';

GRANT EXECUTE ON FUNCTION public.is_approved() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_approved() TO service_role;

-- Require approval for authenticated access to user-owned data.
DROP POLICY IF EXISTS "Users can delete own assets" ON public.user_assets;
CREATE POLICY "Users can delete own assets" ON public.user_assets
  FOR DELETE
  USING (auth.uid() = user_id AND public.is_approved());

DROP POLICY IF EXISTS "Users can insert own assets" ON public.user_assets;
CREATE POLICY "Users can insert own assets" ON public.user_assets
  FOR INSERT
  WITH CHECK (auth.uid() = user_id AND public.is_approved());

DROP POLICY IF EXISTS "Users can view own assets" ON public.user_assets;
CREATE POLICY "Users can view own assets" ON public.user_assets
  FOR SELECT
  USING (auth.uid() = user_id AND public.is_approved());

DROP POLICY IF EXISTS "Users can delete own profile" ON public.users;
CREATE POLICY "Users can delete own profile" ON public.users
  FOR DELETE
  USING (auth.uid() = id AND public.is_approved());

DROP POLICY IF EXISTS "Users can insert own profile" ON public.users;
CREATE POLICY "Users can insert own profile" ON public.users
  FOR INSERT
  WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "Users can update own profile" ON public.users;
CREATE POLICY "Users can update own profile" ON public.users
  FOR UPDATE
  USING (auth.uid() = id AND public.is_approved())
  WITH CHECK (auth.uid() = id AND public.is_approved());

DROP POLICY IF EXISTS "Users can view own profile" ON public.users;
CREATE POLICY "Users can view own profile" ON public.users
  FOR SELECT
  USING (auth.uid() = id);

DROP POLICY IF EXISTS "Users can delete their own price targets" ON public.price_targets;
CREATE POLICY "Users can delete their own price targets" ON public.price_targets
  FOR DELETE
  USING (auth.uid() = user_id AND public.is_approved());

DROP POLICY IF EXISTS "Users can insert their own price targets" ON public.price_targets;
CREATE POLICY "Users can insert their own price targets" ON public.price_targets
  FOR INSERT
  WITH CHECK (auth.uid() = user_id AND public.is_approved());

DROP POLICY IF EXISTS "Users can update their own price targets" ON public.price_targets;
CREATE POLICY "Users can update their own price targets" ON public.price_targets
  FOR UPDATE
  USING (auth.uid() = user_id AND public.is_approved())
  WITH CHECK (auth.uid() = user_id AND public.is_approved());

DROP POLICY IF EXISTS "Users can view their own price targets" ON public.price_targets;
CREATE POLICY "Users can view their own price targets" ON public.price_targets
  FOR SELECT
  USING (auth.uid() = user_id AND public.is_approved());

DROP POLICY IF EXISTS "Users can manage own rate limit records" ON public.rate_limit_log;
CREATE POLICY "Users can manage own rate limit records" ON public.rate_limit_log
  USING (auth.uid() = user_id AND public.is_approved())
  WITH CHECK (auth.uid() = user_id AND public.is_approved());

DROP POLICY IF EXISTS "Users can view own notifications" ON public.notification_log;
CREATE POLICY "Users can view own notifications" ON public.notification_log
  FOR SELECT
  USING (auth.uid() = user_id AND public.is_approved());

DROP POLICY IF EXISTS "Users delete their own flat price alert state" ON public.price_move_alert_state;
CREATE POLICY "Users delete their own flat price alert state" ON public.price_move_alert_state
  FOR DELETE
  USING (auth.uid() = user_id AND public.is_approved());

DROP POLICY IF EXISTS "Users view their own flat price alert state" ON public.price_move_alert_state;
CREATE POLICY "Users view their own flat price alert state" ON public.price_move_alert_state
  FOR SELECT
  USING (auth.uid() = user_id AND public.is_approved());

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
    DELETE FROM price_targets WHERE price_targets.user_id = replace_user_assets.user_id;
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

  DELETE FROM price_targets
  WHERE price_targets.user_id = replace_user_assets.user_id
    AND price_targets.symbol <> ALL(sanitized_symbols);

  DELETE FROM price_move_alert_state
  WHERE price_move_alert_state.user_id = replace_user_assets.user_id
    AND price_move_alert_state.symbol <> ALL(sanitized_symbols);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.replace_user_assets(uuid, text[]) FROM anon;

UPDATE public.app_metadata
SET value = '20260603180728_manual_user_approval'
WHERE key = 'schema_version';
