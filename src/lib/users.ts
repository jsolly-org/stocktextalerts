import type { AstroCookies } from "astro";
import type { Database } from "./generated/database.types";
import type { AppSupabaseClient } from "./supabase";

type DbUserRow = Database["public"]["Tables"]["users"]["Row"];
type DbUserUpdate = Database["public"]["Tables"]["users"]["Update"];

export type User = DbUserRow;

type UserUpdateInput = DbUserUpdate;

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

			try {
				const { data, error } = await supabase.auth.setSession({
					refresh_token: refreshToken.value,
					access_token: accessToken.value,
				});

				if (error || !data.user) {
					return null;
				}

				return data.user;
			} catch {
				return null;
			}
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
