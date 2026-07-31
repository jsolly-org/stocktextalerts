import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
import { isRecord } from "../types";
import { polymarketFetch } from "../vendors/polymarket";
import { nextEtWeekdayDates, polymarketDailyDirectionSlug } from "./direction-slug";
import { loadDistinctTrackedSymbols, persistDiscoveredMatches } from "./registry";
import { detectPredictionMarketShape, ensureBinaryOutcomes } from "./shape";
import type {
	DiscoveredPredictionEvent,
	DiscoveredPredictionOutcome,
	PredictionMarketEventCard,
} from "./types";
import { assetPredictionEventKey } from "./types";
import { polymarketMarketUrl } from "./urls";

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

function parseJsonArray(raw: unknown): unknown[] | null {
	if (Array.isArray(raw)) return raw;
	if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw) as unknown;
			return Array.isArray(parsed) ? parsed : null;
		} catch {
			return null;
		}
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

function outcomesFromRow(
	marketKey: string,
	row: Record<string, unknown>,
): DiscoveredPredictionOutcome[] | null {
	const labels = (parseJsonArray(row.outcomes) ?? []).filter(
		(x): x is string => typeof x === "string" && x.trim() !== "",
	);
	const prices = (parseJsonArray(row.outcomePrices) ?? [])
		.map((p) => parseYesProbabilityPercent(p))
		.filter((p): p is number => p !== null);
	if (labels.length < 2 || prices.length < 2) return null;
	return labels.map((label, index) => ({
		venueContractId: `${marketKey}:${index}`,
		label,
		probabilityPercent: prices[index] ?? null,
		sortOrder: index,
		strikeValue: null,
		volume: 0,
	}));
}

/**
 * Fetch one Polymarket daily up/down market by deterministic slug.
 * Returns null when missing, inactive, or malformed (soft).
 */
async function fetchPolymarketDailyDirectionEvent(options: {
	symbol: string;
	sessionDateEt: string;
	logger: Logger;
}): Promise<DiscoveredPredictionEvent | null> {
	const { symbol, sessionDateEt, logger } = options;
	const slug = polymarketDailyDirectionSlug(symbol, sessionDateEt);
	if (!slug) return null;

	const payload = await polymarketFetch(
		"/markets",
		{ slug },
		`pm-direction:${symbol}:${sessionDateEt}`,
		{ optional: true },
	);
	if (payload === null) return null;

	const row = Array.isArray(payload) ? payload[0] : payload;
	if (!isRecord(row)) return null;
	if (row.closed === true || row.active === false) {
		logger.info("Polymarket daily direction inactive", { symbol, slug });
		return null;
	}

	const venueEventId = asString(row.slug) ?? slug;
	let outcomes = outcomesFromRow(venueEventId, row);
	if (!outcomes) {
		logger.warn("Polymarket daily direction missing outcomes", { symbol, slug });
		return null;
	}

	const detected = detectPredictionMarketShape({ outcomes, negRisk: false });
	if (detected.shape === "binary") {
		outcomes = ensureBinaryOutcomes(outcomes, venueEventId);
	}
	const validOutcomes = outcomes.filter((o) => o.probabilityPercent != null);
	if (validOutcomes.length === 0) return null;

	const title =
		asString(row.question) ?? asString(row.title) ?? `${symbol} Up or Down on ${sessionDateEt}?`;
	const closesAt = asString(row.endDate) ?? asString(row.end_date_iso);
	const events = Array.isArray(row.events) ? row.events : [];
	const eventSlug =
		asString(row.eventSlug) ??
		(isRecord(events[0]) ? asString(events[0].slug) : null) ??
		venueEventId;

	return {
		venue: "polymarket",
		venueEventId,
		seriesId: null,
		title,
		url: polymarketMarketUrl(venueEventId, eventSlug),
		matchKind: "direct_price",
		shape: detected.shape,
		shapeValidated: detected.validated,
		volume: asNumber(row.volumeNum ?? row.volume),
		closesAt,
		confidence: 90,
		evidence: { where: "title", alias: `(${symbol.trim().toUpperCase()})` },
		outcomes: validOutcomes,
		highlightAlias: `(${symbol.trim().toUpperCase()})`,
	};
}

