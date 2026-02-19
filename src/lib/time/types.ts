import type { Database } from "../db/generated/database.types";

export type ParsedTime = {
	hours: number;
	minutes: number;
	seconds: number;
};

export type TimeValue = {
	hours: number | string;
	minutes: number | string;
};

export type TimezoneOption = Pick<
	Database["public"]["Tables"]["timezones"]["Row"],
	"value" | "label" | "display_order"
>;
