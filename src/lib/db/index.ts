import type { AstroCookies } from "astro";
import { setAuthCookies } from "../auth/cookies";
import { rootLogger } from "../logging";
import type { Database } from "./generated/database.types";
import type { AppSupabaseClient } from "./supabase";

/* =============
Row Types
============= */

type DbUserRow = Database["public"]["Tables"]["users"]["Row"];
type DbUserUpdate = Database["public"]["Tables"]["users"]["Update"];

type DbAssetRow = Database["public"]["Tables"]["assets"]["Row"];
type DbUserAssetRow = Database["public"]["Tables"]["user_assets"]["Row"];

/* =============
Public Types
============= */

/** Full `users` table row type (public schema). */
export type User = DbUserRow;
/** A user's tracked asset joined with canonical asset details. */
export type UserAsset = Pick<DbUserAssetRow, "symbol" | "created_at"> & {
	name: DbAssetRow["name"];
	type: DbAssetRow["type"];
	icon_url: DbAssetRow["icon_url"];
};

/** Snapshot of user notification-related columns used for quick comparisons/decisions. */
export type NotificationPreferencesSnapshot = Pick<
	User,
	| "market_scheduled_asset_price_enabled"
	| "email_notifications_enabled"
	| "sms_notifications_enabled"
	| "sms_opted_out"
	| "phone_verified"
	| "timezone"
	| "market_scheduled_asset_price_times"
	| "daily_digest_time"
	| "daily_digest_next_send_at"
	| "market_scheduled_asset_price_next_send_at"
	| "dismiss_timezone_mismatch_prompts"
	| "daily_digest_include_news_email"
	| "daily_digest_include_rumors_email"
	| "market_scheduled_asset_price_include_email"
	| "market_scheduled_asset_price_include_sms"
	| "asset_events_include_calendar_email"
	| "asset_events_include_calendar_sms"
	| "asset_events_include_ipo_email"
	| "asset_events_include_ipo_sms"
	| "asset_events_include_analyst_email"
	| "asset_events_include_analyst_sms"
	| "asset_events_include_insider_email"
	| "asset_events_include_insider_sms"
	| "asset_events_next_send_at"
	| "asset_events_last_analyst_sent_month"
	| "market_asset_price_alerts_enabled"
	| "market_asset_price_alerts_include_email"
	| "market_asset_price_alerts_include_sms"
	| "market_asset_price_alert_move_size"
>;

/** Subset of notification preferences editable from the dashboard UI. */
export type NotificationPreferences = Pick<
	User,
	| "email_notifications_enabled"
	| "market_scheduled_asset_price_times"
	| "market_scheduled_asset_price_next_send_at"
>;

/* =============
Users
============= */

/** Allowed update payload for the `users` table. */
export type UserUpdateInput = DbUserUpdate;

/**
 * Create a small, cookie-aware user service wrapper around the Supabase client.
 *
 * This centralizes session refresh + cookie updates so RLS-backed queries keep working.
 */
export function createUserService(
	supabase: AppSupabaseClient,
	cookies: AstroCookies,
) {
	return {
		/**
		 * Resolve the current authenticated user from auth cookies.
		 *
		 * Refreshes the Supabase session and updates cookies when tokens rotate.
		 * Returns `null` when unauthenticated or when tokens are invalid/expired.
		 */
		async getCurrentUser() {
			const accessToken = cookies.get("sb-access-token");
			const refreshToken = cookies.get("sb-refresh-token");

			if (!accessToken || !refreshToken) {
				return null;
			}

			// Set session on client for RLS to work. This ensures subsequent queries
			// (like getById) can access user data via RLS policies.
			const sessionResponse = await supabase.auth.setSession({
				access_token: accessToken.value,
				refresh_token: refreshToken.value,
			});

			if (sessionResponse.error || !sessionResponse.data.session) {
				if (sessionResponse.error) {
					// Only log unexpected errors (server errors, network issues)
					// Status 400/401 are expected for invalid/expired tokens
					const status = sessionResponse.error.status;
					const isExpectedAuthFailure =
						status === 400 || status === 401 || status === 403;

					if (!isExpectedAuthFailure) {
						const userId =
							sessionResponse.data?.user &&
							typeof sessionResponse.data.user === "object" &&
							"id" in sessionResponse.data.user
								? (sessionResponse.data.user as { id: string }).id
								: undefined;
						rootLogger.error("session lookup failed", {
							error: sessionResponse.error.message,
							code: sessionResponse.error.code,
							status: sessionResponse.error.status,
							userId,
						});
					}
				}
				return null;
			}

			// Update cookies with refreshed tokens if they changed
			const newAccessToken = sessionResponse.data.session.access_token;
			const newRefreshToken = sessionResponse.data.session.refresh_token;
			if (
				newAccessToken !== accessToken.value ||
				newRefreshToken !== refreshToken.value
			) {
				setAuthCookies(cookies, newAccessToken, newRefreshToken);
			}

			return sessionResponse.data.user ?? null;
		},

		/**
		 * Fetch a user row by id using RLS.
		 */
		async getById(id: string): Promise<User | null> {
			const { data, error } = await supabase
				.from("users")
				.select("*")
				.eq("id", id)
				.maybeSingle();

			if (error) throw error;
			return data as User | null;
		},

		/**
		 * Update a user row by id and return the updated record.
		 */
		async update(id: string, updates: UserUpdateInput): Promise<User> {
			const { data, error } = await supabase
				.from("users")
				.update(updates)
				.eq("id", id)
				.select()
				.single();

			if (error) throw error;
			return data as User;
		},
	};
}

/* =============
Assets
============= */

/**
 * Load a user's tracked assets (symbol + created_at + asset name).
 */
export async function getUserAssets(
	supabase: AppSupabaseClient,
	userId: string,
): Promise<UserAsset[]> {
	const { data, error } = await supabase
		.from("user_assets")
		.select("symbol, created_at, assets!inner(name, type, icon_url)")
		.eq("user_id", userId)
		.order("created_at", { ascending: false });

	if (error) throw error;

	return data.map((row) => {
		const { assets } = row as {
			assets: Pick<DbAssetRow, "name" | "type" | "icon_url">;
		};
		return {
			symbol: row.symbol,
			created_at: row.created_at,
			name: assets.name,
			type: assets.type,
			icon_url: assets.icon_url,
		};
	});
}

/* =============
Objects
============= */

type NonUndefined<T> = {
	[K in keyof T]: Exclude<T[K], undefined>;
};

export function omitUndefined<T extends Record<string, unknown | undefined>>(
	input: T,
) {
	const entries = Object.entries(input).filter(
		([, value]) => value !== undefined,
	);
	return Object.fromEntries(entries) as Partial<NonUndefined<T>>;
}
