-- Prediction-markets weather strip for the daily digest (digest family facet).
-- Adds notification_options rows + a global odds snapshot table for deltas.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

INSERT INTO public.notification_options (notification_type, content, channel) VALUES
  ('daily_notification', 'prediction_markets', 'email'),
  ('daily_notification', 'prediction_markets', 'telegram');

CREATE TABLE IF NOT EXISTS public.prediction_market_odds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    market_key text NOT NULL,
    venue text NOT NULL,
    probability_percent numeric(6,2) NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT prediction_market_odds_pkey PRIMARY KEY (id),
    CONSTRAINT prediction_market_odds_venue_check CHECK (venue IN ('polymarket', 'kalshi')),
    CONSTRAINT prediction_market_odds_probability_check
        CHECK (probability_percent >= 0 AND probability_percent <= 100),
    CONSTRAINT prediction_market_odds_market_key_no_whitespace
        CHECK (public.has_no_whitespace(market_key))
);

ALTER TABLE public.prediction_market_odds OWNER TO postgres;

CREATE INDEX IF NOT EXISTS idx_prediction_market_odds_captured_at
    ON public.prediction_market_odds USING btree (captured_at);

CREATE INDEX IF NOT EXISTS idx_prediction_market_odds_key_captured
    ON public.prediction_market_odds USING btree (market_key, captured_at DESC);

CREATE OR REPLACE FUNCTION public.purge_old_prediction_market_odds(p_retention_days integer DEFAULT 30)
    RETURNS integer
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public'
AS $$
DECLARE
    deleted_count integer;
BEGIN
    DELETE FROM prediction_market_odds
    WHERE captured_at < NOW() - (p_retention_days || ' days')::interval;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;

ALTER FUNCTION public.purge_old_prediction_market_odds(p_retention_days integer) OWNER TO postgres;

ALTER TABLE public.prediction_market_odds ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE public.prediction_market_odds TO service_role;

GRANT EXECUTE ON FUNCTION public.purge_old_prediction_market_odds(integer) TO service_role;
REVOKE ALL ON FUNCTION public.purge_old_prediction_market_odds(integer) FROM PUBLIC;

UPDATE public.app_metadata
SET value = '20260709135736_prediction_markets_digest_facet'
WHERE key = 'schema_version';
