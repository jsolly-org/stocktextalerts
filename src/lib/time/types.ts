import type { DateTime } from "luxon";
import type { Hour24, MinuteOfHour, ScheduledSlotKey, SecondOfMinute } from "../types";

/** A scheduled slot key plus the UTC instant it was due (cursor value, or "now" when unset). */
export interface ScheduledSlotContext extends ScheduledSlotKey {
	dueAt: DateTime;
}

export type MarketClosureReason = "weekend" | "holiday" | "half-day-after-close";

export interface MarketClosureInfo {
	reason: MarketClosureReason;
	/** Holiday name from the exchange calendar (e.g. "Presidents' Day"), if available. */
	holidayName?: string;
}

export type ParsedTime = {
	hours: Hour24;
	minutes: MinuteOfHour;
	seconds: SecondOfMinute;
};

export type TimeValue = {
	hours: Hour24 | string;
	minutes: MinuteOfHour | string;
};
