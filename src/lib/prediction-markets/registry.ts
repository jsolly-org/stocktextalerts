import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
import type {
	DiscoveredPredictionEvent,
	PredictionMarketOutcome,
	PredictionMarketShape,
	PredictionMatchKind,
	StoredAssetEventReading,
} from "./types";
import { assetPredictionEventKey, MATCHER_VERSION } from "./types";

export type { StoredAssetEventReading };

type OutcomeWrite = {
	venueContractId: string;
	label: string;
	probabilityPercent: number | null;
	sortOrder: number;
	strikeValue: number | null;
	volume: number;
};

/** Upsert outcomes for one event and delete legs that fell out of the snapshot. */
export async function replaceMarketOutcomes(options: {
	supabase: SupabaseAdminClient;
	marketId: string;
	outcomes: readonly OutcomeWrite[];
}): Promise<void> {
	const { supabase, marketId, outcomes } = options;
	const outcomeRows = outcomes.map((o) => ({
		prediction_market_id: marketId,
		venue_contract_id: o.venueContractId,
		label: o.label.slice(0, 500),
		probability_percent: o.probabilityPercent,
		sort_order: o.sortOrder,
		strike_value: o.strikeValue,
		volume: o.volume,
	}));

	if (outcomeRows.length > 0) {
		const { error: outcomeError } = await supabase
			.from("prediction_market_outcomes")
			.upsert(outcomeRows, { onConflict: "prediction_market_id,venue_contract_id" });
		if (outcomeError) throw outcomeError;
	}

	const keepContracts = outcomes.map((o) => o.venueContractId);
	const { data: priorOutcomes, error: priorOutcomesError } = await supabase
		.from("prediction_market_outcomes")
		.select("id,venue_contract_id")
		.eq("prediction_market_id", marketId);
	if (priorOutcomesError) throw priorOutcomesError;

	const staleOutcomeIds = (priorOutcomes ?? [])
		.filter((row) => !keepContracts.includes(row.venue_contract_id))
		.map((row) => row.id);
	if (staleOutcomeIds.length > 0) {
		const { error: deleteError } = await supabase
			.from("prediction_market_outcomes")
			.delete()
			.in("id", staleOutcomeIds);
		if (deleteError) throw deleteError;
	}
}

