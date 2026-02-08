-- Drop the update_user_preferences_and_stocks function.
-- The application uses direct .update() + replace_user_stocks RPC instead.

DROP FUNCTION IF EXISTS public.update_user_preferences_and_stocks(uuid, text[], boolean, boolean, text, integer[], timestamp with time zone);
