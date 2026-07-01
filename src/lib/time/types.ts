import type { Hour24, MinuteOfHour, SecondOfMinute } from "../types";

export type ParsedTime = {
	hours: Hour24;
	minutes: MinuteOfHour;
	seconds: SecondOfMinute;
};

export type TimeValue = {
	hours: Hour24 | string;
	minutes: MinuteOfHour | string;
};

export type MarketClosureReason = "weekend" | "holiday" | "half-day-after-close";

export interface MarketClosureInfo {
	reason: MarketClosureReason;
	/** Holiday name from the exchange calendar (e.g. "Presidents' Day"), if available. */
	holidayName?: string;
}
