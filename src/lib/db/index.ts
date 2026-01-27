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
export type UserStock = Pick<DbUserStockRow, "symbol" | "created_at">;

/* =============
Users
============= */

export type UserUpdateInput = DbUserUpdate;

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
			return data;
		},

		async update(id: string, updates: UserUpdateInput): Promise<User> {
			const { data, error } = await supabase
				.from("users")
				.update(updates)
				.eq("id", id)
				.select()
				.single();

			if (error) throw error;
			return data;
		},
	};
}

/* =============
Stocks
============= */

export async function getUserStocks(
	supabase: AppSupabaseClient,
	userId: string,
): Promise<UserStock[]> {
	const { data, error } = await supabase
		.from("user_stocks")
		.select("symbol, created_at")
		.eq("user_id", userId)
		.order("created_at", { ascending: false });

	if (error) throw error;

	return data;
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
