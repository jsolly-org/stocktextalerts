import type { ProviderResult } from "../massive/reference";
import { finnhubFetch } from "./client";

interface EarningsEvent {
	ticker: string;
	date: string; // YYYY-MM-DD
	time: string | null; // UTC 24h format
	epsEstimate: number | null;
	revenueEstimate: number | null;
}

async function fetchFinnhubEarnings(
	from: string,
	to: string,
): Promise<ProviderResult<EarningsEvent>> {
	const toNumberOrNull = (value: unknown): number | null =>
		typeof value === "number" && Number.isFinite(value) ? value : null;
	const toStringOrNull = (value: unknown): string | null =>
		typeof value === "string" && value.trim() !== "" ? value : null;

	const data = await finnhubFetch("/calendar/earnings", { from, to }, "earnings-calendar");
	if (data === null) return { data: [], failed: true };
	if (typeof data !== "object") return { data: [], failed: false };

	const raw = (data as Record<string, unknown>).earningsCalendar;
	if (!Array.isArray(raw)) return { data: [], failed: false };

	const events: EarningsEvent[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		if (typeof item !== "object" || item === null) continue;
		const row = item as Record<string, unknown>;
		const ticker = toStringOrNull(row.symbol);
		const dateRaw = toStringOrNull(row.date);
		if (!ticker || !dateRaw) continue;

		const date = dateRaw.slice(0, 10);
		const key = `${ticker}|${date}`;
		if (seen.has(key)) continue;
		seen.add(key);

		events.push({
			ticker,
			date,
			time: toStringOrNull(row.hour),
			epsEstimate: toNumberOrNull(row.epsEstimate),
			revenueEstimate: toNumberOrNull(row.revenueEstimate),
		});
	}

	return { data: events, failed: false };
}

// Short-TTL memo of the market-wide earnings calendar, keyed by date range.
// The calendar is symbol-independent, but new-symbol warmup (vendor-backfill)
// fetches the SAME week's full calendar once per symbol — processed serially in
// one SQS batch, a bulk add fans these into N identical Finnhub calls and
// exhausts the rate limit (the 2026-06-22 429 burst: 649 calls for a handful of
// week-ranges). Memoizing successful fetches collapses a burst to one call per
// week-range; a 5-min TTL keeps the weekly asset-maintenance run fresh.
const EARNINGS_CACHE_TTL_MS = 5 * 60_000;
const earningsCalendarCache = new Map<
	string,
	{ result: ProviderResult<EarningsEvent>; expiresAt: number }
>();

/** Test-only: clear the earnings-calendar memo so module state doesn't leak across tests. */
export function resetEarningsCacheForTests(): void {
	earningsCalendarCache.clear();
}

/**
 * Fetch all earnings events for a date range (market-wide).
 */
export async function fetchEarnings(
	from: string,
	to: string,
): Promise<ProviderResult<EarningsEvent>> {
	const cacheKey = `${from}|${to}`;
	const cached = earningsCalendarCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.result;
	}

	// Use Finnhub as the canonical earnings feed to avoid partner entitlement issues on Massive.
	const result = await fetchFinnhubEarnings(from, to);

	// Cache successes only — a 429/transient failure must not become sticky and
	// block the retry that the next warmup (or the maintenance run) will attempt.
	if (!result.failed) {
		earningsCalendarCache.set(cacheKey, {
			result,
			expiresAt: Date.now() + EARNINGS_CACHE_TTL_MS,
		});
	}
	return result;
}
