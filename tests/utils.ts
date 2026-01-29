import { randomInt, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { DateTime } from "luxon";
import { Client } from "pg";
import type { TablesInsert } from "../src/lib/db/generated/database.types";
import { calculateNextSendAtFromTimes } from "../src/lib/time/schedule";
import { EXPECTED_DB_SCHEMA_VERSION } from "./schema-version";

type TestEnv = {
	supabaseUrl: string;
	supabaseServiceRoleKey: string;
	databaseUrl: string;
	supabaseAnonKey: string;
};

function getTestEnv(): TestEnv {
	const supabaseUrl = process.env.PUBLIC_SUPABASE_URL;
	const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
	const databaseUrl = process.env.DATABASE_URL;
	const supabaseAnonKey = process.env.PUBLIC_SUPABASE_ANON_KEY;

	// Tests run outside the request pipeline, so middleware env validation doesn't apply.
	if (
		!supabaseUrl ||
		!supabaseServiceRoleKey ||
		!databaseUrl ||
		!supabaseAnonKey
	) {
		throw new Error(
			"Missing required environment variables for tests: PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PUBLIC_SUPABASE_ANON_KEY, and DATABASE_URL must be set",
		);
	}

	return { supabaseUrl, supabaseServiceRoleKey, databaseUrl, supabaseAnonKey };
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

type StockData = {
	symbol: string;
	name: string;
	exchange: string;
};

let stockDataCache: Map<string, StockData> | null = null;

function loadStockData(): Map<string, StockData> {
	if (stockDataCache) {
		return stockDataCache;
	}

	const __dirname = path.dirname(fileURLToPath(import.meta.url));
	const stocksFile = path.join(__dirname, "..", "scripts", "us-stocks.json");

	let stocksData: { data: StockData[] };
	try {
		stocksData = JSON.parse(fs.readFileSync(stocksFile, "utf-8"));
	} catch (error) {
		throw new Error(
			`Failed to load stock data from ${stocksFile}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (!Array.isArray(stocksData.data)) {
		throw new Error(
			`Invalid stock data format: expected array in 'data' property`,
		);
	}

	stockDataCache = new Map(
		stocksData.data.map((stock) => [stock.symbol.toUpperCase(), stock]),
	);

	return stockDataCache;
}

export function getStockData(symbol: string): StockData {
	const stockData = loadStockData();
	const normalizedSymbol = symbol.toUpperCase();
	const stock = stockData.get(normalizedSymbol);

	if (!stock) {
		throw new Error(
			`Stock symbol "${symbol}" (normalized: "${normalizedSymbol}") not found in stock data. Use a valid stock symbol from the us-stocks.json dataset.`,
		);
	}

	return stock;
}

export function getRealStockSymbols(count: number): string[] {
	if (count < 0) {
		throw new Error(`Requested negative symbol count: ${count}`);
	}

	const stockData = loadStockData();
	const symbols = Array.from(stockData.keys());

	if (symbols.length < count) {
		throw new Error(
			`Requested ${count} stock symbols but only ${symbols.length} available in stock data`,
		);
	}

	// Shuffle array using Fisher-Yates algorithm for varied test data
	const shuffled = [...symbols];
	for (let i = shuffled.length - 1; i > 0; i--) {
		const j = randomInt(0, i + 1);
		[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
	}

	return shuffled.slice(0, count);
}

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

export async function cleanupTestUser(userId: string): Promise<void> {
	const errors: string[] = [];

	const { error: userStocksError } = await adminClient
		.from("user_stocks")
		.delete()
		.eq("user_id", userId);
	if (userStocksError) {
		errors.push(`user_stocks: ${userStocksError.message}`);
	}

	const { error: userRowError } = await adminClient
		.from("users")
		.delete()
		.eq("id", userId);
	if (userRowError) {
		errors.push(`users: ${userRowError.message}`);
	}

	const { error: authDeleteError } =
		await adminClient.auth.admin.deleteUser(userId);
	if (authDeleteError) {
		errors.push(`auth: ${authDeleteError.message}`);
	}

	if (errors.length > 0) {
		throw new Error(`Test cleanup failed: ${errors.join("; ")}`);
	}
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
	dailyDigestNotificationTimes?: number[] | null;
	trackedStocks?: string[];
	confirmed?: boolean;
}

export interface TestUser {
	id: string;
	email: string;
}

type DbUserInsert = Omit<
	TablesInsert<"users">,
	"daily_digest_notification_time"
> & {
	daily_digest_notification_times?: number[] | null;
};
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

	try {
		// Confirm user if requested
		if (options.confirmed) {
			const { error: confirmError } =
				await adminClient.auth.admin.updateUserById(userId, {
					email_confirm: true,
				});
			if (confirmError) {
				throw new Error(`Failed to confirm user: ${confirmError.message}`);
			}
		}

		// Create Profile in 'users' table
		const dailyDigestEnabled = options.dailyDigestEnabled ?? true;
		const rawNotificationTimes = options.dailyDigestNotificationTimes ?? null;
		const normalizedTimes =
			rawNotificationTimes == null
				? dailyDigestEnabled
					? [540]
					: null
				: [
						...new Set(
							rawNotificationTimes
								.filter((value) => Number.isFinite(value))
								.map(
									(value) =>
										Math.floor(Math.max(0, Math.min(1439, value)) / 15) * 15,
								),
						),
					].sort((a, b) => a - b);
		const finalDailyDigestTimes =
			dailyDigestEnabled && normalizedTimes && normalizedTimes.length > 0
				? normalizedTimes
				: dailyDigestEnabled
					? [540]
					: null;
		const nextSendAt =
			dailyDigestEnabled && finalDailyDigestTimes
				? calculateNextSendAtFromTimes(
						finalDailyDigestTimes,
						timezone,
						DateTime.utc(),
					)
				: null;
		const nextSendAtIso = nextSendAt?.toISO() ?? null;
		if (dailyDigestEnabled && finalDailyDigestTimes) {
			if (!nextSendAtIso) {
				throw new Error("Failed to generate next_send_at timestamp");
			}
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
			daily_digest_notification_times: finalDailyDigestTimes,
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
			const stockRecords = uniqueSymbols.map((symbol) => {
				const stockData = getStockData(symbol);
				return {
					symbol: stockData.symbol,
					name: stockData.name,
					exchange: stockData.exchange,
				};
			});

			const { error: stocksTableError } = await adminClient
				.from("stocks")
				.upsert(stockRecords, { onConflict: "symbol" });

			if (stocksTableError) {
				throw new Error(
					`Stocks table setup failed: ${stocksTableError.message}`,
				);
			}

			const stockInserts: DbUserStockInsert[] = stockRecords.map((stock) => ({
				user_id: userId,
				symbol: stock.symbol,
			}));

			const { error: stockError } = await adminClient
				.from("user_stocks")
				.insert(stockInserts);

			if (stockError) {
				throw new Error(`Stock setup failed: ${stockError.message}`);
			}
		}

		return { id: userId, email };
	} catch (error) {
		// Best-effort cleanup: if any step after auth user creation fails,
		// attempt to clean up the auth user to prevent leaks
		await adminClient.auth.admin.deleteUser(userId).catch(() => {
			// Ignore cleanup errors - we're already handling a failure case
		});
		throw error;
	}
}

export async function createAuthenticatedCookies(
	email: string,
	password: string,
): Promise<Map<string, string>> {
	const supabase = createClient(testEnv.supabaseUrl, testEnv.supabaseAnonKey, {
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
