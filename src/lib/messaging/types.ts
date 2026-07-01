import type { Database } from "../db/generated/database.types";
import type { MarketClosureInfo } from "../time/types";
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

/** A single holding being reported as delisted in a notification email. */
export interface DelistedHolding {
	symbol: string;
	name: string;
	/** YYYY-MM-DD date the exchange marked the ticker as delisted. */
	delistedDate: string;
	/** Primary exchange label (e.g. "NASDAQ"). Optional; omitted when unknown. */
	exchange?: string | null;
}

/** Optional Grok/Massive/Finnhub extras appended to digest or scheduled notifications. */
export type NotificationExtras = {
	news?: string | null;
	rumors?: string | null;
	analyst?: string | null;
	insider?: string | null;
	topMovers?: string | null;
	citations?: string[];
};

export type LogoCache = Map<string, string | null>;
