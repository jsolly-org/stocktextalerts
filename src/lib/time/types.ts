import type { Database } from "../db/generated/database.types";

/** Normalized parsed time components (always numeric). */
export type ParsedTime = {
	hours: number;
	minutes: number;
	seconds: number;
};

/** Time picker input shape (accepts numbers or numeric strings). */
export type TimeValue = {
	hours: number | string;
	minutes: number | string;
};

/** Option row used to populate timezone dropdowns. */
export type TimezoneOption = Pick<
	Database["public"]["Tables"]["timezones"]["Row"],
	"value" | "label" | "display_order"
>;
