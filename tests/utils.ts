import { randomInt, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { DateTime } from "luxon";
import { Client } from "pg";
import type { TablesInsert } from "../src/lib/db/generated/database.types";
import { calculateNextSendAt } from "../src/lib/time/schedule";
import { EXPECTED_DB_SCHEMA_VERSION } from "./schema-version";

type TestEnv = {
	supabaseUrl: string;
	supabaseServiceRoleKey: string;
	databaseUrl: string;
};

function getTestEnv(): TestEnv {
	const supabaseUrl = process.env.PUBLIC_SUPABASE_URL;
	const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
	const databaseUrl = process.env.DATABASE_URL;

	if (!supabaseUrl || !supabaseServiceRoleKey || !databaseUrl) {
		throw new Error(
			"Missing required environment variables for tests: PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and DATABASE_URL must be set",
		);
	}

	return { supabaseUrl, supabaseServiceRoleKey, databaseUrl };
}

const testEnv = getTestEnv();

export const adminClient = createClient(
	testEnv.supabaseUrl,
	testEnv.supabaseServiceRoleKey,
	{
		auth: {
			autoRefreshToken: false,
			persistSession: false,
		},
	},
);

const databaseUrl = testEnv.databaseUrl;

export const PRESERVED_USER_ID = "00000000-0000-0000-0000-000000000000";
export const TEST_USER_EMAIL = "test@jsolly.com";

export async function verifySupabaseAdminAccess() {
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
					throw new Error(
						`Failed to cleanup auth user ${user.id}: ${error.message}`,
					);
				}
			}),
		);
	} catch (error) {
		throw new Error("Database reset failed", { cause: error });
	} finally {
		await client.end();
	}
}

