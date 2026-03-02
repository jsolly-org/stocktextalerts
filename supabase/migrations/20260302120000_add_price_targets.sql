-- Price Targets: one-shot price target alerts for watchlist assets.
-- Users set a target price, get notified once when hit, row is auto-deleted.

-- 1. Add price_target_alerts_enabled to users
ALTER TABLE public.users
  ADD COLUMN price_target_alerts_enabled BOOLEAN NOT NULL DEFAULT false;

-- 2. Create price_targets table
CREATE TABLE public.price_targets (
  user_id    UUID         NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  symbol     VARCHAR(10)  NOT NULL REFERENCES public.assets(symbol) ON DELETE CASCADE,
  target_price NUMERIC(12,4) NOT NULL CHECK (target_price > 0),
  direction  TEXT         NOT NULL CHECK (direction IN ('above', 'below')),
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, symbol)
);

-- 3. RLS policies: users can manage their own rows
ALTER TABLE public.price_targets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own price targets"
  ON public.price_targets FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own price targets"
  ON public.price_targets FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own price targets"
  ON public.price_targets FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own price targets"
  ON public.price_targets FOR DELETE
  USING (auth.uid() = user_id);

-- 4. Grant access
GRANT SELECT, INSERT, UPDATE, DELETE ON public.price_targets TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.price_targets TO service_role;

-- 5. Update replace_user_assets to clean up orphaned price targets
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
    -- Clean up all price targets since watchlist is now empty
    DELETE FROM price_targets WHERE price_targets.user_id = replace_user_assets.user_id;
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
    -- Clean up all price targets since no valid symbols remain
    DELETE FROM price_targets WHERE price_targets.user_id = replace_user_assets.user_id;
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
END;
$$;

-- 6. Update schema version
UPDATE public.app_metadata
  SET value = '20260302120000_add_price_targets'
  WHERE key = 'schema_version';
