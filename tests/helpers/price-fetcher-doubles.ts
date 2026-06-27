import {
	downsampleEvenly,
	type SparklineMap,
	type SparklineWindow,
	toSparkline,
} from "../../src/lib/messaging/sparkline";
import type { MarketSession } from "../../src/lib/providers/price-fetcher";

function isFinitePositive(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function appendCurrentPriceIfStale(
	values: number[],
	symbol: string,
	currentPriceMap: Map<string, number | null | undefined> | undefined,
): number[] {
	if (!currentPriceMap) return values;
	const rawCurrent = currentPriceMap.get(symbol);
	if (!isFinitePositive(rawCurrent)) return values;
	const last = values[values.length - 1];
	if (last === undefined || last === rawCurrent) return values;
	return [...values, rawCurrent];
}

export async function testGetCurrentMarketSession(): Promise<MarketSession> {
	return "regular";
}

export async function testFetchSparklines(symbols: string[]): Promise<SparklineMap> {
	const result: SparklineMap = new Map();
	const stubValues = [1, 2, 3, 5, 7, 5, 3];
	for (const s of symbols) {
		result.set(s, { values: stubValues, ascii: "▁▂▃▅▇▅▃", window: "7-trading-days" });
	}
	return result;
}

export async function testFetchIntradaySparklines(
	symbols: string[],
	prevCloseMap: Map<string, number | null | undefined>,
	currentPriceMap?: Map<string, number | null | undefined>,
): Promise<SparklineMap> {
	const result: SparklineMap = new Map();
	const stubBars = [100, 100.5, 101.2, 100.8, 101.5, 102.1, 101.9, 102.4];
	for (const s of symbols) {
		const rawPrev = prevCloseMap.get(s);
		const prevClose = isFinitePositive(rawPrev) ? rawPrev : null;
		let values = prevClose !== null ? [prevClose, ...stubBars] : stubBars;
		values = appendCurrentPriceIfStale(values, s, currentPriceMap);
		const window: SparklineWindow =
			prevClose !== null ? "intraday-since-prev-close" : "intraday-since-open";
		result.set(s, {
			values,
			ascii: toSparkline(downsampleEvenly(values)),
			window,
		});
	}
	return result;
}
