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

type DbStockRow = Database["public"]["Tables"]["stocks"]["Row"];
type DbUserStockRow = Database["public"]["Tables"]["user_stocks"]["Row"];

/* =============
Public Types
============= */

export type User = DbUserRow;
export type Stock = DbStockRow;
export type UserStock = Pick<DbUserStockRow, "symbol" | "created_at"> & {
	name: DbStockRow["name"];
};

export type NotificationPreferencesSnapshot = Pick<
	User,
	| "price_notifications_enabled"
	| "email_notifications_enabled"
	| "sms_notifications_enabled"
	| "sms_opted_out"
	| "phone_verified"
	| "timezone"
	| "scheduled_update_times"
	| "only_notify_when_market_open"
	| "daily_only_notify_when_market_open"
	| "daily_delivery_time"
	| "daily_next_send_at"
	| "next_send_at"
	| "dismiss_timezone_mismatch_prompts"
	| "daily_include_news"
	| "daily_include_rumors"
	| "daily_include_analyst"
	| "daily_include_insider"
	| "weekly_include_earnings"
	| "weekly_include_dividends"
	| "weekly_next_send_at"
>;

export type NotificationPreferences = Pick<
	User,
	| "email_notifications_enabled"
	| "sms_notifications_enabled"
	| "scheduled_update_times"
	| "next_send_at"
>;

/* =============
Users
============= */

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

		async getById(id: string): Promise<User | null> {
			const { data, error } = await supabase
				.from("users")
				.select("*")
				.eq("id", id)
				.maybeSingle();

			if (error) throw error;
			return data as User | null;
		},

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
Stocks
============= */

/**
 * Load a user's tracked stocks (symbol + created_at + stock name).
 */
export async function getUserStocks(
	supabase: AppSupabaseClient,
	userId: string,
): Promise<UserStock[]> {
	const { data, error } = await supabase
		.from("user_stocks")
		.select("symbol, created_at, stocks!inner(name)")
		.eq("user_id", userId)
		.order("created_at", { ascending: false });

	if (error) throw error;

	return data.map((row) => ({
		symbol: row.symbol,
		created_at: row.created_at,
		name: (row as { stocks: { name: string } }).stocks.name,
	}));
}

/* =============
Objects
============= */

type NonUndefined<T> = {
	[K in keyof T]: Exclude<T[K], undefined>;
};

/**
 * Return a shallow copy of `input` with all `undefined` values removed.
 *
 * Useful for building update payloads where omitted keys should not be persisted.
 */
export function omitUndefined<T extends Record<string, unknown | undefined>>(
	input: T,
) {
	const entries = Object.entries(input).filter(
		([, value]) => value !== undefined,
	);
	return Object.fromEntries(entries) as Partial<NonUndefined<T>>;
}
