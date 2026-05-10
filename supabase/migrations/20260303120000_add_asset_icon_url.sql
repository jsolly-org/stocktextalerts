-- Add icon_url column to assets for company logo branding images.
-- Stores the Massive branding icon URL; served to clients via a
-- server-side proxy so the API key stays secret.

ALTER TABLE public.assets
  ADD COLUMN icon_url TEXT;

-- Bump schema version
UPDATE public.app_metadata
  SET value = '20260303120000_add_asset_icon_url'
  WHERE key = 'schema_version';
