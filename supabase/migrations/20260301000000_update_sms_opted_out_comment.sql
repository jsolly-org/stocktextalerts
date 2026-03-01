-- Document sms_opted_out for AWS (carrier regulatory opt-out); original migration used Twilio wording.
COMMENT ON COLUMN public.users.sms_opted_out IS 'Carrier regulatory opt-out (e.g. STOP); locks/disables SMS notifications.';
