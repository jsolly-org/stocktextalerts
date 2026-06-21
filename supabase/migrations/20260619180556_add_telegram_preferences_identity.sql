-- Telegram channel: per-(option × channel) preferences, Telegram identity/state,
-- and server-only support tables.
--
-- ADDITIVE ONLY. The existing per-option `*_include_{email,sms}` columns on
-- public.users are KEPT and dual-written by the app; they are dropped in a LATER
-- migration once all read sites move to notification_preferences (see
-- docs/plans/2026-06-19-telegram-native-channel.md §6). Nothing here is destructive.

set lock_timeout = '5s';
set statement_timeout = '60s';

-- 1. notification_preferences — one row per (user, notification type, content
--    facet, channel). Replaces the wall of `*_include_*` booleans with rows, so
--    adding a channel (telegram) is data, not schema. `content = ''` for
--    facet-less types (price alerts etc.). Backs the dashboard channel-multiselect.
create table if not exists public.notification_preferences (
	user_id uuid not null references public.users (id) on delete cascade,
	notification_type text not null check (
		notification_type in (
			'daily_digest',
			'asset_events',
			'market_asset_price_alerts',
			'market_scheduled_asset_price',
			'price_move_alerts',
			'price_targets'
		)
	),
	content text not null default '',
	channel public.delivery_method not null,
	enabled boolean not null default false,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	primary key (user_id, notification_type, content, channel)
);
alter table public.notification_preferences owner to postgres;

-- Per-user RLS: a user reads/writes only their own rows; service_role (the cron
-- fan-out) bypasses RLS.
alter table public.notification_preferences enable row level security;
-- drop-then-create so a partial `supabase db push` retry doesn't abort on
-- "policy already exists" — Postgres has no CREATE POLICY IF NOT EXISTS, and every
-- other object in this file is guarded with IF NOT EXISTS.
drop policy if exists notification_preferences_select_own on public.notification_preferences;
create policy notification_preferences_select_own on public.notification_preferences
	for select to authenticated using (user_id = auth.uid());
drop policy if exists notification_preferences_insert_own on public.notification_preferences;
create policy notification_preferences_insert_own on public.notification_preferences
	for insert to authenticated with check (user_id = auth.uid());
drop policy if exists notification_preferences_update_own on public.notification_preferences;
create policy notification_preferences_update_own on public.notification_preferences
	for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists notification_preferences_delete_own on public.notification_preferences;
create policy notification_preferences_delete_own on public.notification_preferences
	for delete to authenticated using (user_id = auth.uid());

grant select, insert, update, delete on public.notification_preferences to authenticated, service_role;

create index if not exists notification_preferences_user_idx
	on public.notification_preferences (user_id);

-- 2. Backfill email/sms rows from the existing per-option columns. ONE explicit
--    mapping per source column — NOT a blind channels cross-join: news/rumors are
--    email-only and must not get phantom sms rows. Telegram rows are intentionally
--    NOT backfilled — Telegram starts unselected until a user picks it in the UI.
insert into public.notification_preferences (user_id, notification_type, content, channel, enabled)
select u.id, m.notification_type, m.content, m.channel::public.delivery_method, m.enabled
from public.users u
cross join lateral (
	values
		('daily_digest', 'prices', 'email', u.daily_digest_include_prices_email),
		('daily_digest', 'prices', 'sms', u.daily_digest_include_prices_sms),
		('daily_digest', 'news', 'email', u.daily_digest_include_news_email),
		('daily_digest', 'rumors', 'email', u.daily_digest_include_rumors_email),
		('daily_digest', 'top_movers', 'email', u.daily_digest_include_top_movers_email),
		('daily_digest', 'top_movers', 'sms', u.daily_digest_include_top_movers_sms),
		('asset_events', 'analyst', 'email', u.asset_events_include_analyst_email),
		('asset_events', 'analyst', 'sms', u.asset_events_include_analyst_sms),
		('asset_events', 'calendar', 'email', u.asset_events_include_calendar_email),
		('asset_events', 'calendar', 'sms', u.asset_events_include_calendar_sms),
		('asset_events', 'insider', 'email', u.asset_events_include_insider_email),
		('asset_events', 'insider', 'sms', u.asset_events_include_insider_sms),
		('asset_events', 'ipo', 'email', u.asset_events_include_ipo_email),
		('asset_events', 'ipo', 'sms', u.asset_events_include_ipo_sms),
		('market_asset_price_alerts', '', 'email', u.market_asset_price_alerts_include_email),
		('market_asset_price_alerts', '', 'sms', u.market_asset_price_alerts_include_sms),
		('market_scheduled_asset_price', '', 'email', u.market_scheduled_asset_price_include_email),
		('market_scheduled_asset_price', '', 'sms', u.market_scheduled_asset_price_include_sms),
		('price_move_alerts', '', 'email', u.price_move_alerts_include_email),
		('price_move_alerts', '', 'sms', u.price_move_alerts_include_sms),
		('price_targets', '', 'email', u.price_targets_include_email),
		('price_targets', '', 'sms', u.price_targets_include_sms)
) as m (notification_type, content, channel, enabled)
on conflict (user_id, notification_type, content, channel) do nothing;

-- 3. Telegram identity + delivery state on users (link-only onboarding in v1).
--    telegram_id = the linked Telegram user (identity); telegram_chat_id = where
--    we send (equal for 1:1 DMs). telegram_opted_out is set ONLY from a verified
--    outbound 403 ("bot was blocked") — never from inbound webhook content.
alter table public.users
	add column if not exists telegram_id bigint,
	add column if not exists telegram_chat_id bigint,
	add column if not exists telegram_opted_out boolean not null default false,
	add column if not exists telegram_linked_at timestamptz;

create unique index if not exists users_telegram_id_key
	on public.users (telegram_id)
	where telegram_id is not null;

-- 4. Single-use, short-TTL linking tokens binding a Telegram chat to an existing
--    account (minted by the dashboard, consumed by the bot /start webhook).
--    Server-only: deny-all RLS, service_role bypasses.
create table if not exists public.telegram_link_tokens (
	nonce text primary key,
	user_id uuid not null references public.users (id) on delete cascade,
	expires_at timestamptz not null,
	consumed_at timestamptz,
	created_at timestamptz not null default now()
);
alter table public.telegram_link_tokens owner to postgres;
alter table public.telegram_link_tokens enable row level security;
grant select, insert, update, delete on public.telegram_link_tokens to service_role;

-- 5. Webhook update dedupe — Telegram re-sends updates on non-2xx/timeout, so the
--    webhook records each update_id and ignores repeats. Server-only.
create table if not exists public.telegram_updates (
	update_id bigint primary key,
	received_at timestamptz not null default now()
);
alter table public.telegram_updates owner to postgres;
alter table public.telegram_updates enable row level security;
grant select, insert, delete on public.telegram_updates to service_role;

-- Bump schema version (see AGENTS.md -> Testing schema_version).
update public.app_metadata
set value = '20260619180556_add_telegram_preferences_identity'
where key = 'schema_version';
