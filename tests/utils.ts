import { randomInt, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { DateTime } from "luxon";
import type { TablesInsert } from "../src/lib/db/generated/database.types";
import { calculateNextSendAt } from "../src/lib/time/schedule";
import { adminClient } from "./setup";

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

		const stockInserts: DbUserStockInsert[] = options.trackedStocks.map(
			(symbol) => ({
				user_id: userId,
				symbol,
			}),
		);

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
