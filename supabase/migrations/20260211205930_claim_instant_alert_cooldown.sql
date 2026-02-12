CREATE OR REPLACE FUNCTION public.claim_instant_alert_cooldown(
  p_user_id uuid,
  p_symbol text,
  p_cooldown_minutes integer
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  claimed boolean;
BEGIN
  INSERT INTO public.instant_alert_cooldowns (user_id, symbol, last_alerted_at)
  VALUES (p_user_id, p_symbol, pg_catalog.now())
  ON CONFLICT (user_id, symbol) DO UPDATE
    SET last_alerted_at = pg_catalog.now()
    WHERE public.instant_alert_cooldowns.last_alerted_at
      <= pg_catalog.now() - make_interval(mins => p_cooldown_minutes)
  RETURNING true INTO claimed;

  RETURN COALESCE(claimed, false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_instant_alert_cooldown(
  uuid,
  text,
  integer
) TO service_role;
