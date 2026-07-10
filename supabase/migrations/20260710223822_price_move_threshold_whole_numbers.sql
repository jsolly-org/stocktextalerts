-- squawk-ignore-file constraint-missing-not-valid
-- (Supabase applies each migration in ONE transaction, so NOT VALID + VALIDATE
-- in the same file is the only option; squawk still wants them split.)
--
-- Price-move thresholds are whole numbers only (1% / $1 minimum). No existing
-- fractional rows — replace the > 0 CHECK with integer >= 1.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE public.price_move_alert_thresholds
  DROP CONSTRAINT IF EXISTS price_move_alert_thresholds_value_check;

ALTER TABLE public.price_move_alert_thresholds
  ADD CONSTRAINT price_move_alert_thresholds_value_check
  CHECK (threshold_value >= 1 AND threshold_value = trunc(threshold_value)) NOT VALID;

ALTER TABLE public.price_move_alert_thresholds
  VALIDATE CONSTRAINT price_move_alert_thresholds_value_check;

UPDATE public.app_metadata
SET value = '20260710223822_price_move_threshold_whole_numbers'
WHERE key = 'schema_version';
