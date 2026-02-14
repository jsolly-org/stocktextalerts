ALTER TABLE public.users RENAME COLUMN show_change_percent TO show_sparklines;
ALTER TABLE public.users ALTER COLUMN show_sparklines SET DEFAULT true;
UPDATE public.users SET show_sparklines = true WHERE show_sparklines = false;
