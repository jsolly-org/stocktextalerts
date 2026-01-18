import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { beforeAll } from "vitest";

const supabaseUrl = process.env.PUBLIC_SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const databaseUrl = process.env.DATABASE_URL;

if (!supabaseUrl || !supabaseServiceRoleKey || !databaseUrl) {
	throw new Error(
		"Missing required environment variables for tests: PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and DATABASE_URL must be set",
	);
}

export const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
	auth: {
		autoRefreshToken: false,
		persistSession: false,
	},
});

const PRESERVED_USER_ID = "00000000-0000-0000-0000-000000000000";
const TEST_USER_EMAIL = "test@jsolly.com";

async function verifySupabaseAdminAccess() {
	const { error } = await adminClient.auth.admin.listUsers({
		page: 1,
		perPage: 1,
	});
	if (!error) return;

	throw new Error(
		[
			"Supabase admin auth failed in tests. This usually means SUPABASE_SERVICE_ROLE_KEY does not match PUBLIC_SUPABASE_URL.",
			`Error: ${error.message}`,
			"Fix: ensure PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, and DATABASE_URL all point to the same Supabase project (recommended: local `supabase start`, then copy values from `supabase status`).",
		].join("\n"),
	);
}

export async function resetDatabase() {
	const client = new Client({ connectionString: databaseUrl });
	await client.connect();

	try {
		// Find the test user by email to preserve them
		const { rows: testUserRows } = await client.query(
			"SELECT id FROM auth.users WHERE email = $1",
			[TEST_USER_EMAIL],
		);
		const testUserId = testUserRows[0]?.id;

		// Build list of preserved user IDs
		const preservedUserIds = [PRESERVED_USER_ID];
		if (testUserId) {
			preservedUserIds.push(testUserId);
		}

		// Clean up public schema tables
		// Deleting from users cascades to user_stocks and notification_log
		await client.query(`DELETE FROM public.users WHERE id != ALL($1::uuid[])`, [
			preservedUserIds,
		]);

		// Clean up auth.users via Admin API to ensure proper cleanup of sessions/metadata
		const { rows: authUsers } = await client.query(
			`SELECT id FROM auth.users WHERE id != ALL($1::uuid[])`,
			[preservedUserIds],
		);

		await Promise.all(
			authUsers.map(async (user) => {
				const { error } = await adminClient.auth.admin.deleteUser(user.id);
				if (error) {
					console.warn(`Failed to cleanup user ${user.id}:`, error.message);
				}
			}),
		);
	} catch (error) {
		console.error("Database reset failed:", error);
		throw error;
	} finally {
		await client.end();
	}
}

async function verifyDatabaseSchemaUpToDate() {
	const client = new Client({ connectionString: databaseUrl });
	await client.connect();
	try {
		const { rows } = await client.query(
			"select to_regproc('public.update_user_preferences_and_stocks') as update_prefs_rpc;",
		);
		const rpc = rows[0]?.update_prefs_rpc as string | null | undefined;

		if (!rpc) {
			throw new Error(
				[
					"Database schema is missing required RPC: public.update_user_preferences_and_stocks",
					"This usually means your local Supabase DB has not been reset since the migration changed.",
					"Fix: run `npm run db:reset` (or `supabase db reset`) to re-apply migrations, then re-run `npm test`.",
				].join("\n"),
			);
		}
	} finally {
		await client.end();
	}
}

beforeAll(async () => {
	await verifySupabaseAdminAccess();
	await verifyDatabaseSchemaUpToDate();
	await resetDatabase();
});
