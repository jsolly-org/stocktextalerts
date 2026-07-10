import type { DiscoveredPredictionEvent } from "./types";

/** Cap persisted discovery candidates per symbol. */
const DISCOVERY_PERSIST_CAP = 20;

/**
 * Prefer higher-confidence / higher-volume events for persistence.
 * Digest selection (soonest deadline + ongoing lane) happens at read time.
 */
export function rankDiscoveredEvents(
	candidates: readonly DiscoveredPredictionEvent[],
	limit = DISCOVERY_PERSIST_CAP,
): DiscoveredPredictionEvent[] {
	return [...candidates]
		.sort((a, b) => {
			if (b.confidence !== a.confidence) return b.confidence - a.confidence;
			return b.volume - a.volume;
		})
		.slice(0, limit);
}

/**
 * Round-robin across symbols (legacy helper retained for tests / soft migration).
 * Prefer {@link selectAssetEventCards} for digest selection.
 */
export function selectDigestAssetMarkets<T extends { symbol: string }>(
	bySymbol: ReadonlyMap<string, readonly T[]>,
	options: { perAsset?: number; globalCap?: number } = {},
): T[] {
	const perAsset = options.perAsset ?? 2;
	const globalCap = options.globalCap ?? Number.POSITIVE_INFINITY;
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
