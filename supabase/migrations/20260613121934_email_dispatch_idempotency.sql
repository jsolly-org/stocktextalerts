-- Durable idempotency for the email-dispatch Lambda. Replaces a per-instance
-- in-memory map so duplicate sends are blocked across cold starts and
-- concurrent Lambda instances. service_role only (Lambda uses the secret key).

create table public.email_dispatch_idempotency (
	idempotency_key text primary key,
	created_at timestamptz not null default now()
);

-- Deny-all RLS: only service_role (which bypasses RLS) may touch this table.
alter table public.email_dispatch_idempotency enable row level security;

-- Index supports the opportunistic TTL cleanup below.
create index email_dispatch_idempotency_created_at_idx
	on public.email_dispatch_idempotency (created_at);

grant select, insert, delete on public.email_dispatch_idempotency to service_role;

-- Bump schema version (see AGENTS.md -> Testing schema_version).
update public.app_metadata
set value = '20260613121934_email_dispatch_idempotency'
where key = 'schema_version';