/** Convert a discovered direction event into a digest card (fresh refreshedAt). */
export function directionEventToCard(
	symbol: string,
	event: DiscoveredPredictionEvent,
): PredictionMarketEventCard {
	return {
		key: assetPredictionEventKey(event.venue, event.venueEventId),
		title: event.title,
		venue: event.venue,
		url: event.url,
		shape: event.shape,
		shapeValidated: event.shapeValidated,
		closesAt: event.closesAt,
		refreshedAt: new Date().toISOString(),
		volume: event.volume,
		outcomes: event.outcomes.map((o) => ({
			venueContractId: o.venueContractId,
			label: o.label,
			probabilityPercent: o.probabilityPercent ?? 0,
			sortOrder: o.sortOrder,
			strikeValue: o.strikeValue,
			volume: o.volume,
			highlighted: false,
		})),
		symbol: symbol.trim().toUpperCase(),
		matchKind: event.matchKind,
	};
}

/** Process-local cache so multi-user digests share one probe per symbol. */
const DIRECTION_EVENT_CACHE_TTL_MS = 5 * 60 * 1000;
const directionEventCache = new Map<
	string,
	{ value: DiscoveredPredictionEvent | null; expiresAt: number }
>();
const directionEventInFlight = new Map<string, Promise<DiscoveredPredictionEvent | null>>();

/**
 * Resolve the soonest next-session Polymarket up/down event for a ticker.
 * Soft-fails to null. Cached briefly in-process.
 */
export async function resolveNextSessionDirectionEvent(options: {
	symbol: string;
	logger: Logger;
	nowMs?: number;
}): Promise<DiscoveredPredictionEvent | null> {
	const symbol = options.symbol.trim().toUpperCase();
	const nowMs = options.nowMs ?? Date.now();
	const cacheKey = symbol;
	const cached = directionEventCache.get(cacheKey);
	if (cached && cached.expiresAt > nowMs) return cached.value;

	const existing = directionEventInFlight.get(cacheKey);
	if (existing) return existing;

	const promise = (async (): Promise<DiscoveredPredictionEvent | null> => {
		for (const sessionDateEt of nextEtWeekdayDates({ nowMs, count: 3 })) {
			const event = await fetchPolymarketDailyDirectionEvent({
				symbol,
				sessionDateEt,
				logger: options.logger,
			});
			if (!event) continue;
			return event;
		}
		return null;
	})()
		.then((value) => {
			directionEventCache.set(cacheKey, {
				value,
				expiresAt: Date.now() + DIRECTION_EVENT_CACHE_TTL_MS,
			});
			return value;
		})
		.finally(() => {
			directionEventInFlight.delete(cacheKey);
		});

	directionEventInFlight.set(cacheKey, promise);
	return promise;
}

/**
 * Nightly/maintenance: probe next-session daily up/down for every tracked symbol
 * and upsert without wiping other accepted matches.
 */
export async function runNextSessionDirectionProbe(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	nowMs?: number;
	minRemainingMs?: number;
	getRemainingTimeInMillis?: () => number;
}): Promise<{ processed: number; matched: number; failed: number; skipped: number }> {
	const { supabase, logger } = options;
	const nowMs = options.nowMs ?? Date.now();
	const minRemainingMs = options.minRemainingMs ?? 120_000;
	const symbols = await loadDistinctTrackedSymbols({ supabase });
	const sessionDates = nextEtWeekdayDates({ nowMs, count: 3 });

	let processed = 0;
	let matched = 0;
	let failed = 0;

	for (const { symbol } of symbols) {
		if (options.getRemainingTimeInMillis && options.getRemainingTimeInMillis() < minRemainingMs) {
			const skipped = symbols.length - processed;
			logger.error(
				"Aborting next-session direction probe — insufficient remaining Lambda time",
				{
					processed,
					matched,
					failed,
					skipped,
					remainingMs: options.getRemainingTimeInMillis(),
					minRemainingMs,
				},
				new Error("pm_direction_probe aborted for remaining-time budget"),
			);
			return { processed, matched, failed, skipped };
		}

		try {
			let found: DiscoveredPredictionEvent | null = null;
			for (const sessionDateEt of sessionDates) {
				found = await fetchPolymarketDailyDirectionEvent({
					symbol,
					sessionDateEt,
					logger,
				});
				if (found) break;
			}
			processed += 1;
			if (!found) continue;

			const stored = await persistDiscoveredMatches({
				supabase,
				logger,
				symbol,
				markets: [found],
				replaceAcceptedSet: false,
			});
			matched += stored;
		} catch (error) {
			failed += 1;
			processed += 1;
			logger.warn(
				"Next-session direction probe failed for symbol",
				{ symbol },
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}

	return { processed, matched, failed, skipped: 0 };
}
