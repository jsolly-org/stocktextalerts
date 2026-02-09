import { randomInt, randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import type { TablesInsert } from "../../src/lib/db/generated/database.types";
import { calculateNextSendAtFromTimes } from "../../src/lib/time/scheduled-times";
import { getAssetData } from "./asset-data";
import { PRESERVED_TEST_EMAIL, TEST_RUN_ID } from "./constants";
import { adminClient } from "./test-env";

export function generateUniquePhoneNumber(): string {
	const suffix = randomInt(1_000_000, 9_999_999);
	return `555${String(suffix)}`;
}

export type CreateTestUserOptions = {
	email?: string;
	password?: string;
	timezone?: string;
	emailNotificationsEnabled?: boolean;
	smsNotificationsEnabled?: boolean;
	smsOptedOut?: boolean;
	phoneCountryCode?: string | null;
	phoneNumber?: string | null;
	phoneVerified?: boolean;
	scheduledUpdateTimes?: number[] | null;
	trackedAssets?: string[];
	confirmed?: boolean;
	priceIncludeEmail?: boolean;
	priceIncludeSms?: boolean;
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

	const { error: userAssetsError } = await adminClient
		.from("user_assets")
		.delete()
		.eq("user_id", userId);
	if (userAssetsError) {
		errors.push(`user_assets: ${userAssetsError.message}`);
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
		const status = (authDeleteError as { status?: number } | null)?.status;
		const code = (authDeleteError as { code?: string } | null)?.code;
		const isNotFound = status === 404 || code === "user_not_found";
		if (!isNotFound) {
			errors.push(`auth: ${authDeleteError.message}`);
		}
	}

	if (errors.length > 0) {
		throw new Error(`Test cleanup failed: ${errors.join("; ")}`);
	}
}

type DbUserInsert = Omit<TablesInsert<"users">, "scheduled_update_times"> & {
	scheduled_update_times?: number[] | null;
};
type DbUserAssetInsert = TablesInsert<"user_assets">;

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
		// "Enabled" is derived from having times — default to [540] (9:00 AM) unless explicitly null
		const rawNotificationTimes = options.scheduledUpdateTimes ?? null;
		const normalizedTimes =
			rawNotificationTimes == null
				? [540]
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
			normalizedTimes && normalizedTimes.length > 0 ? normalizedTimes : null;
		const nextSendAt = finalScheduledUpdateTimes
			? calculateNextSendAtFromTimes(
					finalScheduledUpdateTimes,
					timezone,
					DateTime.utc(),
				)
			: null;
		const nextSendAtIso = nextSendAt?.toISO() ?? null;
		if (finalScheduledUpdateTimes) {
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
			sms_opted_out: options.smsOptedOut ?? false,
			scheduled_update_times: finalScheduledUpdateTimes,
			next_send_at: nextSendAtIso,
			price_include_email:
				options.priceIncludeEmail ?? options.emailNotificationsEnabled ?? false,
			price_include_sms: options.priceIncludeSms ?? smsNotificationsEnabled,
		};

		const { error: profileError } = await adminClient
			.from("users")
			.upsert(profile, { onConflict: "id" });

		if (profileError) {
			throw new Error(`Profile setup failed: ${profileError.message}`);
		}

		// Add Tracked Assets if provided
		if (options.trackedAssets && options.trackedAssets.length > 0) {
			// Ensure assets exist in the assets table first
			const uniqueSymbols = [...new Set(options.trackedAssets)];
			const assetRecords = uniqueSymbols.map((symbol) => {
				const assetData = getAssetData(symbol);
				return {
					symbol: assetData.symbol,
					name: assetData.name,
					type: assetData.type,
				};
			});

			const { error: assetsTableError } = await adminClient
				.from("assets")
				.upsert(assetRecords, { onConflict: "symbol" });

			if (assetsTableError) {
				throw new Error(
					`Assets table setup failed: ${assetsTableError.message}`,
				);
			}

			const assetInserts: DbUserAssetInsert[] = assetRecords.map((asset) => ({
				user_id: userId,
				symbol: asset.symbol,
			}));

			const { error: assetError } = await adminClient
				.from("user_assets")
				.insert(assetInserts);

			if (assetError) {
				throw new Error(`Asset setup failed: ${assetError.message}`);
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
