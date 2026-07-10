import type { Logger } from "../logging";
import { isRecord } from "../types";
import { kalshiFetch } from "../vendors/kalshi";
import { polymarketFetch } from "../vendors/polymarket";
import { polymarketSearchQueries } from "./aliases";
import { findIdentityEvidence, isJunkTitle, resolveMatchKind } from "./match";
import { detectPredictionMarketShape, ensureBinaryOutcomes, extractStrikeValue } from "./shape";
import type {
	AssetIdentity,
	DiscoveredPredictionEvent,
	DiscoveredPredictionOutcome,
} from "./types";
import { kalshiMarketUrl, polymarketMarketUrl } from "./urls";

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

function parseOutcomeLabels(market: Record<string, unknown>): string[] {
	const raw = market.outcomes;
	let outcomes: unknown = raw;
	if (typeof raw === "string") {
		try {
			outcomes = JSON.parse(raw) as unknown;
		} catch {
			return [];
		}
	}
	if (!Array.isArray(outcomes)) return [];
	return outcomes.filter((x): x is string => typeof x === "string" && x.trim() !== "");
}

function parseOutcomePrices(market: Record<string, unknown>): number[] {
	const raw = market.outcomePrices;
	let prices: unknown = raw;
	if (typeof raw === "string") {
		try {
			prices = JSON.parse(raw) as unknown;
		} catch {
			return [];
		}
	}
	if (!Array.isArray(prices)) return [];
	return prices.map((p) => parseYesProbabilityPercent(p)).filter((p): p is number => p !== null);
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function asNumber(value: unknown): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? n : 0;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type VenueDiscoveryResult = {
	events: DiscoveredPredictionEvent[];
	/**
	 * True when a required venue call soft-failed (optional fetch returned null).
	 * Callers must NOT stamp pm_discovery_checked_at or reject prior matches.
	 */
	softFailed: boolean;
};

type PolyMarketRow = {
	conditionId: string;
	question: string;
	slug: string;
	groupItemTitle: string | null;
	closed: boolean;
	active: boolean;
	volume: number;
	endDate: string | null;
	probabilityPercent: number | null;
	outcomeLabels: string[];
	outcomePrices: number[];
};

function flattenPolymarketEvent(event: Record<string, unknown>): {
	title: string;
	eventSlug: string | null;
	negRisk: boolean;
	markets: PolyMarketRow[];
	endDate: string | null;
	volume: number;
} {
	const title = asString(event.title) ?? "";
	const eventSlug = asString(event.slug);
	const marketsRaw = Array.isArray(event.markets) ? event.markets : [];
	const markets: PolyMarketRow[] = [];
	let volume = asNumber(event.volume ?? event.volumeNum);
	for (const m of marketsRaw) {
		if (!isRecord(m)) continue;
		const conditionId = asString(m.conditionId) ?? asString(m.condition_id);
		const slug = asString(m.slug) ?? eventSlug;
		if (!conditionId || !slug) continue;
		const marketVolume = asNumber(m.volumeNum ?? m.volume);
		volume += marketVolume;
		markets.push({
			conditionId,
			question: asString(m.question) ?? title,
			slug,
			groupItemTitle: asString(m.groupItemTitle),
			closed: m.closed === true,
			active: m.active !== false,
			volume: marketVolume,
			endDate: asString(m.endDate) ?? asString(event.endDate),
			probabilityPercent: parsePolymarketYesPrice(m),
			outcomeLabels: parseOutcomeLabels(m),
			outcomePrices: parseOutcomePrices(m),
		});
	}
	return {
		title,
		eventSlug,
		negRisk: event.negRisk === true || event.neg_risk === true,
		markets,
		endDate: asString(event.endDate),
		volume,
	};
}

function buildPolymarketOutcomes(markets: readonly PolyMarketRow[]): DiscoveredPredictionOutcome[] {
	// Multi-market event: each child market is an outcome leg (groupItemTitle).
	if (markets.length > 1) {
		return markets.map((m, index) => {
			const label = m.groupItemTitle ?? m.question;
			return {
				venueContractId: m.conditionId,
				label,
				probabilityPercent: m.probabilityPercent,
				sortOrder: index,
				strikeValue: extractStrikeValue(label),
				volume: m.volume,
			};
		});
	}

	const market = markets[0];
	if (!market) return [];

	// Single market with explicit Yes/No outcomePrices alignment.
	if (market.outcomeLabels.length >= 2 && market.outcomePrices.length >= 2) {
		return market.outcomeLabels.map((label, index) => ({
			venueContractId: `${market.conditionId}:${index}`,
			label,
			probabilityPercent: market.outcomePrices[index] ?? null,
			sortOrder: index,
			strikeValue: extractStrikeValue(label),
			volume: market.volume,
		}));
	}

	return [
		{
			venueContractId: market.conditionId,
			label: "Yes",
			probabilityPercent: market.probabilityPercent,
			sortOrder: 0,
			strikeValue: null,
			volume: market.volume,
		},
	];
}

async function discoverPolymarket(
	identity: AssetIdentity,
	logger: Logger,
): Promise<VenueDiscoveryResult> {
	const out: DiscoveredPredictionEvent[] = [];
	const seen = new Set<string>();
	let gotUsablePayload = false;
	let softFailed = false;

	// public-search supports `page` + `limit_per_type` (no documented hard max on
	// limit_per_type). Page until a short/empty page — same spirit as Kalshi cursors.
	const LIMIT_PER_TYPE = 50;
	const MAX_SEARCH_PAGES = 100;

	for (const q of polymarketSearchQueries(identity)) {
		for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
			const payload = await polymarketFetch(
				"/public-search",
				{
					q,
					events_status: "active",
					limit_per_type: String(LIMIT_PER_TYPE),
					page: String(page),
					keep_closed_markets: "0",
				},
				`pm-discover:${identity.symbol}`,
				{ optional: true },
			);
			if (payload === null) {
				softFailed = true;
				break;
			}
			if (!isRecord(payload) || !Array.isArray(payload.events)) break;
			gotUsablePayload = true;
			const pageEvents = payload.events;
			if (pageEvents.length === 0) break;

			for (const event of pageEvents) {
				if (!isRecord(event)) continue;
				const flat = flattenPolymarketEvent(event);
				if (isJunkTitle(flat.title)) continue;
				const activeMarkets = flat.markets.filter((m) => !m.closed && m.active);
				if (activeMarkets.length === 0) continue;

				const venueEventId = flat.eventSlug ?? activeMarkets[0]?.conditionId;
				if (!venueEventId || seen.has(venueEventId)) continue;

				const outcomeLabels = activeMarkets
					.map((m) => m.groupItemTitle)
					.filter((x): x is string => Boolean(x));

				const eventEvidence = findIdentityEvidence(flat.title, outcomeLabels, identity);
				if (!eventEvidence) {
					// Also accept when a single-market question matches.
					const questionEvidence = activeMarkets
						.map((m) => findIdentityEvidence(m.question, [], identity))
						.find((e) => e !== null);
					if (!questionEvidence) continue;
				}

				const evidence =
					eventEvidence ??
					findIdentityEvidence(activeMarkets[0]?.question ?? flat.title, [], identity);
				if (!evidence) continue;

				const questionForKind = activeMarkets[0]?.question || flat.title;
				const matchKind = resolveMatchKind(questionForKind, evidence);
				if (!matchKind) continue;

				let outcomes = buildPolymarketOutcomes(activeMarkets);
				const detected = detectPredictionMarketShape({
					outcomes,
					negRisk: flat.negRisk,
				});
				if (detected.shape === "binary") {
					outcomes = ensureBinaryOutcomes(outcomes, venueEventId);
				}

				const validOutcomes = outcomes.filter((o) => o.probabilityPercent != null);
				if (validOutcomes.length === 0) continue;

				const closesAt =
					flat.endDate ??
					activeMarkets.map((m) => m.endDate).find((d): d is string => Boolean(d)) ??
					null;

				const primaryUrl = polymarketMarketUrl(
					activeMarkets[0]?.slug ?? venueEventId,
					flat.eventSlug,
				);

				seen.add(venueEventId);
				out.push({
					venue: "polymarket",
					venueEventId,
					seriesId: null,
					title: flat.title || questionForKind,
					url: primaryUrl,
					matchKind,
					shape: detected.shape,
					shapeValidated: detected.validated,
					volume: flat.volume || activeMarkets.reduce((s, m) => s + m.volume, 0),
					closesAt,
					confidence: evidence.where === "title" ? 80 : 70,
					evidence,
					outcomes: validOutcomes,
					highlightAlias: evidence.alias,
				});
			}

			if (pageEvents.length < LIMIT_PER_TYPE) break;
			if (page === MAX_SEARCH_PAGES - 1) {
				logger.warn("Polymarket public-search hit page ceiling", {
					symbol: identity.symbol,
					q,
					pages: MAX_SEARCH_PAGES,
				});
			}
		}
	}

	logger.info("Polymarket discovery complete", {
		symbol: identity.symbol,
		candidateCount: out.length,
		softFailed: softFailed && !gotUsablePayload,
	});
	return { events: out, softFailed: softFailed && !gotUsablePayload };
}

