import { Client } from "pg";
import { afterAll, afterEach, beforeAll, expect, vi } from "vitest";
import { getRealAssetSymbols } from "./helpers/asset-data";
import {
	EXPECTED_DB_SCHEMA_VERSION,
	POSTGRES_UNDEFINED_TABLE,
	PRESERVED_TEST_EMAIL,
	PRESERVED_USER_ID,
} from "./helpers/constants";
import { adminClient } from "./helpers/test-env";
import { cleanupTestUser } from "./helpers/test-user";
import { takeTestUserIdsForCleanup } from "./helpers/test-user-cleanup";

vi.mock("../src/lib/db/env", () => ({
	getSiteUrl: () => "http://localhost",
}));

// Prevent real external API calls in all tests.
// Without this, any code path that reaches these providers would attempt a
// live HTTP request when the key is set (e.g. in CI secrets).
vi.stubEnv("MASSIVE_API_KEY", "");
vi.stubEnv("FINNHUB_API_KEY", "");
vi.stubEnv("XAI_API_KEY", "");

function getDatabaseUrl(): string {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		throw new Error(
			"Missing required environment variable for tests: DATABASE_URL must be set",
		);
	}

	return databaseUrl;
}

const databaseUrl = getDatabaseUrl();

async function verifySupabaseAdminAccess() {
	const { error } = await adminClient.auth.admin.listUsers({
		page: 1,
		perPage: 1,
	});
	if (!error) return;

	const errorDetail =
		error.message ||
		(typeof error === "object" && error !== null
			? JSON.stringify(error)
			: String(error));

	throw new Error(
		[
			"Supabase admin auth failed in tests. This usually means SUPABASE_SECRET_KEY does not match SUPABASE_URL.",
			`Error: ${errorDetail}`,
			"Fix: ensure SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY, and DATABASE_URL all point to the same Supabase project (recommended: local `supabase start`, then copy values from `supabase status`).",
		].join("\n"),
	);
}

async function cleanupAllNonPreservedUsers(): Promise<void> {
	const client = new Client({ connectionString: databaseUrl });
	await client.connect();

	try {
		const preservedUserIds = [PRESERVED_USER_ID];
		const { rows: preservedTestUsers } = await client.query(
			`SELECT id FROM auth.users WHERE email = $1`,
			[PRESERVED_TEST_EMAIL],
		);
		const preservedTestUserIds = preservedTestUsers.map((user) => user.id);
		preservedUserIds.push(...preservedTestUserIds);

		// Deleting from users cascades to user_assets and notification_log
		await client.query(`DELETE FROM public.users WHERE id != ALL($1::uuid[])`, [
			preservedUserIds,
		]);

		const { rows: authUsers } = await client.query(
			`SELECT id FROM auth.users WHERE id != ALL($1::uuid[])`,
			[preservedUserIds],
		);

		const results = await Promise.allSettled(
			authUsers.map(async (user) => {
				const { error: deleteError } = await adminClient.auth.admin.deleteUser(
					user.id,
				);
				if (deleteError) {
					throw new Error(`Failed to delete auth user ${user.id}`, {
						cause: deleteError,
					});
				}
			}),
		);

		const deleteErrors = results
			.filter((result) => result.status === "rejected")
			.map((result) => result.reason);

		if (deleteErrors.length > 0) {
			throw deleteErrors.length === 1
				? deleteErrors[0]
				: new AggregateError(deleteErrors, "Multiple user deletions failed");
		}
	} catch (error) {
		throw new Error("Test user cleanup failed", { cause: error });
	} finally {
		await client.end();
	}
}

async function verifyDatabaseSchemaUpToDate() {
	const client = new Client({ connectionString: databaseUrl });
	await client.connect();
	try {
		let rows: { value: string }[];
		try {
			const result = await client.query<{ value: string }>(
				"select value from public.app_metadata where key = 'schema_version'",
			);
			rows = result.rows;
		} catch (queryError: unknown) {
			const code = (queryError as { code?: string })?.code;
			if (code === POSTGRES_UNDEFINED_TABLE) {
				throw new Error(
					[
						"Database schema not applied (public.app_metadata does not exist).",
						"Ensure Supabase is running (`npm run db:start`) then run `npm run db:reset` to apply migrations.",
						"Re-run `npm test` after the schema is applied.",
					].join("\n"),
					{ cause: queryError },
				);
			}
			throw queryError;
		}

		const version = rows[0]?.value;
		if (version !== EXPECTED_DB_SCHEMA_VERSION) {
			throw new Error(
				[
					"Database schema version mismatch.",
					`expected: ${EXPECTED_DB_SCHEMA_VERSION}`,
					`actual: ${version ?? "MISSING"}`,
					"This usually means your local Supabase DB has not been reset since the migration changed.",
					"Fix: run `npm run db:reset` (or `supabase db reset`) to re-apply migrations, then re-run `npm test`.",
				].join("\n"),
			);
		}
	} finally {
		await client.end();
	}
}

afterEach(async () => {
	const userIds = takeTestUserIdsForCleanup();
	for (const userId of userIds) {
		await cleanupTestUser(userId);
	}
});

export const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
export const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

let allowWarnings = false;
let allowErrors = false;

export function allowConsoleWarnings() {
	allowWarnings = true;
}

export function allowConsoleErrors() {
	allowErrors = true;
}

export function resetConsoleAssertions() {
	allowWarnings = false;
	allowErrors = false;
}

afterEach(() => {
	try {
		if (!allowWarnings) {
			expect(warnSpy.mock.calls, "Unexpected console.warn").toEqual([]);
		}
		if (!allowErrors) {
			expect(errorSpy.mock.calls, "Unexpected console.error").toEqual([]);
		}
	} finally {
		warnSpy.mockClear();
		errorSpy.mockClear();
		resetConsoleAssertions();
	}
});

afterAll(() => {
	warnSpy.mockRestore();
	errorSpy.mockRestore();
});

beforeAll(async () => {
	await verifyDatabaseSchemaUpToDate();
	await verifySupabaseAdminAccess();
	await cleanupAllNonPreservedUsers();
	// Preload asset data once for all tests (cached after first load)
	getRealAssetSymbols(1);
});
