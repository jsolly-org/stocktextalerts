import type { Logger } from "../logging";
import { isRecord } from "../types";
import { kalshiFetch } from "../vendors/kalshi";
import { polymarketFetch } from "../vendors/polymarket";
import { polymarketSearchQueries } from "./aliases";
import { findIdentityEvidence, isJunkTitle, resolveMatchKind } from "./match";
import type { AssetIdentity, DiscoveredPredictionMarket } from "./types";
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
	markets: DiscoveredPredictionMarket[];
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
};

function flattenPolymarketEvent(event: Record<string, unknown>): {
	title: string;
	eventSlug: string | null;
	markets: PolyMarketRow[];
} {
	const title = asString(event.title) ?? "";
	const eventSlug = asString(event.slug);
	const marketsRaw = Array.isArray(event.markets) ? event.markets : [];
	const markets: PolyMarketRow[] = [];
	for (const m of marketsRaw) {
		if (!isRecord(m)) continue;
		const conditionId = asString(m.conditionId) ?? asString(m.condition_id);
		const slug = asString(m.slug) ?? eventSlug;
		if (!conditionId || !slug) continue;
		markets.push({
			conditionId,
			question: asString(m.question) ?? title,
			slug,
			groupItemTitle: asString(m.groupItemTitle),
			closed: m.closed === true,
			active: m.active !== false,
			volume: asNumber(m.volumeNum ?? m.volume),
			endDate: asString(m.endDate) ?? asString(event.endDate),
			probabilityPercent: parsePolymarketYesPrice(m),
		});
	}
	return { title, eventSlug, markets };
}

async function discoverPolymarket(
	identity: AssetIdentity,
	logger: Logger,
): Promise<VenueDiscoveryResult> {
	const out: DiscoveredPredictionMarket[] = [];
	const seen = new Set<string>();
	let gotUsablePayload = false;
	let softFailed = false;

	for (const q of polymarketSearchQueries(identity)) {
		const payload = await polymarketFetch(
			"/public-search",
			{
				q,
				events_status: "active",
				limit_per_type: "10",
				keep_closed_markets: "0",
			},
			`pm-discover:${identity.symbol}`,
			{ optional: true },
		);
		if (payload === null) {
			softFailed = true;
			continue;
		}
		if (!isRecord(payload) || !Array.isArray(payload.events)) continue;
		gotUsablePayload = true;

		for (const event of payload.events) {
			if (!isRecord(event)) continue;
			const flat = flattenPolymarketEvent(event);
			if (isJunkTitle(flat.title)) continue;

			const outcomeLabels = flat.markets
				.map((m) => m.groupItemTitle)
				.filter((x): x is string => Boolean(x));

			// Event-level identity (title) OR per-market outcome leg
			const eventEvidence = findIdentityEvidence(flat.title, outcomeLabels, identity);

			for (const market of flat.markets) {
				if (seen.has(market.conditionId)) continue;
				if (market.closed || !market.active) continue;

				const marketEvidence =
					findIdentityEvidence(
						market.question,
						market.groupItemTitle ? [market.groupItemTitle] : [],
						identity,
					) ?? eventEvidence;

				if (!marketEvidence) continue;

				// For outcome-leg hits, only keep the matching leg's contract
				if (marketEvidence.where === "outcome" && market.groupItemTitle) {
					const legOk = findIdentityEvidence("", [market.groupItemTitle], identity) !== null;
					if (!legOk) continue;
				}

				const matchKind = resolveMatchKind(market.question || flat.title, marketEvidence);
				if (!matchKind) continue;

				seen.add(market.conditionId);
				out.push({
					venue: "polymarket",
					venueMarketId: market.conditionId,
					eventId: flat.eventSlug,
					seriesId: null,
					label: market.groupItemTitle
						? `${flat.title}: ${market.groupItemTitle}`
						: flat.title || market.question,
					question: market.question || flat.title,
					url: polymarketMarketUrl(market.slug, flat.eventSlug),
					matchKind,
					probabilityPercent: market.probabilityPercent,
					volume: market.volume,
					closesAt: market.endDate,
					confidence: marketEvidence.where === "title" ? 80 : 70,
					evidence: marketEvidence,
				});
			}
		}
	}

	logger.info("Polymarket discovery complete", {
		symbol: identity.symbol,
		candidateCount: out.length,
		softFailed: softFailed && !gotUsablePayload,
	});
	// Soft-fail only when every query failed transport — a single usable empty
	// search is definitive "none found" for that identity.
	return { markets: out, softFailed: softFailed && !gotUsablePayload };
}

