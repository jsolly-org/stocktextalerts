import type { Database } from "../db/generated/database.types";
import type { Hour24, MinuteOfHour, SecondOfMinute } from "../types";

export type { Hour24, MinuteOfHour, SecondOfMinute } from "../types";

export type ParsedTime = {
	hours: Hour24;
	minutes: MinuteOfHour;
	seconds: SecondOfMinute;
};

export type TimeValue = {
	hours: Hour24 | string;
	minutes: MinuteOfHour | string;
};

export type TimezoneOption = Pick<
	Database["public"]["Tables"]["timezones"]["Row"],
	"value" | "label" | "display_order"
>;
