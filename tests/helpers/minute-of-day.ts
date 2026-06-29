import { asMinuteOfDay, type MinuteOfDay } from "../../src/lib/types";

export function minuteOfDay(n: number): MinuteOfDay {
	const parsed = asMinuteOfDay(n);
	if (parsed === null) {
		throw new Error(`Invalid minute-of-day: ${n}`);
	}
	return parsed;
}
