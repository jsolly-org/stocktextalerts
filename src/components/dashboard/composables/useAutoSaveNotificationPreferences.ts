import {
	type AutoSaveFormOptions,
	useAutoSaveFormBase,
} from "./useAutoSaveFormBase";

export type NotificationPreferencesData = {
	market_scheduled_asset_price_enabled: boolean;
	email_notifications_enabled: boolean;
	sms_opted_out: boolean;
	phone_verified: boolean;
	timezone: string;
	market_scheduled_asset_price_times: number[] | null;
	daily_digest_time: number | null;
	daily_digest_next_send_at: string | null;
	market_scheduled_asset_price_next_send_at: string | null;
	dismiss_timezone_mismatch_prompts: boolean;
	daily_digest_include_prices_email: boolean;
	daily_digest_include_prices_sms: boolean;
	daily_digest_include_top_movers_email: boolean;
	daily_digest_include_news_email: boolean;
	daily_digest_include_rumors_email: boolean;
	market_scheduled_asset_price_include_email: boolean;
	market_scheduled_asset_price_include_sms: boolean;
	asset_events_include_calendar_email: boolean;
	asset_events_include_calendar_sms: boolean;
	asset_events_include_ipo_email: boolean;
	asset_events_include_ipo_sms: boolean;
	asset_events_include_analyst_email: boolean;
	asset_events_include_analyst_sms: boolean;
	asset_events_include_insider_email: boolean;
	asset_events_include_insider_sms: boolean;
	asset_events_next_send_at: string | null;
	market_asset_price_alerts_enabled: boolean;
	market_asset_price_alerts_include_email: boolean;
	market_asset_price_alerts_include_sms: boolean;
	market_asset_price_alert_move_size: "significant" | "extreme";
	price_move_alerts_enabled: boolean;
	price_targets_include_email: boolean;
	price_targets_include_sms: boolean;
};

type AutoSaveOptions = Omit<AutoSaveFormOptions, "payloadKey" | "logAction">;

/* ============= Composable ============= */
/**
 * Auto-save wrapper for the notification-preferences form.
 *
 * Preconfigures the payload key and log action used by the shared auto-save base composable.
 */
export function useAutoSaveForm<T = unknown>(options: AutoSaveOptions) {
	return useAutoSaveFormBase<T>({
		...options,
		payloadKey: "notificationPreferences",
		logAction: "autosave_notification-preferences",
	});
}
