-- Migration: Rename "stocks" to "assets" and add ETF support
-- This migration renames tables, constraints, policies, and functions
-- from stock terminology to asset terminology, drops the exchange column,
-- and adds a type column to support ETFs.

-- =============================================
-- 1. Drop RLS policies (must reference old table/policy names)
-- =============================================

DROP POLICY IF EXISTS "Anyone can view stocks" ON stocks;
DROP POLICY IF EXISTS "Users can view own stocks" ON user_stocks;
DROP POLICY IF EXISTS "Users can insert own stocks" ON user_stocks;
DROP POLICY IF EXISTS "Users can delete own stocks" ON user_stocks;

-- =============================================
-- 2. Revoke old grants
-- =============================================

REVOKE SELECT ON TABLE public.stocks FROM anon, authenticated, service_role;
REVOKE SELECT, INSERT, DELETE ON TABLE public.user_stocks FROM authenticated, service_role;

-- =============================================
-- 3. Drop the old RPC function
-- =============================================

DROP FUNCTION IF EXISTS public.replace_user_stocks(uuid, text[]);

-- =============================================
-- 4. Rename tables
-- =============================================

ALTER TABLE stocks RENAME TO assets;
ALTER TABLE user_stocks RENAME TO user_assets;

-- =============================================
-- 5. Schema changes on assets
-- =============================================

ALTER TABLE assets DROP COLUMN exchange;
ALTER TABLE assets ADD COLUMN type TEXT NOT NULL DEFAULT 'stock'
  CHECK (type IN ('stock', 'etf'));

-- =============================================
-- 6. Rename constraints and indexes
-- =============================================

ALTER TABLE assets RENAME CONSTRAINT stocks_pkey TO assets_pkey;
ALTER TABLE assets RENAME CONSTRAINT stocks_symbol_no_whitespace TO assets_symbol_no_whitespace;
ALTER TABLE user_assets RENAME CONSTRAINT user_stocks_pkey TO user_assets_pkey;

-- Foreign key constraints need special handling — find and rename them
DO $$
DECLARE
  fk_name text;
BEGIN
  -- Rename user_id FK
  SELECT conname INTO fk_name
    FROM pg_constraint
   WHERE conrelid = 'public.user_assets'::regclass
     AND contype = 'f'
     AND confrelid = 'public.users'::regclass;
  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE user_assets RENAME CONSTRAINT %I TO user_assets_user_id_fkey', fk_name);
  END IF;

  -- Rename symbol FK
  SELECT conname INTO fk_name
    FROM pg_constraint
   WHERE conrelid = 'public.user_assets'::regclass
     AND contype = 'f'
     AND confrelid = 'public.assets'::regclass;
  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE user_assets RENAME CONSTRAINT %I TO user_assets_symbol_fkey', fk_name);
  END IF;
END $$;

-- =============================================
-- 7. Recreate RPC function with new names
-- =============================================

CREATE OR REPLACE FUNCTION public.replace_user_assets(
  user_id uuid,
  symbols text[]
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  sanitized_symbols text[];
  sanitized_count integer;
  symbol_with_whitespace text;
  symbol_not_uppercase text;
  duplicate_symbol text;
BEGIN
  DELETE FROM user_assets WHERE user_assets.user_id = replace_user_assets.user_id;

  IF symbols IS NULL OR array_length(symbols, 1) IS NULL THEN
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
END;
$$;

GRANT EXECUTE ON FUNCTION public.replace_user_assets(uuid, text[]) TO authenticated, service_role;

-- =============================================
-- 8. Recreate RLS policies with new names
-- =============================================

-- Assets (public read)
CREATE POLICY "Anyone can view assets" ON assets
  FOR SELECT USING (true);

GRANT SELECT ON TABLE public.assets TO anon, authenticated;
GRANT SELECT ON TABLE public.assets TO service_role;

-- User Assets
CREATE POLICY "Users can view own assets" ON user_assets
  FOR SELECT USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can insert own assets" ON user_assets
  FOR INSERT WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can delete own assets" ON user_assets
  FOR DELETE USING ((SELECT auth.uid()) = user_id);

GRANT SELECT, INSERT, DELETE ON TABLE public.user_assets TO authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.user_assets TO service_role;