export type KalshiSeriesCatalog = {
	series: Array<{ ticker: string; title: string }>;
	softFailed: boolean;
};

/** Kalshi list endpoints: page size 1–100 (docs default 100). */
const KALSHI_PAGE_LIMIT = 100;
/** Runaway-cursor guard — not a product cap; log if hit. */
const KALSHI_MAX_PAGES = 10_000;

async function loadKalshiCompanySeries(logger: Logger): Promise<KalshiSeriesCatalog> {
	const all: Array<{ ticker: string; title: string }> = [];
	let cursor = "";
	for (let page = 0; page < KALSHI_MAX_PAGES; page++) {
		const params: Record<string, string> = {
			limit: String(KALSHI_PAGE_LIMIT),
			category: "Companies",
		};
		if (cursor) params.cursor = cursor;
		const payload = await kalshiFetch("/series", params, "pm-kalshi-series", {
			optional: true,
		});
		if (payload === null) {
			logger.warn("Kalshi Companies series soft-failed", { page, loaded: all.length });
			return { series: all, softFailed: true };
		}
		if (!isRecord(payload) || !Array.isArray(payload.series)) {
			return { series: all, softFailed: page === 0 };
		}
		for (const s of payload.series) {
			if (!isRecord(s)) continue;
			const ticker = asString(s.ticker);
			const title = asString(s.title) ?? "";
			if (ticker) all.push({ ticker, title });
		}
		cursor = asString(payload.cursor) ?? "";
		if (!cursor || payload.series.length === 0) break;
		if (page === KALSHI_MAX_PAGES - 1) {
			logger.error(
				"Kalshi Companies series hit page ceiling — catalog may be truncated",
				{ pages: KALSHI_MAX_PAGES, loaded: all.length },
				new Error("kalshi series pagination ceiling"),
			);
		}
	}
	logger.info("Kalshi Companies series loaded", { count: all.length });
	return { series: all, softFailed: false };
}