/** Upsert discovered events, outcomes, and accepted matches for one symbol. */
export async function persistDiscoveredMatches(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	symbol: string;
	markets: readonly DiscoveredPredictionEvent[];
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
	for (const event of markets) {
		const primaryYes =
			event.outcomes.find((o) => o.label.toLowerCase() === "yes")?.probabilityPercent ??
			event.outcomes[0]?.probabilityPercent ??
			null;

		const { data: upserted, error: upsertError } = await supabase
			.from("prediction_markets")
			.upsert(
				{
					venue: event.venue,
					venue_market_id: event.venueEventId,
					event_id: event.venueEventId,
					series_id: event.seriesId,
					label: event.title.slice(0, 500),
					question: event.title.slice(0, 1000),
					url: event.url,
					match_kind: event.matchKind,
					probability_percent: primaryYes,
					volume: event.volume,
					status: "open",
					closes_at: event.closesAt,
					refreshed_at: new Date().toISOString(),
					shape: event.shape,
					shape_validated: event.shapeValidated,
					shape_meta: {
						highlightAlias: event.highlightAlias,
						evidence: event.evidence,
					},
				},
				{ onConflict: "venue,venue_market_id" },
			)
			.select("id")
			.single();

		if (upsertError || !upserted) {
			logger.error(
				"Failed to upsert prediction_markets row",
				{ symbol, venue: event.venue, venueEventId: event.venueEventId },
				upsertError ?? new Error("missing upsert row"),
			);
			continue;
		}

		try {
			await replaceMarketOutcomes({
				supabase,
				marketId: upserted.id,
				outcomes: event.outcomes.map((o) => ({
					venueContractId: o.venueContractId,
					label: o.label,
					probabilityPercent: o.probabilityPercent,
					sortOrder: o.sortOrder,
					strikeValue: o.strikeValue,
					volume: o.volume,
				})),
			});
		} catch (error) {
			logger.error(
				"Failed to upsert prediction_market_outcomes",
				{ symbol, marketId: upserted.id, outcomeCount: event.outcomes.length },
				error instanceof Error ? error : new Error(String(error)),
			);
			continue;
		}

		const { error: matchError } = await supabase.from("asset_prediction_market_matches").upsert(
			{
				symbol,
				prediction_market_id: upserted.id,
				match_kind: event.matchKind,
				confidence: event.confidence,
				evidence: {
					...event.evidence,
					highlightAlias: event.highlightAlias,
				},
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

type LoadedMarketJoin = {
	venue: "polymarket" | "kalshi";
	venue_market_id: string;
	label: string;
	question: string;
	url: string;
	probability_percent: number | null;
	status: string;
	match_kind: PredictionMatchKind;
	shape: PredictionMarketShape | null;
	shape_validated: boolean | null;
	shape_meta: { highlightAlias?: string | null } | null;
	closes_at: string | null;
	refreshed_at: string;
	volume: number | null;
	prediction_market_outcomes: Array<{
		venue_contract_id: string;
		label: string;
		probability_percent: number | null;
		sort_order: number;
		strike_value: number | null;
		volume: number | null;
	}> | null;
};

/** Load accepted event matches for a set of symbols (digest read path). */
export async function loadAcceptedMatchesForSymbols(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	symbols: readonly string[];
}): Promise<StoredAssetEventReading[]> {
	const { supabase, logger, symbols } = options;
	if (symbols.length === 0) return [];

	const { data, error } = await supabase
		.from("asset_prediction_market_matches")
		.select(
			"symbol,match_kind,confidence,evidence,prediction_markets!inner(venue,venue_market_id,label,question,url,probability_percent,status,match_kind,shape,shape_validated,shape_meta,closes_at,refreshed_at,volume,prediction_market_outcomes(venue_contract_id,label,probability_percent,sort_order,strike_value,volume))",
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

	const out: StoredAssetEventReading[] = [];
	for (const row of data ?? []) {
		const market = row.prediction_markets as unknown as LoadedMarketJoin;
		if (market?.status !== "open") continue;

		const evidence = row.evidence as { highlightAlias?: string; alias?: string } | null;
		const highlightAlias =
			market.shape_meta?.highlightAlias ?? evidence?.highlightAlias ?? evidence?.alias ?? null;

		const outcomes: PredictionMarketOutcome[] = (market.prediction_market_outcomes ?? [])
			.flatMap((o) => {
				if (o.probability_percent == null) return [];
				const pct = Number(o.probability_percent);
				if (!Number.isFinite(pct)) return [];
				return [
					{
						venueContractId: o.venue_contract_id,
						label: o.label,
						probabilityPercent: pct,
						sortOrder: o.sort_order,
						strikeValue: o.strike_value == null ? null : Number(o.strike_value),
						volume: Number(o.volume) || 0,
						highlighted: highlightAlias
							? o.label.toLowerCase().includes(highlightAlias.toLowerCase())
							: false,
					} satisfies PredictionMarketOutcome,
				];
			})
			.sort((a, b) => a.sortOrder - b.sortOrder);

		// Legacy scalar rows without outcomes: synthesize binary Yes/No.
		let resolvedOutcomes = outcomes;
		if (resolvedOutcomes.length === 0 && market.probability_percent != null) {
			const yes = Number(market.probability_percent);
			if (Number.isFinite(yes)) {
				resolvedOutcomes = [
					{
						venueContractId: `${market.venue_market_id}:yes`,
						label: "Yes",
						probabilityPercent: yes,
						sortOrder: 0,
						strikeValue: null,
						volume: Number(market.volume) || 0,
					},
					{
						venueContractId: `${market.venue_market_id}:no`,
						label: "No",
						probabilityPercent: Math.round((100 - yes) * 10) / 10,
						sortOrder: 1,
						strikeValue: null,
						volume: Number(market.volume) || 0,
					},
				];
			}
		}
		if (resolvedOutcomes.length === 0) continue;

		out.push({
			key: assetPredictionEventKey(market.venue, market.venue_market_id),
			symbol: row.symbol,
			title: market.question || market.label,
			venue: market.venue,
			matchKind: (row.match_kind as PredictionMatchKind) || market.match_kind,
			shape: market.shape ?? "binary",
			shapeValidated: market.shape_validated ?? true,
			url: market.url,
			closesAt: market.closes_at,
			refreshedAt: market.refreshed_at,
			volume: Number(market.volume) || 0,
			confidence: Number(row.confidence) || 0,
			outcomes: resolvedOutcomes,
			highlightAlias,
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

/** Load open events that have at least one accepted/manual match (for midnight refresh). */
export async function loadActiveMatchedEvents(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
}): Promise<
	Array<{
		id: string;
		venue: "polymarket" | "kalshi";
		venueMarketId: string;
		eventId: string | null;
		url: string;
		shape: PredictionMarketShape;
	}>
> {
	const { supabase, logger } = options;
	const { data, error } = await supabase
		.from("prediction_markets")
		.select(
			"id,venue,venue_market_id,event_id,url,shape,status,asset_prediction_market_matches!inner(decision)",
		)
		.eq("status", "open")
		.in("asset_prediction_market_matches.decision", ["accepted", "manual_include"]);

	if (error) {
		logger.error("Failed to load active matched prediction events", {}, error);
		return [];
	}

	const seen = new Set<string>();
	const out: Array<{
		id: string;
		venue: "polymarket" | "kalshi";
		venueMarketId: string;
		eventId: string | null;
		url: string;
		shape: PredictionMarketShape;
	}> = [];
	for (const row of data ?? []) {
		if (seen.has(row.id)) continue;
		seen.add(row.id);
		out.push({
			id: row.id,
			venue: row.venue as "polymarket" | "kalshi",
			venueMarketId: row.venue_market_id,
			eventId: row.event_id,
			url: row.url,
			shape: (row.shape as PredictionMarketShape) ?? "binary",
		});
	}
	return out;
}
