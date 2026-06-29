import type { UserAssetRow } from "../types";
import type { AppSupabaseClient } from "./supabase";

/**
 * Load a user's tracked assets (symbol + asset name) from the database.
 *
 * Throws on query errors; returns a normalized list on success.
 * Set includeLogoData when the caller will render email logos to avoid
 * unnecessary DB/network payload for SMS-only runs.
 */
export async function loadUserAssets(
	supabase: AppSupabaseClient,
	userId: string,
	options?: { includeLogoData?: boolean },
): Promise<UserAssetRow[]> {
	const includeLogoData = options?.includeLogoData === true;
	const assetSelect = includeLogoData
		? "symbol, assets!inner(name, icon_url, icon_base64)"
		: "symbol, assets!inner(name)";
	const { data: assets, error } = await supabase
		.from("user_assets")
		.select(assetSelect)
		.eq("user_id", userId);

	if (error) {
		throw error;
	}

	return assets.map((asset) => {
		const base = { symbol: asset.symbol, name: asset.assets.name };
		if (includeLogoData && "icon_url" in asset.assets) {
			return {
				...base,
				icon_url: (asset.assets as { icon_url: string | null }).icon_url,
				icon_base64: (asset.assets as { icon_base64: string | null }).icon_base64,
			};
		}
		return base;
	});
}

/** Map of user id to that user's tracked assets. */
export type UserAssetsMap = Map<string, UserAssetRow[]>;

/** Max IDs per in() filter to stay under PostgREST/URL length limits (414 URI Too Long). */
const IN_FILTER_CHUNK_SIZE = 50;

/**
 * Batch-load tracked assets for multiple users in a single query.
 *
 * Returns a Map keyed by user_id. Use this to avoid N+1 queries when processing
 * multiple users in a scheduled run.
 *
 * Chunks the user_id list to avoid PostgREST in() URL length limits (414 URI Too Long).
 * Set includeLogoData when the run may send email with logos to avoid unnecessary
 * DB/network payload for SMS-only runs.
 */
export async function batchLoadUserAssets(
	supabase: AppSupabaseClient,
	userIds: string[],
	options?: { includeLogoData?: boolean },
): Promise<UserAssetsMap> {
	if (userIds.length === 0) {
		return new Map();
	}

	const includeLogoData = options?.includeLogoData === true;
	// Include assets.delisted_at so we can filter out delisted holdings at
	// the loader level (defense in depth). The sweep sets assets.delisted_at
	// and deletes the user_assets row in the same Lambda run, but if the
	// email send fails the sweep intentionally skips cleanup so it can retry
	// next day — leaving an assets row flagged delisted while user_assets
	// still references it. This filter keeps the price fetcher from ever
	// seeing such a row, regardless of sweep state.
	const assetSelect = includeLogoData
		? "user_id, symbol, assets!inner(name, icon_url, icon_base64, delisted_at)"
		: "user_id, symbol, assets!inner(name, delisted_at)";

	const uniqueIds = [...new Set(userIds)];
	const map = new Map<string, UserAssetRow[]>();
	for (const id of uniqueIds) {
		map.set(id, []);
	}

	for (let chunkStart = 0; chunkStart < uniqueIds.length; chunkStart += IN_FILTER_CHUNK_SIZE) {
		const chunk = uniqueIds.slice(chunkStart, chunkStart + IN_FILTER_CHUNK_SIZE);
		const pageSize = 1000;
		for (let from = 0; ; from += pageSize) {
			const { data: rows, error } = await supabase
				.from("user_assets")
				.select(assetSelect)
				.in("user_id", chunk)
				.is("assets.delisted_at", null)
				.order("user_id", { ascending: true })
				.order("symbol", { ascending: true })
				.range(from, from + pageSize - 1);

			if (error) {
				throw error;
			}

			for (const row of rows ?? []) {
				const typed = row as {
					user_id: string;
					symbol: string;
					assets: {
						name: string;
						delisted_at: string | null;
					} & ({ icon_url: string | null; icon_base64: string | null } | Record<string, never>);
				};
				// Belt-and-suspenders: the PostgREST .is() filter above should
				// already exclude delisted rows, but double-check in case the
				// query ever gets refactored.
				if (typed.assets.delisted_at !== null) continue;
				const entry = map.get(typed.user_id) ?? [];
				const base = { symbol: typed.symbol, name: typed.assets.name };
				if (includeLogoData && "icon_url" in typed.assets) {
					entry.push({
						...base,
						icon_url: typed.assets.icon_url,
						icon_base64: typed.assets.icon_base64,
					});
				} else {
					entry.push(base);
				}
				map.set(typed.user_id, entry);
			}

			if ((rows ?? []).length < pageSize) {
				break;
			}
		}
	}
	return map;
}
