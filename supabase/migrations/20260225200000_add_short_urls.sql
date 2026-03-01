-- Self-hosted URL shortener table for SMS messages.
-- Short IDs (6-char base62) map to original URLs for 302 redirects.

CREATE TABLE IF NOT EXISTS public.short_urls (
  id text PRIMARY KEY CHECK (char_length(id) = 6),
  original_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days')
);

-- Deduplication lookups: avoid creating multiple short IDs for the same URL.
CREATE INDEX IF NOT EXISTS idx_short_urls_original_url ON public.short_urls (original_url);

-- Cleanup queries: efficiently find and delete expired rows.
CREATE INDEX IF NOT EXISTS idx_short_urls_expires_at ON public.short_urls (expires_at);

-- RLS: only service_role can access short URLs.
ALTER TABLE public.short_urls ENABLE ROW LEVEL SECURITY;

-- Purge expired short URLs. Returns the number of rows deleted.
CREATE OR REPLACE FUNCTION public.purge_expired_short_urls()
RETURNS bigint
LANGUAGE sql
VOLATILE
SET search_path = public, pg_temp
AS $$
  WITH deleted AS (
    DELETE FROM public.short_urls
    WHERE expires_at < now()
    RETURNING 1
  )
  SELECT count(*) FROM deleted;
$$;

-- Update schema version for test infrastructure.
UPDATE public.app_metadata
  SET value = '20260225200000_add_short_urls'
  WHERE key = 'schema_version';
