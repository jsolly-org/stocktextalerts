import { assertAssetType } from "../types";
import type { Database } from "./generated/database.types";
import type { AppSupabaseClient } from "./supabase";
import type { UserAsset } from "./types";

type DbAssetRow = Database["public"]["Tables"]["assets"]["Row"];

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
			type: assertAssetType(assets.type),
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

export function omitUndefined<T extends Record<string, unknown | undefined>>(input: T) {
	const entries = Object.entries(input).filter(([, value]) => value !== undefined);
	return Object.fromEntries(entries) as Partial<NonUndefined<T>>;
}
