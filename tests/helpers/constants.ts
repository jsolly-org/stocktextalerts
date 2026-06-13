import { randomUUID } from "node:crypto";

// Update EXPECTED_DB_SCHEMA_VERSION whenever migrations are applied or regenerated
// (use the latest migration commit/tag or schema version timestamp and update tests).
export const EXPECTED_DB_SCHEMA_VERSION = "20260613170410_backup_readonly_role";
export const POSTGRES_UNDEFINED_TABLE = "42P01";
export const PRESERVED_USER_ID = "00000000-0000-0000-0000-000000000000";
// Non-routable by design. Was previously "test@jsolly.com" — a real inbox
// John owns — which turned out to be a footgun the one time a non-prod code
// path got past the sender gate and delivered a real notification via
// prod SES credentials on 2026-04-11. Test harness data must never use a
// real address. The prod dev-login account is separate (see
// AGENTS.md#dev-environment).
export const PRESERVED_TEST_EMAIL = "preserved-test@example.com";
export const TEST_PASSWORD = "TestPassword123!";
export const NEW_PASSWORD = "NewPassword123!";
export const TEST_RUN_ID = process.env.TEST_RUN_ID ?? randomUUID();
