import type { Database } from "../db/generated/database.types";
import type { MarketClosureInfo } from "../time/market-calendar";
import type { PrefRow } from "./notification-prefs";
import type { SparklineData } from "./parts/charts/sparkline";

/** Result of attempting to deliver a single notification (email or SMS). */
export type DeliveryResult =
	| { success: true; messageSid?: string }
	| { success: false; error: string; errorCode?: string };

/** Per-notification processing metadata used for auditing/debugging. */
export type ProcessingStats =
	| { sent: true; logged: boolean }
	| { sent: false; logged: boolean; error: string; errorCode?: string };

type DbUserRow = Database["public"]["Tables"]["users"]["Row"];

type GrokRumorsPreferences = {
	last_grok_rumors_at: string | null;
	grok_window_start: string | null;
	grok_sends_in_window: number;
};

/** User fields required for notification delivery, scheduling, and formatting.
 *
 * Per-option channel preferences live in `notification_preferences` (carried as
 * `prefs`), NOT on per-column flags. Channel-level enables (`email_notifications_enabled`,
 * etc.) stay on the users row. */
export type UserRecord = Pick<
	DbUserRow,
	| "id"
	| "email"
	| "phone_country_code"
	| "phone_number"
	| "phone_verified"
	| "timezone"
	| "use_24_hour_time"
	| "market_scheduled_asset_price_next_send_at"
	| "email_notifications_enabled"
	| "sms_notifications_enabled"
	| "sms_opted_out"
> & {
	market_scheduled_asset_price_enabled: boolean;
	market_scheduled_asset_price_times: number[] | null;
	daily_digest_time: number | null;
	daily_digest_next_send_at: string | null;
	asset_events_next_send_at: string | null;
	asset_events_last_analyst_sent_month: string | null;
	telegram_chat_id: number | null;
	telegram_opted_out: boolean;
	/** Per-option channel preferences (the single source of truth for all channels). */
	prefs: PrefRow[];
} & GrokRumorsPreferences;

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

/** User asset joined with its canonical asset name. */
export type UserAssetRow = Pick<Database["public"]["Tables"]["user_assets"]["Row"], "symbol"> & {
	name: Database["public"]["Tables"]["assets"]["Row"]["name"];
	icon_url?: Database["public"]["Tables"]["assets"]["Row"]["icon_url"];
	icon_base64?: Database["public"]["Tables"]["assets"]["Row"]["icon_base64"];
};
