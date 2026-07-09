import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
import { enrichAliasesWithGrok, loadPersistedAliases, storePersistedAliases } from "./alias-enrich";
import { buildAssetIdentity, buildDeterministicAliases, normalizeIdentityText } from "./aliases";
import {
	discoverMarketsForAsset,
	type KalshiSeriesCatalog,
	loadKalshiCompanySeries,
} from "./discover";
import { rankDiscoveredMarkets } from "./rank";
import {
	loadUncheckedTrackedSymbols,
	persistDiscoveredMatches,
	stampPmDiscoveryCheckedAt,
} from "./registry";

/**
 * Full discovery pipeline for one tracked symbol:
 * deterministic aliases → optional Grok enrich → venue discover → rank → persist → stamp checked_at.
 *
 * Stamps checked_at only on definitive completion (including "no markets found").
 * Vendor soft-fails leave checked_at NULL so the drip retries (icon-backfill semantics).
 */
export async function runPredictionMarketDiscoveryForSymbol(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	symbol: string;
	name: string;
	/** When false, skip Grok even if aliases are incomplete. */
	enrichAliases?: boolean;
	kalshiSeriesCatalog?: KalshiSeriesCatalog;
}): Promise<{
	ok: boolean;
	matchCount: number;
	aliasCount: number;
}> {
	const { supabase, logger, symbol, name, enrichAliases = true, kalshiSeriesCatalog } = options;
	const sym = symbol.trim().toUpperCase();

	try {
		const persisted = await loadPersistedAliases(supabase, sym);
		let enrichedAliases = persisted?.aliases ?? [];

		if (
			enrichAliases &&
			(!persisted || persisted.status === "pending" || persisted.status === "failed")
		) {
			const { data: tracked } = await supabase
				.from("user_assets")
				.select("symbol, assets!inner(name)");
			const otherNorm = new Set<string>();
			for (const row of tracked ?? []) {
				if (row.symbol === sym) continue;
				const assetName = (row.assets as unknown as { name?: string } | null)?.name ?? "";
				for (const a of buildDeterministicAliases(row.symbol, assetName)) {
					otherNorm.add(normalizeIdentityText(a));
				}
			}

			try {
				const suggested = await enrichAliasesWithGrok({
					symbol: sym,
					name,
					logger,
					otherIdentityNormalized: otherNorm,
				});
				enrichedAliases = suggested;
				await storePersistedAliases({
					supabase,
					symbol: sym,
					aliases: suggested,
					status: suggested.length > 0 ? "enriched" : "skipped",
				});
			} catch (error) {
				logger.warn(
					"Alias enrich failed (continuing with baseline)",
					{ symbol: sym },
					error instanceof Error ? error : new Error(String(error)),
				);
				try {
					await storePersistedAliases({
						supabase,
						symbol: sym,
						aliases: enrichedAliases,
						status: "failed",
					});
				} catch (storeError) {
					logger.warn(
						"Failed to persist alias enrich failure status",
						{ symbol: sym },
						storeError instanceof Error ? storeError : new Error(String(storeError)),
					);
				}
			}
		}

		const identity = buildAssetIdentity({
			symbol: sym,
			name,
			persistedAliases: enrichedAliases,
		});

		const discovery = await discoverMarketsForAsset({
			identity,
			logger,
			kalshiSeriesCatalog,
		});

		if (discovery.softFailed) {
			logger.warn("Prediction-market discovery soft-failed (not stamping checked_at)", {
				symbol: sym,
				candidateCount: discovery.markets.length,
			});
			return { ok: false, matchCount: 0, aliasCount: identity.aliases.length };
		}

		const ranked = rankDiscoveredMarkets(discovery.markets, 2);
		const matchCount = await persistDiscoveredMatches({
			supabase,
			logger,
			symbol: sym,
			markets: ranked,
		});

		await stampPmDiscoveryCheckedAt(supabase, sym);

		logger.info("Prediction-market discovery complete", {
			symbol: sym,
			aliasCount: identity.aliases.length,
			candidateCount: discovery.markets.length,
			matchCount,
		});

		return { ok: true, matchCount, aliasCount: identity.aliases.length };
	} catch (error) {
		logger.error(
			"Prediction-market discovery failed",
			{ symbol: sym },
			error instanceof Error ? error : new Error(String(error)),
		);
		return { ok: false, matchCount: 0, aliasCount: 0 };
	}
}

/**
 * Nightly drip: process tracked symbols with pm_discovery_checked_at IS NULL.
 */
export async function runPredictionMarketDiscoveryDrip(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	limit: number;
}): Promise<{ processed: number; matched: number; failed: number }> {
	const { supabase, logger, limit } = options;
	const queue = await loadUncheckedTrackedSymbols({ supabase, limit });
	if (queue.length === 0) {
		logger.info("Prediction-market discovery drip empty", { limit });
		return { processed: 0, matched: 0, failed: 0 };
	}

	const kalshiSeriesCatalog = await loadKalshiCompanySeries(logger);
	let matched = 0;
	let failed = 0;

	for (const item of queue) {
		const result = await runPredictionMarketDiscoveryForSymbol({
			supabase,
			logger,
			symbol: item.symbol,
			name: item.name,
			enrichAliases: true,
			kalshiSeriesCatalog,
		});
		if (result.ok) matched += result.matchCount;
		else failed += 1;
	}

	return { processed: queue.length, matched, failed };
}
