-- Cache logo images as base64 data URIs so email rendering reads from DB
-- instead of fetching from the Massive API on every scheduler run.
-- Populated lazily on first email send per asset; NULL until then.

ALTER TABLE public.assets
  ADD COLUMN icon_base64 TEXT;

-- Bump schema version
UPDATE public.app_metadata
  SET value = '20260305120000_add_asset_icon_base64'
  WHERE key = 'schema_version';
