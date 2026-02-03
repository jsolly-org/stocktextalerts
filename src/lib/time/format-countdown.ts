import { DateTime, Duration } from "luxon";

export function formatTimeRemaining(secondsUntil: number): string {
	const safeSeconds = Math.max(secondsUntil, 0);
	const duration = Duration.fromObject({ seconds: safeSeconds });
	if (safeSeconds < 60) {
		return duration.toHuman();
	}

	const { hours, minutes } = duration
		.shiftTo("hours", "minutes")
		.normalize()
		.toObject();
	const safeHours = Math.trunc(hours ?? 0);
	const safeMinutes = Math.trunc(minutes ?? 0);

	if (safeHours > 0 && safeMinutes > 0) {
		return Duration.fromObject({
			hours: safeHours,
			minutes: safeMinutes,
		}).toHuman({
			listStyle: "long",
		});
	}

	if (safeHours > 0) {
		return Duration.fromObject({ hours: safeHours }).toHuman();
	}

	return Duration.fromObject({ minutes: safeMinutes }).toHuman();
}

export function formatCountdownWithSeconds(secondsUntil: number): string {
	const safeSeconds = Math.max(secondsUntil, 0);
	const duration = Duration.fromObject({ seconds: safeSeconds });
	const {
		hours = 0,
		minutes = 0,
		seconds = 0,
	} = duration.shiftTo("hours", "minutes", "seconds").normalize().toObject();
	const h = Math.trunc(hours);
	const m = Math.trunc(minutes);
	const s = Math.trunc(seconds);
	const parts: string[] = [];
	if (h > 0) parts.push(`${h} ${h === 1 ? "hour" : "hours"}`);
	if (m > 0) parts.push(`${m} ${m === 1 ? "minute" : "minutes"}`);
	parts.push(`${s} ${s === 1 ? "second" : "seconds"}`);
	return parts.join(", ");
}

export function formatArrivalTime(
	secondsUntil: number,
	timezone: string,
): string {
	const now = DateTime.now().setZone(timezone);
	const arrival = now.plus({ seconds: secondsUntil });

	if (!arrival.isValid || !now.isValid) {
		return "";
	}

	const diffDays = Math.floor(
		arrival.startOf("day").diff(now.startOf("day"), "days").days,
	);

	let dayLabel = "";
	if (diffDays === 0) {
		dayLabel = "today";
	} else if (diffDays === 1) {
		dayLabel = "tomorrow";
	} else if (diffDays === 2) {
		dayLabel = "the day after tomorrow";
	} else {
		dayLabel = arrival.toFormat("cccc").toLowerCase();
	}

	const timeStr = arrival.toLocaleString(DateTime.TIME_SIMPLE);

	return `, ${dayLabel} at ${timeStr}`;
}

export function formatTimezone(secondsUntil: number, timezone: string): string {
	const arrival = DateTime.now()
		.setZone(timezone)
		.plus({ seconds: secondsUntil });

	if (!arrival.isValid) {
		return "";
	}

	return arrival.toFormat("ZZZZ");
}