export async function verifyDatabaseSchemaUpToDate() {
	const client = new Client({ connectionString: databaseUrl });
	await client.connect();
	try {
		const { rows } = await client.query<{ value: string }>(
			"select value from public.app_metadata where key = 'schema_version'",
		);

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

export interface CreateTestUserOptions {
	email?: string;
	password?: string;
	timezone?: string;
	emailNotificationsEnabled?: boolean;
	smsNotificationsEnabled?: boolean;
	phoneCountryCode?: string | null;
	phoneNumber?: string | null;
	phoneVerified?: boolean;
	smsOptedOut?: boolean;
	dailyDigestEnabled?: boolean;
	dailyDigestNotificationTime?: number;
	trackedStocks?: string[];
	confirmed?: boolean;
}

export interface TestUser {
	id: string;
	email: string;
}

type DbUserInsert = TablesInsert<"users">;
type DbUserStockInsert = TablesInsert<"user_stocks">;

export async function createTestUser(
	options: CreateTestUserOptions = {},
): Promise<TestUser> {
	const email =
		options.email ||
		process.env.TEST_EMAIL_RECIPIENT ||
		`test-${randomUUID()}@resend.dev`;
	const password = options.password || "TestPassword123!";
	const timezone = options.timezone || "America/New_York";
	const smsNotificationsEnabled = options.smsNotificationsEnabled ?? false;

	const defaultPhoneCountryCode = "+1";
	const defaultPhoneNumber = `500555${String(randomInt(0, 10000)).padStart(4, "0")}`;

	const phoneCountryCode =
		options.phoneCountryCode ??
		(smsNotificationsEnabled ? defaultPhoneCountryCode : null);
	const phoneNumber =
		options.phoneNumber ??
		(smsNotificationsEnabled ? defaultPhoneNumber : null);
	const phoneVerified = options.phoneVerified ?? false;
	const smsOptedOut = options.smsOptedOut ?? false;

	if (smsNotificationsEnabled && (!phoneCountryCode || !phoneNumber)) {
		throw new Error(
			"Invalid test user: smsNotificationsEnabled requires phoneCountryCode and phoneNumber",
		);
	}

	// Create in Auth
	const { data: authUser, error: authError } = await adminClient.auth.signUp({
		email,
		password,
		options: {
			data: { timezone },
		},
	});

	if (authError) {
		throw new Error(`Auth setup failed: ${authError.message}`);
	}

	const userId = authUser.user?.id;
	if (!userId) throw new Error("Failed to create test user ID");

	// Confirm user if requested
	if (options.confirmed) {
		const { error: confirmError } = await adminClient.auth.admin.updateUserById(
			userId,
			{ email_confirm: true },
		);
		if (confirmError) {
			throw new Error(`Failed to confirm user: ${confirmError.message}`);
		}
	}

	// Create Profile in 'users' table
	// Default to 9:00 AM (540 minutes from midnight)
	const defaultNotificationTime = 540;
	const rawNotificationTime =
		options.dailyDigestNotificationTime ?? defaultNotificationTime;
	const dailyDigestNotificationTime = Math.max(
		0,
		Math.min(1439, rawNotificationTime),
	);
	const alignedDailyDigestNotificationTime =
		Math.floor(dailyDigestNotificationTime / 15) * 15;
	const dailyDigestEnabled = options.dailyDigestEnabled ?? false;
	const nextSendAt = dailyDigestEnabled
		? calculateNextSendAt(
				alignedDailyDigestNotificationTime,
				timezone,
				DateTime.utc(),
			)
		: null;
	const nextSendAtIso = nextSendAt?.toISO() ?? null;
	if (dailyDigestEnabled && !nextSendAtIso) {
		throw new Error("Failed to generate next_send_at timestamp");
	}

	const profile: DbUserInsert = {
		id: userId,
		email,
		phone_country_code: phoneCountryCode,
		phone_number: phoneNumber,
		phone_verified: phoneVerified,
		sms_opted_out: smsOptedOut,
		timezone,
		email_notifications_enabled: options.emailNotificationsEnabled ?? false,
		sms_notifications_enabled: smsNotificationsEnabled,
		daily_digest_enabled: dailyDigestEnabled,
		daily_digest_notification_time: alignedDailyDigestNotificationTime,
		next_send_at: nextSendAtIso,
	};

	const { error: profileError } = await adminClient
		.from("users")
		.upsert(profile, { onConflict: "id" });

	if (profileError) {
		throw new Error(`Profile setup failed: ${profileError.message}`);
	}

	// Add Tracked Stocks if provided
	if (options.trackedStocks && options.trackedStocks.length > 0) {
		// Ensure stocks exist in the stocks table first
		const uniqueSymbols = [...new Set(options.trackedStocks)];
		const stockRecords = uniqueSymbols.map((symbol) => ({
			symbol,
			name: `${symbol} Test Stock`,
			exchange: "NASDAQ",
		}));

		const { error: stocksTableError } = await adminClient
			.from("stocks")
			.upsert(stockRecords, { onConflict: "symbol" });

		if (stocksTableError) {
			throw new Error(`Stocks table setup failed: ${stocksTableError.message}`);
		}

		const stockInserts: DbUserStockInsert[] = uniqueSymbols.map((symbol) => ({
			user_id: userId,
			symbol,
		}));

		const { error: stockError } = await adminClient
			.from("user_stocks")
			.insert(stockInserts);

		if (stockError) {
			throw new Error(`Stock setup failed: ${stockError.message}`);
		}
	}

	return { id: userId, email };
}

export async function createAuthenticatedCookies(
	email: string,
	password: string,
): Promise<Map<string, string>> {
	const supabaseUrl = process.env.PUBLIC_SUPABASE_URL;
	const supabaseAnonKey = process.env.PUBLIC_SUPABASE_ANON_KEY;

	if (!supabaseUrl || !supabaseAnonKey) {
		throw new Error("Missing Supabase environment variables");
	}

	const supabase = createClient(supabaseUrl, supabaseAnonKey, {
		auth: {
			autoRefreshToken: false,
			persistSession: false,
		},
	});

	const { data, error } = await supabase.auth.signInWithPassword({
		email,
		password,
	});

	if (error || !data.session) {
		throw new Error(`Failed to sign in: ${error?.message || "Unknown error"}`);
	}

	const cookies = new Map<string, string>();
	cookies.set("sb-access-token", data.session.access_token);
	cookies.set("sb-refresh-token", data.session.refresh_token);

	return cookies;
}
