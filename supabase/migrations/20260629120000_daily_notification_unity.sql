-- squawk-ignore-file constraint-missing-not-valid
-- Unify daily digest + asset events into one daily notification slot and preference type.

set lock_timeout = '5s';
set statement_timeout = '120s';

-- 1. Canonical daily notification schedule cursor on users
alter table public.users
	add column if not exists daily_notification_next_send_at timestamptz;

update public.users
set daily_notification_next_send_at = coalesce(
	daily_digest_next_send_at,
	asset_events_next_send_at
)
where daily_notification_next_send_at is null
	and (daily_digest_next_send_at is not null or asset_events_next_send_at is not null);

create index if not exists idx_users_daily_notification_next_send_at
	on public.users using btree (daily_notification_next_send_at)
	where (daily_notification_next_send_at is not null);

-- 2. Extend notification_preferences.notification_type to include daily_notification
alter table public.notification_preferences
	drop constraint if exists notification_preferences_notification_type_check;

alter table public.notification_preferences
	add constraint notification_preferences_notification_type_check check (
		notification_type in (
			'daily_notification',
			'daily_digest',
			'asset_events',
			'market_asset_price_alerts',
			'market_scheduled_asset_price',
			'price_move_alerts',
			'price_targets'
		)
	);

-- 3. Migrate legacy daily_digest + asset_events rows → daily_notification
insert into public.notification_preferences (
	user_id,
	notification_type,
	content,
	channel,
	enabled,
	created_at,
	updated_at
)
select
	user_id,
	'daily_notification',
	content,
	channel,
	enabled,
	created_at,
	updated_at
from public.notification_preferences
where notification_type in ('daily_digest', 'asset_events')
on conflict (user_id, notification_type, content, channel) do update
set
	enabled = excluded.enabled,
	updated_at = excluded.updated_at;

delete from public.notification_preferences
where notification_type in ('daily_digest', 'asset_events');

-- 4. Tighten CHECK to canonical type only (legacy types removed from storage)
alter table public.notification_preferences
	drop constraint notification_preferences_notification_type_check;

alter table public.notification_preferences
	add constraint notification_preferences_notification_type_check check (
		notification_type in (
			'daily_notification',
			'market_asset_price_alerts',
			'market_scheduled_asset_price',
			'price_move_alerts',
			'price_targets'
		)
	);