type KalshiMarketRow = {
	ticker: string;
	title: string;
	eventTicker: string;
	probabilityPercent: number | null;
	volume: number;
	closesAt: string | null;
	strikeValue: number | null;
};

/** Fetch every open market for a series (cursor-paginate per Kalshi docs). */
async function loadOpenKalshiMarketsForSeries(
	seriesTicker: string,
	logger: Logger,
): Promise<{ markets: Record<string, unknown>[]; softFailed: boolean }> {
	const markets: Record<string, unknown>[] = [];
	let cursor = "";
	for (let page = 0; page < KALSHI_MAX_PAGES; page++) {
		const params: Record<string, string> = {
			limit: String(KALSHI_PAGE_LIMIT),
			status: "open",
			series_ticker: seriesTicker,
		};
		if (cursor) params.cursor = cursor;
		const payload = await kalshiFetch("/markets", params, `pm-kalshi-markets:${seriesTicker}`, {
			optional: true,
		});
		if (payload === null) {
			return { markets, softFailed: true };
		}
		if (!isRecord(payload) || !Array.isArray(payload.markets)) {
			return { markets, softFailed: page === 0 && markets.length === 0 };
		}
		for (const m of payload.markets) {
			if (isRecord(m)) markets.push(m);
		}
		cursor = asString(payload.cursor) ?? "";
		if (!cursor || payload.markets.length === 0) break;
		if (page === KALSHI_MAX_PAGES - 1) {
			logger.error(
				"Kalshi markets hit page ceiling — series may be truncated",
				{ seriesTicker, pages: KALSHI_MAX_PAGES, loaded: markets.length },
				new Error("kalshi markets pagination ceiling"),
			);
		}
	}
	return { markets, softFailed: false };
}

