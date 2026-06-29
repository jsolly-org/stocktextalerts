import type { Database } from "./db/generated/database.types";

export type TimezoneOption = Pick<
	Database["public"]["Tables"]["timezones"]["Row"],
	"value" | "label" | "display_order"
>;
