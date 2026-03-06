ALTER TABLE public.users DROP COLUMN show_sparklines;

UPDATE public.app_metadata
  SET value = '20260306140000_remove_show_sparklines_column'
  WHERE key = 'schema_version';
