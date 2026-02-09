ALTER TABLE public.users
  ADD COLUMN add_ons_include_analyst BOOLEAN DEFAULT false NOT NULL,
  ADD COLUMN add_ons_include_insider BOOLEAN DEFAULT false NOT NULL;
