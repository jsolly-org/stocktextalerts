-- squawk-ignore-file ban-drop-column,renaming-column
-- Drop transitional daily digest / asset-events schedule columns and rename delivery time.

set lock_timeout = '5s';
set statement_timeout = '120s';

-- Ensure canonical cursor is populated before dropping legacy columns.
update public.users
set daily_notification_next_send_at = coalesce(
	daily_notification_next_send_at,
	daily_digest_next_send_at,
	asset_events_next_send_at
)
where daily_notification_next_send_at is null
	and (daily_digest_next_send_at is not null or asset_events_next_send_at is not null);

drop index if exists public.idx_users_daily_digest_next_send_at;
drop index if exists public.idx_users_asset_events_next_send_at;

alter table public.users
	drop column if exists daily_digest_next_send_at,
	drop column if exists asset_events_next_send_at;

alter table public.users
	rename column daily_digest_time to daily_notification_time;

update public.app_metadata
set value = '20260629140000_daily_notification_legacy_cleanup'
where key = 'schema_version';
