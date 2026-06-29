import {
	US_AFTER_OPEN_EASTERN_MINUTES,
	US_BEFORE_OPEN_EASTERN_MINUTES,
	US_MARKET_TIMEZONE,
} from "../constants";
import { dateTimeAtMinuteOfDay, minuteOfDayFromDateTime } from "./utils";

/**
 * Convert an ET-minute (minutes since midnight in America/New_York) to the
 * user's local minute-of-day. Anchored to the current calendar date so DST
 * is applied correctly via Luxon's zone conversion.
 *
 * For non-US timezones the result may exceed 23:59 — wrap by computing
 * `((result % 1440) + 1440) % 1440` if a same-day value is required.
 */
export function etMinuteToUserLocal(etMinute: number, userTimezone: string): number {
	const eastern = dateTimeAtMinuteOfDay(etMinute, US_MARKET_TIMEZONE);
	const local = eastern.setZone(userTimezone);
	if (!local.isValid) {
		return etMinute;
	}
	return minuteOfDayFromDateTime(local);
}

/**
 * Convert a user-local minute-of-day to an ET-minute. Inverse of
 * `etMinuteToUserLocal`. Anchored to the current calendar date so DST
 * is applied correctly.
 */
export function userLocalToEtMinute(localMinute: number, userTimezone: string): number {
	const local = dateTimeAtMinuteOfDay(localMinute, userTimezone);
	if (!local.isValid) {
		return localMinute;
	}
	const eastern = local.setZone(US_MARKET_TIMEZONE);
	return minuteOfDayFromDateTime(eastern);
}

/** 30 min before US market open (9:00 AM ET) converted to the user's local timezone. */
export function getUsBeforeOpenLocalMinutes(userTimezone: string): number {
	return etMinuteToUserLocal(US_BEFORE_OPEN_EASTERN_MINUTES, userTimezone);
}

/** 30 min after US market open (10:00 AM ET) converted to the user's local timezone. */
export function getUsAfterOpenLocalMinutes(userTimezone: string): number {
	return etMinuteToUserLocal(US_AFTER_OPEN_EASTERN_MINUTES, userTimezone);
}
