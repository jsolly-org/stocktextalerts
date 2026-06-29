import { randomInt, randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import type { TablesInsert } from "../../src/lib/db/generated/database.types";
import {
	buildDefaultPreferenceRows,
	type PrefChannel,
} from "../../src/lib/messaging/notification-prefs";
import { userLocalToEtMinute } from "../../src/lib/time/conversion";
import { calculateNextSendAtFromTimes } from "../../src/lib/time/schedule/next-send";
import { getAssetData } from "./asset-data";
import { upsertAssets } from "./asset-db";
import { PRESERVED_TEST_EMAIL, TEST_RUN_ID } from "./constants";
import { adminClient } from "./test-env";

/**
 * Upsert notification_preferences rows for a test user.
 *
 * Per-option channel preferences are the single source of truth — tests that used
 * to set `users.*_include_*` columns set table rows instead. Each spec is
 * `[notification_type, content, channel, enabled]` (content "" for market types).
 */
export async function setTestUserPrefs(
	userId: string,
	specs: ReadonlyArray<[string, string, PrefChannel, boolean]>,
): Promise<void> {
	if (specs.length === 0) return;
	const rows = specs.map(([notification_type, content, channel, enabled]) => ({
		user_id: userId,
		notification_type,
		content,
		channel,
		enabled,
	}));
	const { error } = await adminClient
		.from("notification_preferences")
		.upsert(rows, { onConflict: "user_id,notification_type,content,channel" });
	if (error) {
		throw new Error(`setTestUserPrefs failed: ${error.message}`);
	}
}

export function generateUniquePhoneNumber(): string {
	const suffix = randomInt(1_000_000, 9_999_999);
	return `555${String(suffix)}`;
}

export async function getTestUserPhone(userId: string): Promise<string> {
	const { data: user, error } = await adminClient
		.from("users")
		.select("phone_country_code,phone_number")
		.eq("id", userId)
		.single();
	if (error) throw new Error(`getTestUserPhone failed: ${error.message}`);
	if (!user) throw new Error("expected user row");
	if (!user.phone_country_code || !user.phone_number) {
		throw new Error("expected user phone fields");
	}
	return `${user.phone_country_code}${user.phone_number}`;
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
	approved?: boolean;
	marketScheduledAssetPriceIncludeEmail?: boolean;
	marketScheduledAssetPriceIncludeSms?: boolean;
};

export type TestUser = { id: string; email: string };

// Test recipients are always @example.com — a non-routable domain. Tests
// must never reference a real mailbox, and the per-run UUID suffix keeps
// addresses unique across parallel workers. "Live" email tests route
// delivery through local Mailpit (see src/lib/messaging/email/utils.ts);
// Mailpit accepts any recipient domain so @example.com is fine there too.
export function createTestEmail(prefix = "test"): string {
	const safePrefix = prefix
		.trim()
		.replace(/[^a-zA-Z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase();
	const normalizedPrefix = safePrefix.length > 0 ? safePrefix : "test";
	const label = `${normalizedPrefix}-${TEST_RUN_ID}-${randomUUID()}`;
	return `${label}@example.com`;
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

	const { error: userRowError } = await adminClient.from("users").delete().eq("id", userId);
	if (userRowError) {
		errors.push(`users: ${userRowError.message}`);
	}

	const { error: authDeleteError } = await adminClient.auth.admin.deleteUser(userId);
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

type DbUserInsert = Omit<TablesInsert<"users">, "market_scheduled_asset_price_times"> & {
	market_scheduled_asset_price_times?: number[] | null;
};
type DbUserAssetInsert = TablesInsert<"user_assets">;

export async function createTestUser(options: CreateTestUserOptions = {}): Promise<TestUser> {
	// TEST_EMAIL_RECIPIENT env fallback was removed on 2026-04-11. It
	// allowed a real address (e.g. test@jsolly.com) to leak into test
	// users and caused an accidental real-email delivery. Test users
	// always use @example.com addresses generated by createTestEmail().
	const email = options.email ?? createTestEmail("test");
	const password = options.password || "TestPassword123!";
	const timezone = options.timezone || "America/New_York";
	const smsNotificationsEnabled = options.smsNotificationsEnabled ?? false;
	const approved = options.approved ?? true;

	const defaultPhoneCountryCode = "+1";
	const defaultPhoneNumber = `500555${String(randomInt(0, 10000)).padStart(4, "0")}`;

	const phoneCountryCode =
		options.phoneCountryCode ?? (smsNotificationsEnabled ? defaultPhoneCountryCode : null);
	const phoneNumber = options.phoneNumber ?? (smsNotificationsEnabled ? defaultPhoneNumber : null);
	const phoneVerified = options.phoneVerified ?? false;
	if (smsNotificationsEnabled && (!phoneCountryCode || !phoneNumber)) {
		throw new Error(
			"Invalid test user: smsNotificationsEnabled requires phoneCountryCode and phoneNumber",
		);
	}
	if (smsNotificationsEnabled && options.smsOptedOut) {
		throw new Error(
			"Invalid test user: smsNotificationsEnabled and smsOptedOut cannot both be true (violates database constraint)",
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
			const { error: confirmError } = await adminClient.auth.admin.updateUserById(userId, {
				email_confirm: true,
			});
			if (confirmError) {
				throw new Error(`Failed to confirm user: ${confirmError.message}`);
			}
		}

		// Create Profile in 'users' table
		// "Enabled" is derived from having times — default to [540] (9:00 AM) unless explicitly null.
		// Test callers pass user-local minutes; storage is ET-canonical (matches API
		// boundary in notification-preferences-update.ts).
		const rawNotificationTimes = options.scheduledUpdateTimes ?? null;
		const normalizedTimes =
			rawNotificationTimes == null
				? [540]
				: [
						...new Set(
							rawNotificationTimes
								.filter((value) => Number.isFinite(value))
								.map((value) => Math.floor(Math.max(0, Math.min(1439, value)) / 15) * 15),
						),
					].sort((a, b) => a - b);
		const etCanonicalTimes =
			normalizedTimes && normalizedTimes.length > 0
				? [...new Set(normalizedTimes.map((m) => userLocalToEtMinute(m, timezone)))].sort(
						(a, b) => a - b,
					)
				: [];
		const finalMarketScheduledPriceTimes = etCanonicalTimes.length > 0 ? etCanonicalTimes : null;
		const nextSendAt = finalMarketScheduledPriceTimes
			? calculateNextSendAtFromTimes(finalMarketScheduledPriceTimes, DateTime.utc())
			: null;
		const nextSendAtIso = nextSendAt?.toISO() ?? null;
		if (finalMarketScheduledPriceTimes) {
			if (!nextSendAtIso) {
				throw new Error("Failed to generate market_scheduled_asset_price_next_send_at timestamp");
			}
		}

		const profile: DbUserInsert = {
			id: userId,
			email,
			approved_at: approved ? DateTime.utc().toISO() : null,
			approved_by: approved ? "test" : null,
			phone_country_code: phoneCountryCode,
			phone_number: phoneNumber,
			phone_verified: phoneVerified,
			timezone,
			email_notifications_enabled: options.emailNotificationsEnabled ?? false,
			sms_notifications_enabled: smsNotificationsEnabled,
			sms_opted_out: options.smsOptedOut ?? false,
			market_scheduled_asset_price_times: finalMarketScheduledPriceTimes,
			market_scheduled_asset_price_next_send_at: nextSendAtIso,
		};

		const { error: profileError } = await adminClient
			.from("users")
			.upsert(profile, { onConflict: "id" });

		if (profileError) {
			throw new Error(`Profile setup failed: ${profileError.message}`);
		}

		// Per-option channel preferences live in notification_preferences. Seed the
		// default rows (prices email+sms on; everything else off), then apply the
		// scheduled-market overrides the test requested.
		const defaultRows = buildDefaultPreferenceRows(userId);
		const scheduledIncludeEmail =
			options.marketScheduledAssetPriceIncludeEmail ?? options.emailNotificationsEnabled ?? false;
		const scheduledIncludeSms =
			options.marketScheduledAssetPriceIncludeSms ?? smsNotificationsEnabled;
		for (const row of defaultRows) {
			if (row.notification_type === "market_scheduled_asset_price" && row.content === "") {
				if (row.channel === "email") row.enabled = scheduledIncludeEmail;
				if (row.channel === "sms") row.enabled = scheduledIncludeSms;
			}
		}
		const { error: prefsError } = await adminClient
			.from("notification_preferences")
			.upsert(defaultRows, { onConflict: "user_id,notification_type,content,channel" });
		if (prefsError) {
			throw new Error(`Notification preferences setup failed: ${prefsError.message}`);
		}

		// Add Tracked Assets if provided
		if (options.trackedAssets && options.trackedAssets.length > 0) {
			// Ensure assets exist in the assets table first
			const uniqueSymbols = [
				...new Set(options.trackedAssets.map((symbol) => symbol.trim().toUpperCase())),
			];
			const assetRecords = uniqueSymbols.map((symbol) => {
				const assetData = getAssetData(symbol);
				return {
					symbol: assetData.symbol,
					name: assetData.name,
					type: assetData.type,
				};
			});

			await upsertAssets(assetRecords);

			const assetInserts: DbUserAssetInsert[] = assetRecords.map((asset) => ({
				user_id: userId,
				symbol: asset.symbol,
			}));

			const { error: assetError } = await adminClient.from("user_assets").insert(assetInserts);

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
