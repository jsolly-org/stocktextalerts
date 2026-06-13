-- Least-privilege role for the user-settings backup Lambda.
-- Created with NO password and NOLOGIN here: it cannot authenticate until a
-- human sets a password out-of-band (ALTER ROLE ... PASSWORD), per
-- docs/superpowers/specs/2026-06-13-user-settings-backup-design.md.
-- This migration is the source of truth for the role's PRIVILEGES only.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'backup_readonly') then
    create role backup_readonly nologin;
  end if;
end$$;

grant usage on schema public to backup_readonly;

grant select on table
  public.users,
  public.user_assets,
  public.price_targets,
  public.scheduled_notifications
to backup_readonly;

-- Bump schema version (matches EXPECTED_DB_SCHEMA_VERSION in tests).
update public.app_metadata
set value = '20260613170410_backup_readonly_role'
where key = 'schema_version';
