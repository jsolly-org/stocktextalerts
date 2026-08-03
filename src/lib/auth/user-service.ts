import type { AstroCookies } from "astro";
import { getApprovalCached } from "../db/approval-cache";
import type { Database } from "../db/generated/database.types";
import type { AppSupabaseClient } from "../db/supabase";
import { rootLogger } from "../logging";
import { isApprovedAtValue } from "./approval/status";
import { setAuthCookies } from "./session/cookies";

type User = Database["public"]["Tables"]["users"]["Row"];
type UserUpdateInput = Database["public"]["Tables"]["users"]["Update"];

/**
 * Create a small, cookie-aware user service wrapper around the Supabase client.
 *
 * This centralizes session refresh + cookie updates so RLS-backed queries keep working.
 */
export function createUserService(supabase: AppSupabaseClient, cookies: AstroCookies) {
	return {
		/**
		 * Resolve the current authenticated user from auth cookies.
		 *
		 * Refreshes the Supabase session and updates cookies when tokens rotate.
		 * Returns `null` when unauthenticated or when tokens are invalid/expired.
		 */
		async getCurrentUser(options: { requireApproval?: boolean } = {}) {
			const requireApproval = options.requireApproval ?? true;
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
					const isExpectedAuthFailure = status === 400 || status === 401 || status === 403;

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
			if (newAccessToken !== accessToken.value || newRefreshToken !== refreshToken.value) {
				setAuthCookies(cookies, newAccessToken, newRefreshToken);
			}

			const authUser = sessionResponse.data.user ?? null;
			if (!authUser || !requireApproval) {
				return authUser;
			}

			const approved = await getApprovalCached(authUser.id, async () => {
				const { data: dbUser, error: dbUserError } = await supabase
					.from("users")
					.select("approved_at")
					.eq("id", authUser.id)
					.maybeSingle();
				if (dbUserError) {
					rootLogger.error("approval lookup failed", {
						error: dbUserError.message,
						userId: authUser.id,
					});
					return false;
				}
				return isApprovedAtValue(dbUser?.approved_at ?? null);
			});

			if (!approved) {
				return null;
			}

			return authUser;
		},

		/**
		 * Fetch a user row by id using RLS.
		 */
		async getById(id: string): Promise<User | null> {
			const { data, error } = await supabase.from("users").select("*").eq("id", id).maybeSingle();

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