export type KalshiSeriesCatalog = {
	series: Array<{ ticker: string; title: string }>;
	softFailed: boolean;
};

async function loadKalshiCompanySeries(logger: Logger): Promise<KalshiSeriesCatalog> {
	const all: Array<{ ticker: string; title: string }> = [];
	let cursor = "";
	for (let page = 0; page < 20; page++) {
		const params: Record<string, string> = { limit: "200", category: "Companies" };
		if (cursor) params.cursor = cursor;
		const payload = await kalshiFetch("/series", params, "pm-kalshi-series", {
			optional: true,
		});
		if (payload === null) {
			logger.warn("Kalshi Companies series soft-failed", { page, loaded: all.length });
			// First page null = no catalog; mid-page null with partial data is still
			// soft-fail so we don't stamp "none" from an incomplete Companies crawl.
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
	}
	logger.info("Kalshi Companies series loaded", { count: all.length });
	return { series: all, softFailed: false };
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
	const out: DiscoveredPredictionMarket[] = [];
	let softFailed = false;
	let gotUsablePayload = seriesHits.length === 0; // no series = definitive miss

	for (const series of seriesHits) {
		const payload = await kalshiFetch(
			"/markets",
			{ limit: "30", status: "open", series_ticker: series.ticker },
			`pm-kalshi-markets:${series.ticker}`,
			{ optional: true },
		);
		if (payload === null) {
			softFailed = true;
			continue;
		}
		if (!isRecord(payload) || !Array.isArray(payload.markets)) continue;
		gotUsablePayload = true;

		for (const m of payload.markets) {
			if (!isRecord(m)) continue;
			const ticker = asString(m.ticker);
			const title = asString(m.title) ?? "";
			if (!ticker || !title) continue;
			if (isJunkTitle(title)) continue;

			const evidence = findIdentityEvidence(title, [], identity) ?? {
				where: "title" as const,
				alias: series.ticker,
			};
			const resolved = resolveMatchKind(title, evidence) ?? "kpi";
			// Kalshi Companies series are price or KPI fundamentals — never company_subject.
			const matchKind = resolved === "direct_price" ? "direct_price" : "kpi";
			const yesBid = parseYesProbabilityPercent(m.yes_bid_dollars ?? m.yes_bid);
			const yesAsk = parseYesProbabilityPercent(m.yes_ask_dollars ?? m.yes_ask);
			const probabilityPercent =
				yesBid !== null && yesAsk !== null
					? Math.round(((yesBid + yesAsk) / 2) * 10) / 10
					: (parseYesProbabilityPercent(m.last_price_dollars) ?? yesBid ?? yesAsk);

			const eventTicker = asString(m.event_ticker);
			out.push({
				venue: "kalshi",
				venueMarketId: ticker,
				eventId: eventTicker,
				seriesId: series.ticker,
				label: title,
				question: title,
				url: kalshiMarketUrl(ticker, eventTicker),
				matchKind,
				probabilityPercent,
				volume: asNumber(m.volume),
				closesAt: asString(m.close_time) ?? asString(m.expected_expiration_time),
				confidence: 90,
				evidence,
			});
		}
	}

	logger.info("Kalshi discovery complete", {
		symbol: identity.symbol,
		seriesCount: seriesHits.length,
		candidateCount: out.length,
		softFailed: softFailed && !gotUsablePayload,
	});
	return { markets: out, softFailed: softFailed && !gotUsablePayload };
}

/** Discover Polymarket + Kalshi candidates for one asset identity. */
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
		markets: [...poly.markets, ...kalshi.markets],
		softFailed: catalog.softFailed || poly.softFailed || kalshi.softFailed,
	};
}

export { loadKalshiCompanySeries };
