import {
	type AutoSaveFormOptions,
	useAutoSaveFormBase,
} from "./useAutoSaveFormBase";

export type NotificationPreferencesData = {
	price_notifications_enabled: boolean;
	email_notifications_enabled: boolean;
	sms_notifications_enabled: boolean;
	sms_opted_out: boolean;
	phone_verified: boolean;
	timezone: string;
	scheduled_update_times: number[] | null;
	daily_delivery_time: number | null;
	daily_next_send_at: string | null;
	next_send_at: string | null;
	dismiss_timezone_mismatch_prompts: boolean;
	daily_include_news_email: boolean;
	daily_include_rumors_email: boolean;
	daily_include_analyst_email: boolean;
	daily_include_insider_email: boolean;
	daily_include_analyst_sms: boolean;
	daily_include_insider_sms: boolean;
	price_include_email: boolean;
	price_include_sms: boolean;
	weekly_include_earnings_email: boolean;
	weekly_include_earnings_sms: boolean;
	weekly_next_send_at: string | null;
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
