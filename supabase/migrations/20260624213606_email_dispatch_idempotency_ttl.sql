-- squawk-ignore-file adding-not-nullable-field
-- esf-2 prerequisite: give email_dispatch_idempotency a TTL so the dispatch Lambda can safely
-- KEEP a claim on an ambiguous SES outcome (the send may have happened) without permanently
-- suppressing the email — the claim self-heals after the window, allowing a later retry.
--
-- Adds:
--   * expires_at (default now() + 24h; existing rows backfilled from created_at).
--   * claim_email_dispatch_key(key): atomic claim that RE-CLAIMS an expired key, so a kept
--     claim is recoverable. Returns true when claimed (new or expired-reclaim), false when a
--     live (unexpired) claim already exists.
--   * purge_expired_email_dispatch_keys(): hygiene delete of expired rows (the long-deferred
--     cleanup the created_at index was reserved for), mirroring purge_expired_short_urls.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE public.email_dispatch_idempotency
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

-- Backfill existing rows from their own age (not a flat now()+24h), then lock the column down.
UPDATE public.email_dispatch_idempotency
SET expires_at = created_at + interval '1 day'
WHERE expires_at IS NULL;

-- SET NOT NULL scans the table under ACCESS EXCLUSIVE (squawk adding-not-nullable-field,
-- ignored file-wide at the top), but email_dispatch_idempotency holds a handful of rows (one
-- per auth email, purged on TTL) — the scan is sub-millisecond, and the column is the integrity
-- guarantee for the claim/purge TTL logic. Worth the constraint here.
ALTER TABLE public.email_dispatch_idempotency
  ALTER COLUMN expires_at SET DEFAULT (now() + interval '1 day'),
  ALTER COLUMN expires_at SET NOT NULL;

-- The purge query filters on expires_at; index it (the created_at index is now redundant).
CREATE INDEX IF NOT EXISTS email_dispatch_idempotency_expires_at_idx
  ON public.email_dispatch_idempotency (expires_at);
DROP INDEX IF EXISTS public.email_dispatch_idempotency_created_at_idx;

-- claim_email_dispatch_key upserts (INSERT ... ON CONFLICT DO UPDATE) to reclaim expired keys;
-- the SECURITY INVOKER function runs as service_role, so the table needs UPDATE (it previously
-- granted only select/insert/delete). Mirrors scheduled_notifications' grant for its claim RPC.
GRANT UPDATE ON public.email_dispatch_idempotency TO service_role;

-- Atomic claim with expired-key reclaim. true = claimed (fresh or expired-reclaim);
-- false = a live (unexpired) claim already exists (treat as duplicate, do not send).
CREATE OR REPLACE FUNCTION public.claim_email_dispatch_key(p_key text)
  RETURNS boolean
  LANGUAGE plpgsql
  SET search_path TO public, pg_temp
AS $$
DECLARE
  claimed boolean;
BEGIN
  INSERT INTO public.email_dispatch_idempotency (idempotency_key, created_at, expires_at)
  VALUES (p_key, pg_catalog.now(), pg_catalog.now() + interval '1 day')
  ON CONFLICT (idempotency_key) DO UPDATE
    SET created_at = pg_catalog.now(),
        expires_at = pg_catalog.now() + interval '1 day'
    WHERE public.email_dispatch_idempotency.expires_at < pg_catalog.now()
  RETURNING true INTO claimed;

  RETURN COALESCE(claimed, false);
END;
$$;

-- Hygiene: drop rows whose TTL has lapsed (also reclaimable in-place, but this bounds growth).
CREATE OR REPLACE FUNCTION public.purge_expired_email_dispatch_keys()
  RETURNS integer
  LANGUAGE plpgsql
  SET search_path TO public, pg_temp
AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM public.email_dispatch_idempotency
  WHERE expires_at < pg_catalog.now();
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_email_dispatch_key(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_email_dispatch_key(text) TO service_role;
REVOKE ALL ON FUNCTION public.purge_expired_email_dispatch_keys() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.purge_expired_email_dispatch_keys() TO service_role;

UPDATE public.app_metadata
SET value = '20260624213606_email_dispatch_idempotency_ttl'
WHERE key = 'schema_version';
