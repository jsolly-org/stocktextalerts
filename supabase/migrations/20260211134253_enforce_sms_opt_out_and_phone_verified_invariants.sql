ALTER TABLE public.users
ADD CONSTRAINT users_sms_opted_out_blocks_sms_enabled CHECK (
  NOT (sms_opted_out AND sms_notifications_enabled)
),
ADD CONSTRAINT users_phone_verified_requires_phone CHECK (
  NOT phone_verified OR
  (phone_country_code IS NOT NULL AND phone_number IS NOT NULL)
);
