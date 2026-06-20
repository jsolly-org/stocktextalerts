-- squawk-ignore-file ban-drop-column
-- Drop the 22 per-option `*_include_{email,sms}` columns from public.users.
-- The column drop is the deliberate goal of this migration (the data is already
-- preserved as notification_preferences rows, see below), so ban-drop-column is
-- ignored for THIS file only — the rule stays active for every other migration.
--
-- notification_preferences is now the SINGLE source of truth for ALL channels
-- (email, sms, telegram). The data is already in the table before this drop:
--   1. migration 20260619180556 backfilled email/sms rows from these columns,
--   2. the app dual-writes every channel facet on every preferences update, and
--   3. signup seeds the full default row set.
-- so every value these columns held is preserved as notification_preferences rows.
--
-- KEPT (channel/feature-level, NOT per-(type,content,channel)):
--   email_notifications_enabled, sms_notifications_enabled, sms_opted_out,
--   market_asset_price_alerts_enabled, market_scheduled_asset_price_enabled, phone_*,
--   telegram_*.

set lock_timeout = '5s';
set statement_timeout = '60s';

alter table public.users
	drop column if exists daily_digest_include_prices_email,
	drop column if exists daily_digest_include_prices_sms,
	drop column if exists daily_digest_include_top_movers_email,
	drop column if exists daily_digest_include_top_movers_sms,
	drop column if exists daily_digest_include_news_email,
	drop column if exists daily_digest_include_rumors_email,
	drop column if exists asset_events_include_calendar_email,
	drop column if exists asset_events_include_calendar_sms,
	drop column if exists asset_events_include_ipo_email,
	drop column if exists asset_events_include_ipo_sms,
	drop column if exists asset_events_include_analyst_email,
	drop column if exists asset_events_include_analyst_sms,
	drop column if exists asset_events_include_insider_email,
	drop column if exists asset_events_include_insider_sms,
	drop column if exists market_asset_price_alerts_include_email,
	drop column if exists market_asset_price_alerts_include_sms,
	drop column if exists market_scheduled_asset_price_include_email,
	drop column if exists market_scheduled_asset_price_include_sms,
	drop column if exists price_move_alerts_include_email,
	drop column if exists price_move_alerts_include_sms,
	drop column if exists price_targets_include_email,
	drop column if exists price_targets_include_sms;

-- Bump schema version (see AGENTS.md -> Testing schema_version).
update public.app_metadata
set value = '20260619233608_drop_per_option_include_columns'
where key = 'schema_version';
