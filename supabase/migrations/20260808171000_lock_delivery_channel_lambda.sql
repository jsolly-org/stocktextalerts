-- Restrict delivery_channel=lambda to service_role (stock-buyer wakeup only).
-- Authenticated users must not self-select lambda via PostgREST/RLS.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.prevent_user_lambda_channel_self_change()
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
     AND NEW.delivery_channel = 'lambda'::public.delivery_channel_mode THEN
    RAISE EXCEPTION 'delivery_channel=lambda can only be set by an administrator';
  END IF;

  IF TG_OP = 'UPDATE'
     AND (
       (OLD.delivery_channel IS DISTINCT FROM NEW.delivery_channel)
       AND (
         OLD.delivery_channel = 'lambda'::public.delivery_channel_mode
         OR NEW.delivery_channel = 'lambda'::public.delivery_channel_mode
       )
     ) THEN
    RAISE EXCEPTION 'delivery_channel=lambda can only be changed by an administrator';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.prevent_user_lambda_channel_self_change() OWNER TO postgres;

CREATE TRIGGER prevent_user_lambda_channel_self_change
  BEFORE INSERT OR UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_user_lambda_channel_self_change();

REVOKE EXECUTE ON FUNCTION public.prevent_user_lambda_channel_self_change() FROM anon, authenticated, service_role;

UPDATE public.app_metadata
SET value = '20260808171000_lock_delivery_channel_lambda'
WHERE key = 'schema_version';
