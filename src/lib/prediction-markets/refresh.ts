import { PM_REFRESH_NIGHTLY_CAP } from "../assets/constants";
import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
import { isRecord } from "../types";
import { kalshiFetch } from "../vendors/kalshi";
import { polymarketFetch } from "../vendors/polymarket";
import { loadActiveMatchedEvents, replaceMarketOutcomes } from "./registry";
import { detectPredictionMarketShape, ensureBinaryOutcomes, extractStrikeValue } from "./shape";
import type { DiscoveredPredictionOutcome, PredictionMarketShape } from "./types";

function parseYesProbabilityPercent(raw: unknown): number | null {
	if (typeof raw === "number" && Number.isFinite(raw)) {
		const asPercent = raw <= 1 ? raw * 100 : raw;
		if (asPercent < 0 || asPercent > 100) return null;
		return Math.round(asPercent * 10) / 10;
	}
	if (typeof raw === "string" && raw.trim() !== "") {
		const n = Number(raw);
		return Number.isFinite(n) ? parseYesProbabilityPercent(n) : null;
	}
	return null;
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function asNumber(value: unknown): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? n : 0;
}

function parsePolymarketYesPrice(market: Record<string, unknown>): number | null {
	const outcomePrices = market.outcomePrices;
	let prices: unknown = outcomePrices;
	if (typeof outcomePrices === "string") {
		try {
			prices = JSON.parse(outcomePrices) as unknown;
		} catch {
			return null;
		}
	}
	if (!Array.isArray(prices) || prices.length === 0) {
		return parseYesProbabilityPercent(market.lastTradePrice ?? market.bestBid);
	}
	return parseYesProbabilityPercent(prices[0]);
}

async function refreshPolymarketEvent(options: { venueEventId: string; logger: Logger }): Promise<{
	outcomes: DiscoveredPredictionOutcome[];
	shape: PredictionMarketShape;
	shapeValidated: boolean;
	volume: number;
	closesAt: string | null;
	status: "open" | "closed" | "inactive";
	title: string | null;
} | null> {
	const { venueEventId, logger } = options;
	const payload = await polymarketFetch(
		"/events",
		{ slug: venueEventId },
		`pm-refresh:${venueEventId}`,
		{ optional: true },
	);
	if (payload === null) return null;

	const row = Array.isArray(payload) ? payload[0] : payload;
	if (!isRecord(row)) {
		// Fallback: treat venueEventId as a market condition/slug.
		const marketPayload = await polymarketFetch(
			"/markets",
			{ slug: venueEventId },
			`pm-refresh-market:${venueEventId}`,
			{ optional: true },
		);
		if (marketPayload === null) return null;
		const market = Array.isArray(marketPayload) ? marketPayload[0] : marketPayload;
		if (!isRecord(market)) return null;
		const yes = parsePolymarketYesPrice(market);
		if (yes === null) return null;
		let outcomes = ensureBinaryOutcomes(
			[
				{
					venueContractId: asString(market.conditionId) ?? venueEventId,
					label: "Yes",
					probabilityPercent: yes,
					sortOrder: 0,
					strikeValue: null,
					volume: asNumber(market.volume),
				},
			],
			venueEventId,
		);
		const detected = detectPredictionMarketShape({ outcomes });
		if (detected.shape === "binary") {
			outcomes = ensureBinaryOutcomes(outcomes, venueEventId);
		}
		return {
			outcomes,
			shape: detected.shape,
			shapeValidated: detected.validated,
			volume: asNumber(market.volume),
			closesAt: asString(market.endDate),
			status: market.closed === true || market.active === false ? "closed" : "open",
			title: asString(market.question),
		};
	}

	const marketsRaw = Array.isArray(row.markets) ? row.markets : [];
	const outcomes: DiscoveredPredictionOutcome[] = [];
	let volume = asNumber(row.volume ?? row.volumeNum);
	for (const [index, m] of marketsRaw.entries()) {
		if (!isRecord(m)) continue;
		if (m.closed === true || m.active === false) continue;
		const conditionId = asString(m.conditionId) ?? asString(m.condition_id);
		if (!conditionId) continue;
		const label = asString(m.groupItemTitle) ?? asString(m.question) ?? `Outcome ${index + 1}`;
		const marketVolume = asNumber(m.volumeNum ?? m.volume);
		volume += marketVolume;
		outcomes.push({
			venueContractId: conditionId,
			label,
			probabilityPercent: parsePolymarketYesPrice(m),
			sortOrder: index,
			strikeValue: extractStrikeValue(label),
			volume: marketVolume,
		});
	}

	if (outcomes.length === 0) {
		logger.info("Polymarket refresh found no active outcomes", { venueEventId });
		return {
			outcomes: [],
			shape: "independent",
			shapeValidated: false,
			volume,
			closesAt: asString(row.endDate),
			status: "closed",
			title: asString(row.title),
		};
	}

	const detected = detectPredictionMarketShape({
		outcomes,
		negRisk: row.negRisk === true || row.neg_risk === true,
	});
	let finalOutcomes = outcomes.filter((o) => o.probabilityPercent != null);
	if (detected.shape === "binary") {
		finalOutcomes = ensureBinaryOutcomes(finalOutcomes, venueEventId).filter(
			(o) => o.probabilityPercent != null,
		);
	}

	// Open event with no parseable prices → soft-fail (keep last good), don't inactivate.
	if (finalOutcomes.length === 0) {
		logger.warn("Polymarket refresh open but unparseable outcomes (keeping last good)", {
			venueEventId,
		});
		return null;
	}

	return {
		outcomes: finalOutcomes,
		shape: detected.shape,
		shapeValidated: detected.validated,
		volume,
		closesAt: asString(row.endDate),
		status: row.closed === true || row.active === false ? "closed" : "open",
		title: asString(row.title),
	};
}

