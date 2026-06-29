import { US_MARKET_TIMEZONE } from "../constants";
import type { DailyOHLCVBar, IntradayBarsResult, IntradayCandle } from "../types";

export function extractClosesFromBars(payload: unknown): number[] | null {
	if (typeof payload !== "object" || payload === null) return null;

	const results = (payload as Record<string, unknown>).results;
	if (!Array.isArray(results)) return null;

	const closes: number[] = [];
	for (const bar of results) {
		if (typeof bar !== "object" || bar === null) continue;
		const c = (bar as Record<string, unknown>).c;
		if (typeof c === "number" && Number.isFinite(c)) {
			closes.push(c);
		}
	}
	return closes.length > 0 ? closes : null;
}

export function extractClosesAndTimestampsFromBars(payload: unknown): IntradayBarsResult | null {
	if (typeof payload !== "object" || payload === null) return null;

	const results = (payload as Record<string, unknown>).results;
	if (!Array.isArray(results)) return null;

	const closes: number[] = [];
	const timestamps: (number | null)[] = [];
	let startTimestamp: number | null = null;
	let endTimestamp: number | null = null;
	let firstValidTimestampIndex = -1;
	let lastValidTimestampIndex = -1;

	for (const bar of results) {
		if (typeof bar !== "object" || bar === null) continue;
		const rec = bar as Record<string, unknown>;
		const c = rec.c;
		const t = rec.t;
		if (typeof c !== "number" || !Number.isFinite(c)) continue;
		const ts = typeof t === "number" && Number.isFinite(t) ? t : null;
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
	if (typeof payload !== "object" || payload === null) return null;

	const results = (payload as Record<string, unknown>).results;
	if (!Array.isArray(results)) return null;

	const candles: IntradayCandle[] = [];
	for (const bar of results) {
		if (typeof bar !== "object" || bar === null) continue;
		const rec = bar as Record<string, unknown>;
		const o = rec.o;
		const h = rec.h;
		const l = rec.l;
		const c = rec.c;
		const t = rec.t;
		if (
			typeof o === "number" &&
			Number.isFinite(o) &&
			typeof h === "number" &&
			Number.isFinite(h) &&
			typeof l === "number" &&
			Number.isFinite(l) &&
			typeof c === "number" &&
			Number.isFinite(c) &&
			typeof t === "number" &&
			Number.isFinite(t)
		) {
			candles.push({ o, h, l, c, t });
		}
	}
	return candles.length > 0 ? candles : null;
}

function barTimestampToTradingDate(timestampMs: number): string | undefined {
	if (!Number.isFinite(timestampMs)) return undefined;
	const date = new Date(timestampMs).toLocaleDateString("en-CA", {
		timeZone: US_MARKET_TIMEZONE,
	});
	return date || undefined;
}

export function extractOHLCVFromBars(payload: unknown): DailyOHLCVBar[] | null {
	if (typeof payload !== "object" || payload === null) return null;

	const results = (payload as Record<string, unknown>).results;
	if (!Array.isArray(results)) return null;

	const bars: DailyOHLCVBar[] = [];
	for (const bar of results) {
		if (typeof bar !== "object" || bar === null) continue;
		const rec = bar as Record<string, unknown>;
		const o = rec.o;
		const h = rec.h;
		const l = rec.l;
		const c = rec.c;
		const v = rec.v;
		const t = rec.t;
		if (
			typeof o === "number" &&
			Number.isFinite(o) &&
			typeof h === "number" &&
			Number.isFinite(h) &&
			typeof l === "number" &&
			Number.isFinite(l) &&
			typeof c === "number" &&
			Number.isFinite(c) &&
			typeof v === "number" &&
			Number.isFinite(v)
		) {
			const tradingDate = typeof t === "number" ? barTimestampToTradingDate(t) : undefined;
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
