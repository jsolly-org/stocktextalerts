import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
import type {
	DiscoveredPredictionMarket,
	PredictionMatchKind,
	StoredAssetMatchReading,
} from "./types";
import { assetPredictionMarketKey, MATCHER_VERSION } from "./types";

export type { StoredAssetMatchReading };

/** Upsert discovered markets and accepted matches for one symbol. */
export async function persistDiscoveredMatches(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	symbol: string;
	markets: readonly DiscoveredPredictionMarket[];
}): Promise<number> {
	const { supabase, logger, symbol, markets } = options;
	if (markets.length === 0) {
		const { error } = await supabase
			.from("asset_prediction_market_matches")
			.update({ decision: "rejected", evaluated_at: new Date().toISOString() })
			.eq("symbol", symbol)
			.eq("decision", "accepted");
		if (error) throw error;
		return 0;
	}

	const acceptedIds: string[] = [];
	let stored = 0;
	for (const market of markets) {
		const { data: upserted, error: upsertError } = await supabase
			.from("prediction_markets")
			.upsert(
				{
					venue: market.venue,
					venue_market_id: market.venueMarketId,
					event_id: market.eventId,
					series_id: market.seriesId,
					label: market.label.slice(0, 500),
					question: market.question.slice(0, 1000),
					url: market.url,
					match_kind: market.matchKind,
					probability_percent: market.probabilityPercent,
					volume: market.volume,
					status: "open",
					closes_at: market.closesAt,
					refreshed_at: new Date().toISOString(),
				},
				{ onConflict: "venue,venue_market_id" },
			)
			.select("id")
			.single();

		if (upsertError || !upserted) {
			logger.error(
				"Failed to upsert prediction_markets row",
				{ symbol, venue: market.venue, venueMarketId: market.venueMarketId },
				upsertError ?? new Error("missing upsert row"),
			);
			continue;
		}

		const { error: matchError } = await supabase.from("asset_prediction_market_matches").upsert(
			{
				symbol,
				prediction_market_id: upserted.id,
				match_kind: market.matchKind,
				confidence: market.confidence,
				evidence: market.evidence,
				decision: "accepted",
				matcher_version: MATCHER_VERSION,
				evaluated_at: new Date().toISOString(),
			},
			{ onConflict: "symbol,prediction_market_id" },
		);

		if (matchError) {
			logger.error(
				"Failed to upsert asset_prediction_market_matches row",
				{ symbol, marketId: upserted.id },
				matchError,
			);
			continue;
		}
		acceptedIds.push(upserted.id);
		stored += 1;
	}

	if (markets.length > 0 && stored === 0) {
		throw new Error(`Failed to persist any prediction-market matches for ${symbol}`);
	}

	// Reject prior accepted rows that fell out of the new ranked set (preserve manual_*).
	const { data: prior, error: priorError } = await supabase
		.from("asset_prediction_market_matches")
		.select("id,prediction_market_id")
		.eq("symbol", symbol)
		.eq("decision", "accepted");
	if (priorError) throw priorError;

	const keep = new Set(acceptedIds);
	const staleIds = (prior ?? [])
		.filter((row) => !keep.has(row.prediction_market_id))
		.map((row) => row.id);
	if (staleIds.length > 0) {
		const { error: rejectError } = await supabase
			.from("asset_prediction_market_matches")
			.update({ decision: "rejected", evaluated_at: new Date().toISOString() })
			.in("id", staleIds);
		if (rejectError) throw rejectError;
	}

	return stored;
}

/** Stamp assets.pm_discovery_checked_at (icon-style definitive completion). */
export async function stampPmDiscoveryCheckedAt(
	supabase: SupabaseAdminClient,
	symbol: string,
): Promise<void> {
	const { error } = await supabase
		.from("assets")
		.update({ pm_discovery_checked_at: new Date().toISOString() })
		.eq("symbol", symbol);
	if (error) throw error;
}

/** Load accepted matches for a set of symbols (digest read path). */
export async function loadAcceptedMatchesForSymbols(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	symbols: readonly string[];
}): Promise<StoredAssetMatchReading[]> {
	const { supabase, logger, symbols } = options;
	if (symbols.length === 0) return [];

	const { data, error } = await supabase
		.from("asset_prediction_market_matches")
		.select(
			"symbol,match_kind,confidence,prediction_markets!inner(venue,venue_market_id,label,url,probability_percent,status,match_kind)",
		)
		.in("symbol", [...symbols])
		.in("decision", ["accepted", "manual_include"]);

	if (error) {
		logger.error(
			"Failed to load asset prediction-market matches",
			{ symbolCount: symbols.length },
			error,
		);
		return [];
	}

	const out: StoredAssetMatchReading[] = [];
	for (const row of data ?? []) {
		const market = row.prediction_markets as unknown as {
			venue: "polymarket" | "kalshi";
			venue_market_id: string;
			label: string;
			url: string;
			probability_percent: number | null;
			status: string;
			match_kind: PredictionMatchKind;
		};
		if (market?.status !== "open") continue;
		// Number(null) === 0 — skip null odds before coercing.
		if (market.probability_percent == null) continue;
		const pct = Number(market.probability_percent);
		if (!Number.isFinite(pct)) continue;
		out.push({
			key: assetPredictionMarketKey(market.venue, market.venue_market_id),
			symbol: row.symbol,
			label: `${row.symbol}: ${market.label}`,
			venue: market.venue,
			matchKind: (row.match_kind as PredictionMatchKind) || market.match_kind,
			probabilityPercent: pct,
			url: market.url,
			confidence: Number(row.confidence) || 0,
		});
	}
	return out;
}

/** Select tracked symbols still needing discovery (checked_at IS NULL). */
export async function loadUncheckedTrackedSymbols(options: {
	supabase: SupabaseAdminClient;
	limit: number;
}): Promise<Array<{ symbol: string; name: string }>> {
	const { supabase, limit } = options;

	const { data: tracked, error: trackedError } = await supabase
		.from("user_assets")
		.select("symbol, assets!inner(name, pm_discovery_checked_at, delisted_at)");
	if (trackedError) throw trackedError;

	const seen = new Set<string>();
	const out: Array<{ symbol: string; name: string }> = [];
	for (const row of tracked ?? []) {
		const assets = row.assets as unknown as {
			name: string;
			pm_discovery_checked_at: string | null;
			delisted_at: string | null;
		};
		if (!assets || assets.delisted_at || assets.pm_discovery_checked_at) continue;
		if (seen.has(row.symbol)) continue;
		seen.add(row.symbol);
		out.push({ symbol: row.symbol, name: assets.name });
		if (out.length >= limit) break;
	}
	return out;
}