async function refreshKalshiEvent(options: { venueEventId: string; logger: Logger }): Promise<{
	outcomes: DiscoveredPredictionOutcome[];
	shape: PredictionMarketShape;
	shapeValidated: boolean;
	volume: number;
	closesAt: string | null;
	status: "open" | "closed" | "inactive";
	title: string | null;
} | null> {
	const { venueEventId, logger } = options;
	const payload = await kalshiFetch(
		"/markets",
		{ limit: "50", status: "open", event_ticker: venueEventId },
		`pm-refresh-kalshi:${venueEventId}`,
		{ optional: true },
	);
	if (payload === null) return null;
	if (!isRecord(payload) || !Array.isArray(payload.markets)) {
		logger.warn("Kalshi refresh missing markets array", { venueEventId });
		return null;
	}

	const outcomes: DiscoveredPredictionOutcome[] = [];
	let volume = 0;
	let closesAt: string | null = null;
	for (const [index, m] of payload.markets.entries()) {
		if (!isRecord(m)) continue;
		const ticker = asString(m.ticker);
		const title = asString(m.title) ?? ticker;
		if (!ticker || !title) continue;
		const yesBid = parseYesProbabilityPercent(m.yes_bid_dollars ?? m.yes_bid);
		const yesAsk = parseYesProbabilityPercent(m.yes_ask_dollars ?? m.yes_ask);
		const probabilityPercent =
			yesBid !== null && yesAsk !== null
				? Math.round(((yesBid + yesAsk) / 2) * 10) / 10
				: (parseYesProbabilityPercent(m.last_price_dollars) ?? yesBid ?? yesAsk);
		const marketVolume = asNumber(m.volume);
		volume += marketVolume;
		const close = asString(m.close_time) ?? asString(m.expected_expiration_time);
		if (close && (!closesAt || Date.parse(close) < Date.parse(closesAt))) {
			closesAt = close;
		}
		const floorStrike = asNumber(m.floor_strike);
		outcomes.push({
			venueContractId: ticker,
			label: payload.markets.length === 1 ? "Yes" : title,
			probabilityPercent,
			sortOrder: index,
			strikeValue:
				Number.isFinite(floorStrike) && floorStrike !== 0 ? floorStrike : extractStrikeValue(title),
			volume: marketVolume,
		});
	}

	if (outcomes.length === 0) {
		return {
			outcomes: [],
			shape: "independent",
			shapeValidated: false,
			volume: 0,
			closesAt: null,
			status: "closed",
			title: null,
		};
	}

	const detected = detectPredictionMarketShape({ outcomes });
	let finalOutcomes = outcomes.filter((o) => o.probabilityPercent != null);
	if (detected.shape === "binary") {
		finalOutcomes = ensureBinaryOutcomes(finalOutcomes, venueEventId).filter(
			(o) => o.probabilityPercent != null,
		);
	}

	if (finalOutcomes.length === 0) {
		logger.warn("Kalshi refresh open but unparseable outcomes (keeping last good)", {
			venueEventId,
		});
		return null;
	}

	return {
		outcomes: finalOutcomes,
		shape: detected.shape,
		shapeValidated: detected.validated,
		volume,
		closesAt,
		status: "open",
		title: null,
	};
}

