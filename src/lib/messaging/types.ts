import type { Database } from "../db/generated/database.types";
import type { MarketClosureInfo } from "../time/market/calendar";
import type { SparklineData } from "./parts/charts/sparkline";

/** Minimal user shape needed to send email. */
export type EmailUser = Pick<Database["public"]["Tables"]["users"]["Row"], "id" | "email">;
/** Minimal user shape needed to send SMS. */
export type SmsUser = Pick<
	Database["public"]["Tables"]["users"]["Row"],
	"id" | "phone_country_code" | "phone_number"
>;

/** Optional context for email rendering: sparklines, logos, market closure banners. */
export interface EmailFormatContext {
	getSparkline?: (symbol: string) => SparklineData | null | undefined;
	marketClosureInfo?: MarketClosureInfo | null;
	getLogoHtml?: (symbol: string) => string | undefined;
}
