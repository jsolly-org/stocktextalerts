-- Add 'lambda' to delivery_channel_mode for system users that wake asset-buyer
-- via Lambda invoke (no email/Telegram). Own migration: Postgres forbids using a
-- newly-added enum value in the same transaction that adds it.

SET lock_timeout = '5s';
SET statement_timeout = '60s';

ALTER TYPE public.delivery_channel_mode ADD VALUE IF NOT EXISTS 'lambda';
