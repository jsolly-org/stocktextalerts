-- Least-privilege role for the user-settings backup Lambda.
-- Created with NO password and NOLOGIN here: it cannot authenticate until a
-- human sets a password out-of-band (ALTER ROLE ... PASSWORD), per
-- docs/specs/2026-06-13-user-settings-backup-design.md.
-- This migration is the source of truth for the role's PRIVILEGES only.

-- BYPASSRLS is REQUIRED, not a nicety: every backed-up table has row-level
-- security enabled, and a plain SELECT-granted role sees ZERO rows through RLS
-- (no error — COPY just streams nothing). Without BYPASSRLS the Lambda writes
-- silently-empty backups while reporting success. This mirrors how Supabase's
-- own service_role reads all rows. The role is still SELECT-only on the listed
-- tables, so it cannot write anything or read anything else.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'backup_readonly') then
    create role backup_readonly nologin bypassrls;
  else
    -- Ensure the attribute even if the role pre-existed without it.
    alter role backup_readonly bypassrls;
  end if;
end$$;

grant usage on schema public to backup_readonly;

grant select on table
  public.users,
  public.user_assets,
  public.price_targets,
  public.scheduled_notifications
to backup_readonly;

-- The export reads the schema version (app_metadata) as its first query, inside
-- the snapshot transaction, to stamp the manifest. Without this grant the role
-- hits `permission denied for table app_metadata` and every backup fails.
grant select on table public.app_metadata to backup_readonly;

-- Bump schema version (matches EXPECTED_DB_SCHEMA_VERSION in tests).
update public.app_metadata
set value = '20260613170410_backup_readonly_role'
where key = 'schema_version';
