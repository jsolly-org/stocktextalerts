BEGIN;

CREATE OR REPLACE FUNCTION public.reserve_sms_verification(
  p_user_id uuid,
  p_phone_country_code text,
  p_phone_number text,
  p_cooldown_ms integer
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  reserved boolean;
  lock_key bigint;
BEGIN
  IF NULLIF(current_setting('request.jwt.claims', true), '')::json->>'role' = 'authenticated'
     AND p_user_id <> (SELECT auth.uid()) THEN
    RAISE EXCEPTION 'Cannot reserve SMS verification for another user';
  END IF;

  IF p_cooldown_ms IS NULL OR p_cooldown_ms <= 0 THEN
    RAISE EXCEPTION 'invalid cooldown parameter: p_cooldown_ms must be > 0'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  lock_key := pg_catalog.hashtext(p_user_id::text || '|reserve_sms_verification');
  PERFORM pg_advisory_xact_lock(lock_key);

  UPDATE public.users
  SET
    phone_country_code = p_phone_country_code,
    phone_number = p_phone_number,
    phone_verified = false,
    verification_sent_at = pg_catalog.now()
  WHERE id = p_user_id
    AND (
      verification_sent_at IS NULL
      OR verification_sent_at <= pg_catalog.now() - (p_cooldown_ms || ' milliseconds')::interval
    )
  RETURNING true INTO reserved;

  RETURN COALESCE(reserved, false);
END;
$$;

COMMIT;