async function discoverKalshi(
	identity: AssetIdentity,
	seriesCatalog: readonly { ticker: string; title: string }[],
	logger: Logger,
): Promise<VenueDiscoveryResult> {
	const sym = identity.symbol;
	const seriesHits = seriesCatalog.filter((s) =>
		new RegExp(`^KX${escapeRegExp(sym)}A?$`, "i").test(s.ticker),
	);
	const byEvent = new Map<string, KalshiMarketRow[]>();
	let softFailed = false;
	let gotUsablePayload = seriesHits.length === 0;

	for (const series of seriesHits) {
		const { markets: rawMarkets, softFailed: pageSoftFailed } =
			await loadOpenKalshiMarketsForSeries(series.ticker, logger);
		if (pageSoftFailed) {
			softFailed = true;
			if (rawMarkets.length === 0) continue;
		}
		if (rawMarkets.length === 0) continue;
		gotUsablePayload = true;

		for (const m of rawMarkets) {
			const ticker = asString(m.ticker);
			const title = asString(m.title) ?? "";
			if (!ticker || !title) continue;
			if (isJunkTitle(title)) continue;

			const yesBid = parseYesProbabilityPercent(m.yes_bid_dollars ?? m.yes_bid);
			const yesAsk = parseYesProbabilityPercent(m.yes_ask_dollars ?? m.yes_ask);
			const probabilityPercent =
				yesBid !== null && yesAsk !== null
					? Math.round(((yesBid + yesAsk) / 2) * 10) / 10
					: (parseYesProbabilityPercent(m.last_price_dollars) ?? yesBid ?? yesAsk);

			const eventTicker = asString(m.event_ticker) ?? ticker;
			const floorStrike = asNumber(m.floor_strike);
			const strikeValue =
				Number.isFinite(floorStrike) && floorStrike !== 0 ? floorStrike : extractStrikeValue(title);

			const row: KalshiMarketRow = {
				ticker,
				title,
				eventTicker,
				probabilityPercent,
				volume: asNumber(m.volume),
				closesAt: asString(m.close_time) ?? asString(m.expected_expiration_time),
				strikeValue,
			};
			const list = byEvent.get(eventTicker) ?? [];
			list.push(row);
			byEvent.set(eventTicker, list);
		}
	}

	const out: DiscoveredPredictionEvent[] = [];
	for (const [eventTicker, markets] of byEvent) {
		const title = markets[0]?.title ?? eventTicker;
		const evidence = findIdentityEvidence(
			title,
			markets.map((m) => m.title),
			identity,
		) ?? {
			where: "title" as const,
			alias: eventTicker,
		};
		const resolved = resolveMatchKind(title, evidence) ?? "kpi";
		const matchKind = resolved === "direct_price" ? "direct_price" : "kpi";

		let outcomes: DiscoveredPredictionOutcome[] = markets.map((m, index) => ({
			venueContractId: m.ticker,
			label: markets.length === 1 ? "Yes" : m.title,
			probabilityPercent: m.probabilityPercent,
			sortOrder: index,
			strikeValue: m.strikeValue,
			volume: m.volume,
		}));

		const detected = detectPredictionMarketShape({ outcomes });
		if (detected.shape === "binary") {
			outcomes = ensureBinaryOutcomes(outcomes, eventTicker);
		}

		const validOutcomes = outcomes.filter((o) => o.probabilityPercent != null);
		if (validOutcomes.length === 0) continue;

		const closesAt =
			markets
				.map((m) => m.closesAt)
				.filter((d): d is string => Boolean(d))
				.sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;

		out.push({
			venue: "kalshi",
			venueEventId: eventTicker,
			seriesId: seriesHits.find((s) => eventTicker.startsWith(s.ticker))?.ticker ?? null,
			title:
				markets.length === 1
					? title
					: (seriesHits.find((s) => eventTicker.startsWith(s.ticker))?.title ?? title),
			url: kalshiMarketUrl(markets[0]?.ticker ?? eventTicker, eventTicker),
			matchKind,
			shape: detected.shape,
			shapeValidated: detected.validated,
			volume: markets.reduce((s, m) => s + m.volume, 0),
			closesAt,
			confidence: 90,
			evidence,
			outcomes: validOutcomes,
			highlightAlias: evidence.alias,
		});
	}

	logger.info("Kalshi discovery complete", {
		symbol: identity.symbol,
		seriesCount: seriesHits.length,
		candidateCount: out.length,
		softFailed: softFailed && !gotUsablePayload,
	});
	return { events: out, softFailed: softFailed && !gotUsablePayload };
}

/** Discover Polymarket + Kalshi event candidates for one asset identity. */
export async function discoverMarketsForAsset(options: {
	identity: AssetIdentity;
	logger: Logger;
	kalshiSeriesCatalog?: KalshiSeriesCatalog;
}): Promise<VenueDiscoveryResult> {
	const { identity, logger } = options;
	const catalog = options.kalshiSeriesCatalog ?? (await loadKalshiCompanySeries(logger));

	const [poly, kalshi] = await Promise.all([
		discoverPolymarket(identity, logger),
		discoverKalshi(identity, catalog.series, logger),
	]);
	return {
		events: [...poly.events, ...kalshi.events],
		softFailed: catalog.softFailed || poly.softFailed || kalshi.softFailed,
	};
}

export { loadKalshiCompanySeries };
