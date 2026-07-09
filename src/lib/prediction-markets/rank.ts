import type { DiscoveredPredictionMarket, PredictionMatchKind } from "./types";

const KIND_RANK: Record<PredictionMatchKind, number> = {
	direct_price: 300,
	kpi: 200,
	company_subject: 100,
};

function daysToClose(closesAt: string | null): number {
	if (!closesAt) return 365;
	const days = (Date.parse(closesAt) - Date.now()) / 86_400_000;
	return Number.isFinite(days) ? Math.max(0, days) : 365;
}

function scoreCandidate(c: DiscoveredPredictionMarket): number {
	const kind = KIND_RANK[c.matchKind];
	const expiryBonus =
		c.matchKind === "direct_price" ? Math.max(0, 200 - daysToClose(c.closesAt)) : 0;
	const volumeBonus = Math.min(40, Math.log10(c.volume + 10) * 10);
	return kind + expiryBonus + volumeBonus + c.confidence;
}

/**
 * Prefer 1 Poly price + 1 Kalshi KPI when both exist; otherwise fill with next-best
 * company_subject. Never two strikes from the same Kalshi series. Cap at `limit`.
 */
export function rankDiscoveredMarkets(
	candidates: readonly DiscoveredPredictionMarket[],
	limit = 2,
): DiscoveredPredictionMarket[] {
	const scored = [...candidates]
		.map((c) => ({ c, score: scoreCandidate(c) }))
		.sort((a, b) => b.score - a.score);

	const picked: DiscoveredPredictionMarket[] = [];
	const usedSeries = new Set<string>();
	let hasPolyPrice = false;
	let hasKalshiKpi = false;

	const tryPick = (c: DiscoveredPredictionMarket, require?: "poly_price" | "kalshi_kpi") => {
		if (picked.length >= limit) return false;
		if (require === "poly_price" && !(c.venue === "polymarket" && c.matchKind === "direct_price")) {
			return false;
		}
		if (require === "kalshi_kpi" && !(c.venue === "kalshi" && c.matchKind === "kpi")) {
			return false;
		}
		if (c.seriesId && usedSeries.has(c.seriesId)) return false;
		if (picked.some((p) => p.venue === c.venue && p.venueMarketId === c.venueMarketId)) {
			return false;
		}
		picked.push(c);
		if (c.seriesId) usedSeries.add(c.seriesId);
		if (c.venue === "polymarket" && c.matchKind === "direct_price") hasPolyPrice = true;
		if (c.venue === "kalshi" && c.matchKind === "kpi") hasKalshiKpi = true;
		return true;
	};

	// Pass 1: preferred complementary pair
	for (const { c } of scored) {
		if (!hasPolyPrice) tryPick(c, "poly_price");
		if (!hasKalshiKpi) tryPick(c, "kalshi_kpi");
		if (picked.length >= limit) break;
	}

	// Pass 2: fill remaining slots by score (still one per Kalshi series)
	for (const { c } of scored) {
		if (picked.length >= limit) break;
		tryPick(c);
	}

	return picked;
}

/**
 * Round-robin across symbols so one ticker cannot dominate the digest strip.
 * `perAsset` max rows per symbol; `globalCap` max total.
 */
export function selectDigestAssetMarkets<T extends { symbol: string }>(
	bySymbol: ReadonlyMap<string, readonly T[]>,
	options: { perAsset?: number; globalCap?: number } = {},
): T[] {
	const perAsset = options.perAsset ?? 2;
	const globalCap = options.globalCap ?? 6;
	const symbols = [...bySymbol.keys()].sort();
	const queues = new Map(
		symbols.map((sym) => [sym, [...(bySymbol.get(sym) ?? [])].slice(0, perAsset)]),
	);
	const out: T[] = [];
	let progressed = true;
	while (out.length < globalCap && progressed) {
		progressed = false;
		for (const sym of symbols) {
			if (out.length >= globalCap) break;
			const q = queues.get(sym);
			if (!q || q.length === 0) continue;
			const next = q.shift();
			if (next) {
				out.push(next);
				progressed = true;
			}
		}
	}
	return out;
}
