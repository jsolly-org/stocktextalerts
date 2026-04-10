import { randomUUID } from "node:crypto";

// Update EXPECTED_DB_SCHEMA_VERSION whenever migrations are applied or regenerated
// (use the latest migration commit/tag or schema version timestamp and update tests).
export const EXPECTED_DB_SCHEMA_VERSION =
	"20260410120000_add_daily_digest_include_top_movers";
export const POSTGRES_UNDEFINED_TABLE = "42P01";
export const PRESERVED_USER_ID = "00000000-0000-0000-0000-000000000000";
export const PRESERVED_TEST_EMAIL = "test@jsolly.com";
export const TEST_PASSWORD = "TestPassword123!";
export const NEW_PASSWORD = "NewPassword123!";
export const TEST_RUN_ID = process.env.TEST_RUN_ID ?? randomUUID();
