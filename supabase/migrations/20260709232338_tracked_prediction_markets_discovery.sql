-- Tracked-asset prediction-market discovery: registry, matches, aliases,
-- and icon-style pm_discovery_checked_at for demand-driven backfill.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE public.assets
  ADD COLUMN IF NOT EXISTS pm_discovery_checked_at timestamptz;

CREATE TABLE IF NOT EXISTS public.prediction_markets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    venue text NOT NULL,
    venue_market_id text NOT NULL,
    event_id text,
    series_id text,
    label text NOT NULL,
    question text NOT NULL,
    url text NOT NULL,
    match_kind text NOT NULL,
    probability_percent numeric(6,2),
    volume numeric,
    status text NOT NULL DEFAULT 'open',
    closes_at timestamp with time zone,
    refreshed_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT prediction_markets_pkey PRIMARY KEY (id),
    CONSTRAINT prediction_markets_venue_check CHECK (venue IN ('polymarket', 'kalshi')),
    CONSTRAINT prediction_markets_match_kind_check
        CHECK (match_kind IN ('direct_price', 'kpi', 'company_subject')),
    CONSTRAINT prediction_markets_status_check
        CHECK (status IN ('open', 'closed', 'inactive')),
    CONSTRAINT prediction_markets_probability_check
        CHECK (
            probability_percent IS NULL
            OR (probability_percent >= 0 AND probability_percent <= 100)
        ),
    CONSTRAINT prediction_markets_venue_market_unique UNIQUE (venue, venue_market_id),
    CONSTRAINT prediction_markets_venue_market_id_no_whitespace
        CHECK (public.has_no_whitespace(venue_market_id))
);

ALTER TABLE public.prediction_markets OWNER TO postgres;

CREATE INDEX IF NOT EXISTS idx_prediction_markets_status_refreshed
    ON public.prediction_markets USING btree (status, refreshed_at DESC);

CREATE TABLE IF NOT EXISTS public.asset_prediction_market_matches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    symbol text NOT NULL,
    prediction_market_id uuid NOT NULL,
    match_kind text NOT NULL,
    confidence numeric(5,2) NOT NULL DEFAULT 0,
    evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    decision text NOT NULL DEFAULT 'accepted',
    matcher_version text NOT NULL,
    evaluated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT asset_prediction_market_matches_pkey PRIMARY KEY (id),
    CONSTRAINT asset_prediction_market_matches_symbol_fkey
        FOREIGN KEY (symbol) REFERENCES public.assets(symbol) ON DELETE CASCADE,
    CONSTRAINT asset_prediction_market_matches_market_fkey
        FOREIGN KEY (prediction_market_id) REFERENCES public.prediction_markets(id) ON DELETE CASCADE,
    CONSTRAINT asset_prediction_market_matches_match_kind_check
        CHECK (match_kind IN ('direct_price', 'kpi', 'company_subject')),
    CONSTRAINT asset_prediction_market_matches_decision_check
        CHECK (decision IN ('accepted', 'rejected', 'manual_include', 'manual_exclude')),
    CONSTRAINT asset_prediction_market_matches_symbol_market_unique
        UNIQUE (symbol, prediction_market_id)
);

ALTER TABLE public.asset_prediction_market_matches OWNER TO postgres;

CREATE INDEX IF NOT EXISTS idx_asset_pm_matches_symbol_decision
    ON public.asset_prediction_market_matches USING btree (symbol, decision);

CREATE INDEX IF NOT EXISTS idx_asset_pm_matches_market_id
    ON public.asset_prediction_market_matches USING btree (prediction_market_id);

CREATE TABLE IF NOT EXISTS public.asset_prediction_aliases (
    symbol text NOT NULL,
    aliases text[] NOT NULL DEFAULT '{}'::text[],
    enriched_at timestamp with time zone,
    status text NOT NULL DEFAULT 'pending',
    CONSTRAINT asset_prediction_aliases_pkey PRIMARY KEY (symbol),
    CONSTRAINT asset_prediction_aliases_symbol_fkey
        FOREIGN KEY (symbol) REFERENCES public.assets(symbol) ON DELETE CASCADE,
    CONSTRAINT asset_prediction_aliases_status_check
        CHECK (status IN ('pending', 'enriched', 'skipped', 'failed'))
);

ALTER TABLE public.asset_prediction_aliases OWNER TO postgres;

ALTER TABLE public.prediction_markets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asset_prediction_market_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asset_prediction_aliases ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE public.prediction_markets TO service_role;
GRANT ALL ON TABLE public.asset_prediction_market_matches TO service_role;
GRANT ALL ON TABLE public.asset_prediction_aliases TO service_role;

-- assets already grants SELECT/UPDATE to service_role; pm_discovery_checked_at
-- rides that existing UPDATE grant.

UPDATE public.app_metadata
SET value = '20260709232338_tracked_prediction_markets_discovery'
WHERE key = 'schema_version';
