import { DateTime } from "luxon";

export function formatChartAsOfLabel(
	isoTimestamp: string,
	timezone: string,
	use24HourTime: boolean,
): string {
	const dt = DateTime.fromISO(isoTimestamp, { zone: "utc" }).setZone(timezone);
	if (!dt.isValid) return "";
	const formatted = dt.toLocaleString({
		hour: "numeric",
		minute: "2-digit",
		hour12: !use24HourTime,
		timeZoneName: "short",
	});
	return `chart as of ${formatted}`;
}
