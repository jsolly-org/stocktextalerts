import { randomInt, randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import type { TablesInsert } from "../../src/lib/db/generated/database.types";
import { calculateNextSendAtFromTimes } from "../../src/lib/time/scheduled-times";
import { PRESERVED_TEST_EMAIL, TEST_RUN_ID } from "./constants";
import { getStockData } from "./stock-data";
import { adminClient } from "./test-env";

export type CreateTestUserOptions = {
	email?: string;
	password?: string;
	timezone?: string;
	emailNotificationsEnabled?: boolean;
	smsNotificationsEnabled?: boolean;
	phoneCountryCode?: string | null;
	phoneNumber?: string | null;
	phoneVerified?: boolean;
	scheduledUpdatesEnabled?: boolean;
	scheduledUpdateTimes?: number[] | null;
	trackedStocks?: string[];
	confirmed?: boolean;
};

export type TestUser = { id: string; email: string };

export function createTestEmail(prefix = "test"): string {
	const safePrefix = prefix
		.trim()
		.replace(/[^a-zA-Z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase();
	const normalizedPrefix = safePrefix.length > 0 ? safePrefix : "test";
	return `${normalizedPrefix}-${TEST_RUN_ID}-${randomUUID()}@resend.dev`;
}

function tagEmailAddress(baseEmail: string): string {
	const atIndex = baseEmail.indexOf("@");
	if (atIndex === -1) {
		return createTestEmail(baseEmail || "test");
	}

	const localPart = baseEmail.slice(0, atIndex);
	const domain = baseEmail.slice(atIndex + 1);
	return `${localPart}+${TEST_RUN_ID}-${randomUUID()}@${domain}`;
}

export async function cleanupTestUser(userId: string): Promise<void> {
	const errors: string[] = [];

	const { data: userRow, error: userFetchError } = await adminClient
		.from("users")
		.select("email")
		.eq("id", userId)
		.maybeSingle();
	if (userFetchError) {
		errors.push(`users_lookup: ${userFetchError.message}`);
	}
	if (userRow?.email === PRESERVED_TEST_EMAIL) {
		return;
	}

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

type DbUserInsert = Omit<TablesInsert<"users">, "scheduled_update_times"> & {
	scheduled_update_times?: number[] | null;
};
type DbUserStockInsert = TablesInsert<"user_stocks">;

export async function createTestUser(
	options: CreateTestUserOptions = {},
): Promise<TestUser> {
	const email =
		options.email ??
		(process.env.TEST_EMAIL_RECIPIENT
			? tagEmailAddress(process.env.TEST_EMAIL_RECIPIENT)
			: createTestEmail("test"));
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
		const scheduledUpdatesEnabled = options.scheduledUpdatesEnabled ?? true;
		const rawNotificationTimes = options.scheduledUpdateTimes ?? null;
		const normalizedTimes =
			rawNotificationTimes == null
				? scheduledUpdatesEnabled
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
		const finalScheduledUpdateTimes =
			scheduledUpdatesEnabled && normalizedTimes && normalizedTimes.length > 0
				? normalizedTimes
				: scheduledUpdatesEnabled
					? [540]
					: null;
		const nextSendAt =
			scheduledUpdatesEnabled && finalScheduledUpdateTimes
				? calculateNextSendAtFromTimes(
						finalScheduledUpdateTimes,
						timezone,
						DateTime.utc(),
					)
				: null;
		const nextSendAtIso = nextSendAt?.toISO() ?? null;
		if (scheduledUpdatesEnabled && finalScheduledUpdateTimes) {
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
			timezone,
			email_notifications_enabled: options.emailNotificationsEnabled ?? false,
			sms_notifications_enabled: smsNotificationsEnabled,
			scheduled_updates_enabled: scheduledUpdatesEnabled,
			scheduled_update_times: finalScheduledUpdateTimes,
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
