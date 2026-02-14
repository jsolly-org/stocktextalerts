-- Add IPO support to asset events.
-- 1) Extend asset_event_type enum with 'ipo'
-- 2) Add per-channel user toggles for IPO events

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'asset_event_type')
     AND NOT EXISTS (
       SELECT 1
       FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'asset_event_type'
         AND e.enumlabel = 'ipo'
     )
  THEN
    ALTER TYPE public.asset_event_type ADD VALUE 'ipo';
  END IF;
END $$;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS asset_events_include_ipo_email BOOLEAN DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS asset_events_include_ipo_sms   BOOLEAN DEFAULT false NOT NULL;
