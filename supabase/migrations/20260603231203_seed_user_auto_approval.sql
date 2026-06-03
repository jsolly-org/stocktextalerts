-- Allow postgres (migrations, supabase db reset seed) and service_role to set approval fields.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

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

  IF jwt_role = 'service_role' OR current_user = 'postgres' THEN
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

-- Local dev login account from scripts/data/users.json
UPDATE public.users
SET approved_at = COALESCE(approved_at, now()),
    approved_by = COALESCE(approved_by, 'seed')
WHERE email = 'test@jsolly.com'
  AND approved_at IS NULL;

UPDATE public.app_metadata
SET value = '20260603231203_seed_user_auto_approval'
WHERE key = 'schema_version';
