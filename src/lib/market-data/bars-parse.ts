import { US_MARKET_TIMEZONE } from "../constants";
import type { DailyOHLCVBar, IntradayBarsResult, IntradayCandle } from "../types";

function toFiniteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getBarResults(payload: unknown): Record<string, unknown>[] | null {
	if (typeof payload !== "object" || payload === null) return null;

	const results = (payload as Record<string, unknown>).results;
	if (!Array.isArray(results)) return null;

	return results.filter(
		(bar): bar is Record<string, unknown> => typeof bar === "object" && bar !== null,
	);
}

export function extractClosesFromBars(payload: unknown): number[] | null {
	const results = getBarResults(payload);
	if (!results) return null;

	const closes: number[] = [];
	for (const bar of results) {
		const c = toFiniteNumber(bar.c);
		if (c !== null) closes.push(c);
	}
	return closes.length > 0 ? closes : null;
}

export function extractClosesAndTimestampsFromBars(payload: unknown): IntradayBarsResult | null {
	const results = getBarResults(payload);
	if (!results) return null;

	const closes: number[] = [];
	const timestamps: (number | null)[] = [];
	let startTimestamp: number | null = null;
	let endTimestamp: number | null = null;
	let firstValidTimestampIndex = -1;
	let lastValidTimestampIndex = -1;

	for (const bar of results) {
		const c = toFiniteNumber(bar.c);
		if (c === null) continue;
		const ts = toFiniteNumber(bar.t);
		closes.push(c);
		if (ts !== null) {
			timestamps.push(ts);
			if (startTimestamp === null) {
				startTimestamp = ts;
				firstValidTimestampIndex = closes.length - 1;
			}
			endTimestamp = ts;
			lastValidTimestampIndex = closes.length - 1;
		} else {
			timestamps.push(null);
		}
	}

	if (closes.length === 0) return null;

	if (
		firstValidTimestampIndex >= 0 &&
		lastValidTimestampIndex >= firstValidTimestampIndex &&
		lastValidTimestampIndex < closes.length - 1 &&
		startTimestamp !== null &&
		endTimestamp !== null
	) {
		const validCount = lastValidTimestampIndex - firstValidTimestampIndex + 1;
		if (validCount >= 2) {
			const avgInterval = (endTimestamp - startTimestamp) / (validCount - 1);
			const trailingCount = closes.length - 1 - lastValidTimestampIndex;
			endTimestamp = endTimestamp + trailingCount * avgInterval;
		}
	}

	return {
		closes,
		timestamps: startTimestamp !== null ? timestamps : null,
		startTimestamp,
		endTimestamp,
		candles: extractIntradayOHLCV(payload),
	};
}

export function extractIntradayOHLCV(payload: unknown): IntradayCandle[] | null {
	const results = getBarResults(payload);
	if (!results) return null;

	const candles: IntradayCandle[] = [];
	for (const bar of results) {
		const o = toFiniteNumber(bar.o);
		const h = toFiniteNumber(bar.h);
		const l = toFiniteNumber(bar.l);
		const c = toFiniteNumber(bar.c);
		const t = toFiniteNumber(bar.t);
		if (o !== null && h !== null && l !== null && c !== null && t !== null) {
			candles.push({ o, h, l, c, t });
		}
	}
	return candles.length > 0 ? candles : null;
}

function barTimestampToTradingDate(timestampMs: number): string | undefined {
	const date = new Date(timestampMs).toLocaleDateString("en-CA", {
		timeZone: US_MARKET_TIMEZONE,
	});
	return date || undefined;
}

export function extractOHLCVFromBars(payload: unknown): DailyOHLCVBar[] | null {
	const results = getBarResults(payload);
	if (!results) return null;

	const bars: DailyOHLCVBar[] = [];
	for (const bar of results) {
		const o = toFiniteNumber(bar.o);
		const h = toFiniteNumber(bar.h);
		const l = toFiniteNumber(bar.l);
		const c = toFiniteNumber(bar.c);
		const v = toFiniteNumber(bar.v);
		if (o !== null && h !== null && l !== null && c !== null && v !== null) {
			const t = toFiniteNumber(bar.t);
			const tradingDate = t !== null ? barTimestampToTradingDate(t) : undefined;
			bars.push({
				open: o,
				high: h,
				low: l,
				close: c,
				volume: v,
				...(tradingDate ? { tradingDate } : {}),
			});
		}
	}
	return bars.length > 0 ? bars : null;
}
