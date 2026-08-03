/**
 * tests/global-setup.ts: run-wide database preflight, executed once per Vitest run.
 *
 * These three checks used to live in `tests/setup.ts`'s `beforeAll`, which Vitest runs
 * once per *test file*, i.e. 183 times. Two problems with that:
 *
 *   1. Cost. Each repetition opened two pg connections and issued a GoTrue admin call
 *      for answers that cannot change mid-run (schema version, admin credentials).
 *   2. Correctness under parallelism. `cleanupAllNonPreservedUsers` deletes every user
 *      the run did not explicitly preserve, so with `fileParallelism` on, each file's
 *      hook wiped users that other workers had just created for their own assertions.
 *      That single hammer accounted for the bulk of the failures in the earlier
 *      file-parallelism trial: 26 failing tests across 18 files with it, 2 without.
 *
 * Running them once, before any worker starts, keeps the guarantees (a known schema, a
 * verified admin key, a DB with no user rows left over from a previous run) while letting
 * files run concurrently. Per-test user cleanup is unchanged and still belongs to
 * `registerTestUserForCleanup` + the `afterEach` in `tests/setup.ts`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import { EXPECTED_DB_SCHEMA_VERSION } from "../src/lib/db/schema-version";
import {
	POSTGRES_UNDEFINED_TABLE,
	PRESERVED_TEST_EMAIL,
	PRESERVED_USER_ID,
} from "./helpers/constants";
import { adminClient } from "./helpers/test-env";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
const SEED_USERS_FILE = path.join(projectRoot, "scripts", "data", "users.json");

function getDatabaseUrl(): string {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		throw new Error("Missing required environment variable for tests: DATABASE_URL must be set");
	}
	return databaseUrl;
}

/** Seed users from scripts/data/users.json survive the wipe (scripts/db/doctor.ts needs them). */
function getSeedUserEmailsForPreservation(): string[] {
	if (!fs.existsSync(SEED_USERS_FILE)) return [];
	try {
		const parsed = JSON.parse(fs.readFileSync(SEED_USERS_FILE, "utf-8")) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map((entry) => {
				if (entry === null || typeof entry !== "object") return null;
				const email = (entry as { email?: unknown }).email;
				if (typeof email !== "string") return null;
				const trimmed = email.trim().toLowerCase();
				return trimmed.length > 0 ? trimmed : null;
			})
			.filter((email): email is string => email !== null);
	} catch {
		return [];
	}
}

async function verifyDatabaseSchemaUpToDate(databaseUrl: string): Promise<void> {
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

async function verifySupabaseAdminAccess(): Promise<void> {
	const { error } = await adminClient.auth.admin.listUsers({ page: 1, perPage: 1 });
	if (!error) return;

	const errorDetail =
		error.message ||
		(typeof error === "object" && error !== null ? JSON.stringify(error) : String(error));

	throw new Error(
		[
			"Supabase admin auth failed in tests. This usually means SUPABASE_SECRET_KEY does not match SUPABASE_URL.",
			`Error: ${errorDetail}`,
			"Fix: ensure SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY, and DATABASE_URL all point to the same Supabase project (recommended: local `supabase start`, then copy values from `supabase status`).",
		].join("\n"),
	);
}

async function cleanupAllNonPreservedUsers(databaseUrl: string): Promise<void> {
	const client = new Client({ connectionString: databaseUrl });
	await client.connect();

	try {
		const preservedUserIds = [PRESERVED_USER_ID];
		const { rows: preservedTestUsers } = await client.query(
			`SELECT id FROM auth.users WHERE email = $1`,
			[PRESERVED_TEST_EMAIL],
		);
		preservedUserIds.push(...preservedTestUsers.map((user) => user.id));

		const seedEmails = getSeedUserEmailsForPreservation();
		if (seedEmails.length > 0) {
			const { rows: seededUsers } = await client.query(
				`SELECT id FROM auth.users WHERE lower(email) = ANY($1::text[])`,
				[seedEmails],
			);
			preservedUserIds.push(...seededUsers.map((user) => user.id));
		}

		// Deleting from users cascades to user_assets and notification_log
		await client.query(`DELETE FROM public.users WHERE id != ALL($1::uuid[])`, [preservedUserIds]);

		const { rows: authUsers } = await client.query(
			`SELECT id FROM auth.users WHERE id != ALL($1::uuid[])`,
			[preservedUserIds],
		);

		const results = await Promise.allSettled(
			authUsers.map(async (user) => {
				const { error: deleteError } = await adminClient.auth.admin.deleteUser(user.id);
				if (deleteError) {
					const code = (deleteError as { code?: string }).code;
					const status = (deleteError as { status?: number }).status;
					// Already gone: a previous run's teardown may have removed this auth row.
					if (code === "user_not_found" || status === 404) return;
					throw new Error(`Failed to delete auth user ${user.id}`, { cause: deleteError });
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

export async function setup(): Promise<void> {
	const databaseUrl = getDatabaseUrl();
	await verifyDatabaseSchemaUpToDate(databaseUrl);
	await verifySupabaseAdminAccess();
	await cleanupAllNonPreservedUsers(databaseUrl);
}