/**
 * Midnight refresh: re-fetch all active stored event/outcome snapshots.
 * Soft-fails per event — keeps the last good snapshot when a venue call fails.
 */
export async function refreshActivePredictionMarketSnapshots(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	/** Cap events processed this run (default {@link PM_REFRESH_NIGHTLY_CAP}). */
	limit?: number;
	/** Abort when remaining Lambda ms drops below this floor. */
	minRemainingMs?: number;
	getRemainingTimeInMillis?: () => number;
}): Promise<{ refreshed: number; failed: number; closed: number; skipped: number }> {
	const { supabase, logger } = options;
	const limit = options.limit ?? PM_REFRESH_NIGHTLY_CAP;
	const minRemainingMs = options.minRemainingMs ?? 120_000;
	const allEvents = await loadActiveMatchedEvents({ supabase, logger });
	const events = allEvents.slice(0, limit);
	const skipped = Math.max(0, allEvents.length - events.length);
	let refreshed = 0;
	let failed = 0;
	let closed = 0;

	for (const event of events) {
		if (options.getRemainingTimeInMillis && options.getRemainingTimeInMillis() < minRemainingMs) {
			logger.error(
				"Aborting prediction-market refresh — insufficient remaining Lambda time",
				{
					refreshed,
					failed,
					closed,
					remainingMs: options.getRemainingTimeInMillis(),
					minRemainingMs,
				},
				new Error("pm_refresh aborted for remaining-time budget"),
			);
			break;
		}

		try {
			const snapshot =
				event.venue === "polymarket"
					? await refreshPolymarketEvent({
							venueEventId: event.eventId ?? event.venueMarketId,
							logger,
						})
					: await refreshKalshiEvent({
							venueEventId: event.eventId ?? event.venueMarketId,
							logger,
						});

			if (snapshot === null) {
				failed += 1;
				logger.warn("Prediction-market snapshot soft-failed (keeping last good)", {
					eventId: event.id,
					venue: event.venue,
					venueMarketId: event.venueMarketId,
				});
				continue;
			}

			// Explicitly closed / no active markets only — never inactivate on empty parse.
			if (snapshot.status !== "open") {
				const { error } = await supabase
					.from("prediction_markets")
					.update({
						status: snapshot.status,
						refreshed_at: new Date().toISOString(),
					})
					.eq("id", event.id);
				if (error) throw error;
				closed += 1;
				continue;
			}

			const primaryYes =
				snapshot.outcomes.find((o) => o.label.toLowerCase() === "yes")?.probabilityPercent ??
				snapshot.outcomes[0]?.probabilityPercent ??
				null;

			// Outcomes first so a failed outcome write never stamps a fresh refreshed_at
			// on a parent that still has stale legs.
			await replaceMarketOutcomes({
				supabase,
				marketId: event.id,
				outcomes: snapshot.outcomes.map((o) => ({
					venueContractId: o.venueContractId,
					label: o.label,
					probabilityPercent: o.probabilityPercent,
					sortOrder: o.sortOrder,
					strikeValue: o.strikeValue,
					volume: o.volume,
				})),
			});

			const { error: updateError } = await supabase
				.from("prediction_markets")
				.update({
					probability_percent: primaryYes,
					volume: snapshot.volume,
					closes_at: snapshot.closesAt,
					status: "open",
					shape: snapshot.shape,
					shape_validated: snapshot.shapeValidated,
					refreshed_at: new Date().toISOString(),
					...(snapshot.title
						? { label: snapshot.title.slice(0, 500), question: snapshot.title.slice(0, 1000) }
						: {}),
				})
				.eq("id", event.id);
			if (updateError) throw updateError;

			refreshed += 1;
		} catch (error) {
			failed += 1;
			logger.error(
				"Prediction-market snapshot refresh failed (keeping last good)",
				{ eventId: event.id, venue: event.venue, venueMarketId: event.venueMarketId },
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}

	if (failed > 0 && failed === events.length && events.length > 0) {
		logger.error(
			"Prediction-market snapshot refresh soft-failed for every event",
			{ eventCount: events.length, failed, skipped },
			new Error("All prediction-market refreshes soft-failed"),
		);
	} else {
		logger.info("Prediction-market snapshot refresh complete", {
			eventCount: events.length,
			refreshed,
			failed,
			closed,
			skipped,
		});
	}
	return { refreshed, failed, closed, skipped };
}
