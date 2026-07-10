-- squawk-ignore-file constraint-missing-not-valid
-- (Supabase applies each migration in ONE transaction, so NOT VALID + VALIDATE
-- in the same file is the only option; squawk still wants them split.)
-- Shape-aware prediction-market event cards: event shape + child outcomes,
-- and preserve user_assets.created_at across watchlist saves.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- ---------------------------------------------------------------------------
-- 1. Event shape metadata on prediction_markets (rows are event-level)
-- ---------------------------------------------------------------------------
ALTER TABLE public.prediction_markets
  ADD COLUMN IF NOT EXISTS shape text,
  ADD COLUMN IF NOT EXISTS shape_validated boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS shape_meta jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE public.prediction_markets
SET shape = 'binary',
    shape_validated = (probability_percent IS NOT NULL)
WHERE shape IS NULL;

ALTER TABLE public.prediction_markets
  ALTER COLUMN shape SET DEFAULT 'binary';

-- Prefer CHECK NOT VALID over SET NOT NULL so the scan doesn't block reads
-- (squawk adding-not-nullable-field / constraint-missing-not-valid).
ALTER TABLE public.prediction_markets
  DROP CONSTRAINT IF EXISTS prediction_markets_shape_not_null;
ALTER TABLE public.prediction_markets
  ADD CONSTRAINT prediction_markets_shape_not_null
    CHECK (shape IS NOT NULL) NOT VALID;
ALTER TABLE public.prediction_markets
  VALIDATE CONSTRAINT prediction_markets_shape_not_null;

ALTER TABLE public.prediction_markets
  DROP CONSTRAINT IF EXISTS prediction_markets_shape_check;
ALTER TABLE public.prediction_markets
  ADD CONSTRAINT prediction_markets_shape_check
    CHECK (shape IN ('binary', 'exclusive', 'independent', 'threshold')) NOT VALID;
ALTER TABLE public.prediction_markets
  VALIDATE CONSTRAINT prediction_markets_shape_check;

-- ---------------------------------------------------------------------------
-- 2. Child outcomes / contracts for each stored event
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.prediction_market_outcomes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    prediction_market_id uuid NOT NULL,
    venue_contract_id text NOT NULL,
    label text NOT NULL,
    probability_percent numeric(6,2),
    sort_order integer NOT NULL DEFAULT 0,
    strike_value numeric,
    volume numeric,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT prediction_market_outcomes_pkey PRIMARY KEY (id),
    CONSTRAINT prediction_market_outcomes_market_fkey
        FOREIGN KEY (prediction_market_id)
        REFERENCES public.prediction_markets(id) ON DELETE CASCADE,
    CONSTRAINT prediction_market_outcomes_probability_check
        CHECK (
            probability_percent IS NULL
            OR (probability_percent >= 0 AND probability_percent <= 100)
        ),
    CONSTRAINT prediction_market_outcomes_market_contract_unique
        UNIQUE (prediction_market_id, venue_contract_id),
    CONSTRAINT prediction_market_outcomes_venue_contract_id_no_whitespace
        CHECK (public.has_no_whitespace(venue_contract_id))
);

ALTER TABLE public.prediction_market_outcomes OWNER TO postgres;

CREATE INDEX IF NOT EXISTS idx_prediction_market_outcomes_market_sort
    ON public.prediction_market_outcomes USING btree (prediction_market_id, sort_order);

-- No synthetic Yes/No backfill: contract IDs would diverge from live venue IDs
-- (conditionId vs venue_market_id:yes). The digest read path synthesizes binary
-- legs from scalar probability_percent when outcomes are empty, and the f2
-- rematch below rewrites accepted matches as event-level rows with real outcomes.

ALTER TABLE public.prediction_market_outcomes ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.prediction_market_outcomes TO service_role;

-- ---------------------------------------------------------------------------
-- 2b. Force event-level rematch (matcher f2): clear discovery stamps for tracked
-- symbols and reject pre-f2 accepted matches so the nightly drip re-persists
-- venue_event_id rows instead of refreshing stale contract-level keys.
-- ---------------------------------------------------------------------------
UPDATE public.asset_prediction_market_matches
SET decision = 'rejected',
    evaluated_at = now()
WHERE decision = 'accepted'
  AND matcher_version IS DISTINCT FROM 'f2';

UPDATE public.assets
SET pm_discovery_checked_at = NULL
WHERE pm_discovery_checked_at IS NOT NULL
  AND EXISTS (
      SELECT 1
      FROM public.user_assets ua
      WHERE ua.symbol = assets.symbol
  );

-- ---------------------------------------------------------------------------
-- 3. Preserve user_assets.created_at across replace_user_assets saves
-- ---------------------------------------------------------------------------
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
  IF sanitized_count > 10 THEN
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
SET value = '20260710133830_prediction_market_event_cards'
WHERE key = 'schema_version';
