import { DateTime } from "luxon";
import {
	US_MARKET_OPEN_EASTERN_MINUTES,
	US_MARKET_TIMEZONE,
} from "../../constants";
import { getChangeColor } from "../asset-formatting";
import { type SparklineTimeLabel, toSvgSparklineImg } from "../svg-sparkline";

/** Format minutes-from-midnight as compact time for sparkline axis labels.
 *  12h: "9:30a", "2p", "12:45p"   24h: "9:30", "14:00", "12:45" */
export function formatCompactTime(totalMinutes: number, is24: boolean): string {
	const h24 = Math.floor(totalMinutes / 60);
	const m = totalMinutes % 60;
	if (is24) {
		return `${h24}:${String(m).padStart(2, "0")}`;
	}
	const h12 = h24 === 0 ? 12 : h24 > 12 ? h24 - 12 : h24;
	const period = h24 >= 12 ? "p" : "a";
	return m === 0
		? `${h12}${period}`
		: `${h12}:${String(m).padStart(2, "0")}${period}`;
}

/** Market-open timestamp (ms) for the calendar day of the given timestamp, in ET. */
export function getMarketOpenTimestampMs(referenceMs: number): number {
	const marketOpenHour = Math.floor(US_MARKET_OPEN_EASTERN_MINUTES / 60);
	const marketOpenMinute = US_MARKET_OPEN_EASTERN_MINUTES % 60;
	return DateTime.fromMillis(referenceMs)
		.setZone(US_MARKET_TIMEZONE)
		.startOf("day")
		.set({
			hour: marketOpenHour,
			minute: marketOpenMinute,
			second: 0,
			millisecond: 0,
		})
		.toMillis();
}

function getMinutesFromMidnightET(ms: number): number {
	const dt = DateTime.fromMillis(ms).setZone(US_MARKET_TIMEZONE);
	return dt.hour * 60 + dt.minute;
}

/** Build time-axis labels for an intraday sparkline anchored to market open (9:30 ET).
 *  Returns empty when endTimestampMs is missing. Axis spans market-open to end (not first-bar to end). */
export function buildIntradayTimeLabels(
	is24: boolean,
	endTimestampMs: number | null | undefined,
): SparklineTimeLabel[] {
	if (endTimestampMs == null) return [];

	const marketOpenMs = getMarketOpenTimestampMs(endTimestampMs);
	const startMinutes = getMinutesFromMidnightET(marketOpenMs);
	const endMinutes = getMinutesFromMidnightET(endTimestampMs);

	const totalSpan = endMinutes - startMinutes;
	if (totalSpan <= 0) return [];

	const labels: SparklineTimeLabel[] = [
		{ position: 0, label: formatCompactTime(startMinutes, is24) },
	];

	// Add hourly ticks between start and end (if room)
	if (totalSpan > 60) {
		const firstHour = Math.ceil(startMinutes / 60) * 60;
		for (let min = firstHour; min < endMinutes; min += 60) {
			const pos = (min - startMinutes) / totalSpan;
			// Suppress ticks within 15% of start/end to avoid crowding the edge labels
			// (e.g., a 10:00 AM tick at pos≈0.08 would overlap "9:30a" for a full session).
			if (pos > 0.15 && pos < 0.85) {
				labels.push({ position: pos, label: formatCompactTime(min, is24) });
			}
		}
	}

	labels.push({ position: 1, label: formatCompactTime(endMinutes, is24) });
	return labels;
}

/** Render an intraday sparkline as an inline SVG <img> string. Returns empty
 *  string if data is missing or invalid. Callers wrap the returned string in
 *  their own themed container. */
export function renderIntradaySparklineImg(options: {
	intradayCloses: number[] | null;
	is24: boolean;
	endTimestampMs?: number | null;
	timestamps?: (number | null)[] | null;
}): string {
	const { intradayCloses, is24, endTimestampMs, timestamps } = options;
	if (!intradayCloses || intradayCloses.length < 2) return "";
	if (intradayCloses.some((v) => !Number.isFinite(v))) return "";

	const openPrice = intradayCloses[0];
	const lastPrice = intradayCloses[intradayCloses.length - 1];
	const changePercent =
		openPrice === 0 ? 0 : ((lastPrice - openPrice) / openPrice) * 100;
	const color = getChangeColor(changePercent);
	const timeLabels = buildIntradayTimeLabels(is24, endTimestampMs);
	const marketOpenMs =
		endTimestampMs != null ? getMarketOpenTimestampMs(endTimestampMs) : null;
	const timeAxis =
		timestamps &&
		timestamps.length === intradayCloses.length &&
		marketOpenMs != null &&
		endTimestampMs != null
			? {
					timestamps,
					startTimestamp: marketOpenMs,
					endTimestamp: endTimestampMs,
				}
			: undefined;

	return toSvgSparklineImg(
		intradayCloses,
		color,
		200,
		40,
		"Intraday price chart since market open",
		timeLabels,
		timeAxis,
	);
}
