/**
 * The user-authored tables this backup preserves. Source of truth for both the
 * export (Task 4) and restore (Task 8). Order is parent-before-child so a naive
 * restore satisfies FKs. See docs/superpowers/specs/2026-06-13-user-settings-backup-design.md.
 */
export const BACKUP_TABLES = [
	"public.users",
	"public.user_assets",
	"public.price_targets",
	"public.scheduled_notifications",
] as const;

export type BackupTable = (typeof BACKUP_TABLES)[number];
