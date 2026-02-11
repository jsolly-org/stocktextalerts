-- Improve asset search performance for ILIKE prefix/substring matching.
-- Query shape in /api/assets/search uses:
--   symbol ILIKE 'query%' OR name ILIKE '%query%'
-- Trigram GIN indexes accelerate both patterns.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_assets_symbol_trgm
ON public.assets USING gin (symbol gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_assets_name_trgm
ON public.assets USING gin (name gin_trgm_ops);
