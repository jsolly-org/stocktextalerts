-- Add 'telegram' to the delivery_method enum, in its OWN migration.
--
-- Postgres forbids using a newly-added enum value in the same transaction that
-- adds it, and Supabase wraps each migration file in a transaction. So the value
-- is added here and first USED by the next migration
-- (…_add_telegram_preferences_identity), which references it as a column type.

alter type public.delivery_method add value if not exists 'telegram';
