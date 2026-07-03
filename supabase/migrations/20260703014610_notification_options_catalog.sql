-- squawk-ignore-file constraint-missing-not-valid,adding-foreign-key-constraint
-- (Supabase applies each migration in ONE transaction, so NOT VALID + VALIDATE
-- can't run in separate transactions anyway; notification_preferences is small
-- — ~31 rows per user — and the scan-under-lock window is negligible. Same
-- precedent as 20260629120000_daily_notification_unity.sql.)
--
-- notification_options: the DB twin of NOTIFICATION_OPTION_MATRIX
-- (src/lib/constants.ts), the single authored source of the option taxonomy.
--
-- One row per valid (notification_type, content, channel) option. A composite
-- FK from notification_preferences replaces the hand-maintained
-- notification_type CHECK constraint AND closes the previously-unconstrained
-- `content` column: the DB now rejects any combo the catalog doesn't bless
-- (e.g. news/sms, which never existed as an option).
--
-- `npm run check:option-catalog` (inside db:reset, and therefore in CI)
-- asserts set-equality between this table's rows and the code catalog, so the
-- two sources cannot drift silently. Adding an option = a matrix entry in code
-- plus an INSERT here in a new migration; the drift check fails until both land.

set lock_timeout = '5s';
set statement_timeout = '60s';

-- 1. The options table (server-only reference data; deny-all RLS, service_role
--    bypasses; clients never read it — the app ships the catalog in code).
create table public.notification_options (
	notification_type text not null,
	content text not null,
	channel public.delivery_method not null,
	primary key (notification_type, content, channel)
);
alter table public.notification_options owner to postgres;
alter table public.notification_options enable row level security;
grant select on public.notification_options to service_role;

-- 2. Seed the valid options (generated from NOTIFICATION_PREFERENCE_CATALOG).
insert into public.notification_options (notification_type, content, channel) values
	('daily_notification', 'prices', 'email'),
	('daily_notification', 'prices', 'sms'),
	('daily_notification', 'prices', 'telegram'),
	('daily_notification', 'top_movers', 'email'),
	('daily_notification', 'top_movers', 'sms'),
	('daily_notification', 'top_movers', 'telegram'),
	('daily_notification', 'news', 'email'),
	('daily_notification', 'news', 'telegram'),
	('daily_notification', 'rumors', 'email'),
	('daily_notification', 'rumors', 'telegram'),
	('daily_notification', 'calendar', 'email'),
	('daily_notification', 'calendar', 'sms'),
	('daily_notification', 'calendar', 'telegram'),
	('daily_notification', 'ipo', 'email'),
	('daily_notification', 'ipo', 'sms'),
	('daily_notification', 'ipo', 'telegram'),
	('daily_notification', 'analyst', 'email'),
	('daily_notification', 'analyst', 'sms'),
	('daily_notification', 'analyst', 'telegram'),
	('daily_notification', 'insider', 'email'),
	('daily_notification', 'insider', 'sms'),
	('daily_notification', 'insider', 'telegram'),
	('market_asset_price_alerts', '', 'email'),
	('market_asset_price_alerts', '', 'sms'),
	('market_asset_price_alerts', '', 'telegram'),
	('market_scheduled_asset_price', '', 'email'),
	('market_scheduled_asset_price', '', 'sms'),
	('market_scheduled_asset_price', '', 'telegram'),
	('price_move_alerts', '', 'email'),
	('price_move_alerts', '', 'sms'),
	('price_move_alerts', '', 'telegram');

-- 3. Remove any preference rows for combos outside the catalog (should be a
--    no-op: the old CHECK constrained notification_type, the unity/cleanup
--    migrations canonicalized daily rows, and the app validates content — but
--    the FK below hard-fails on any straggler, so sweep defensively first).
delete from public.notification_preferences p
where not exists (
	select 1
	from public.notification_options o
	where o.notification_type = p.notification_type
		and o.content = p.content
		and o.channel = p.channel
);

-- 4. The FK supersedes the hand-maintained CHECK (which only covered
--    notification_type; content had NO constraint at all). ON UPDATE CASCADE
--    so renaming an option in a future migration propagates to user rows.
alter table public.notification_preferences
	drop constraint notification_preferences_notification_type_check;

alter table public.notification_preferences
	add constraint notification_preferences_option_fkey
	foreign key (notification_type, content, channel)
	references public.notification_options (notification_type, content, channel)
	on update cascade;

update public.app_metadata
set value = '20260703014610_notification_options_catalog'
where key = 'schema_version';
