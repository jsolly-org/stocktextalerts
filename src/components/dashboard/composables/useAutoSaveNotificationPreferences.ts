import {
	type AutoSaveFormOptions,
	useAutoSaveFormBase,
} from "./useAutoSaveFormBase";

export type NotificationPreferencesData = {
	email_notifications_enabled: boolean;
	sms_notifications_enabled: boolean;
	sms_opted_out: boolean;
	phone_verified: boolean;
	timezone: string;
	scheduled_updates_enabled: boolean;
	scheduled_update_times: number[] | null;
	only_notify_when_market_open: boolean;
	add_ons_notifications_enabled: boolean;
	add_ons_delivery_time: number | null;
	add_ons_next_send_at: string | null;
	next_send_at: string | null;
	dismiss_timezone_mismatch_prompts: boolean;
	first_notification_include_news: boolean;
	first_notification_include_rumors: boolean;
};

type AutoSaveOptions = Omit<AutoSaveFormOptions, "payloadKey" | "logAction">;

/* ============= Composable ============= */
/**
 * Auto-save wrapper for the notification preferences form payload.
 */
export function useAutoSaveForm<T = unknown>(options: AutoSaveOptions) {
	return useAutoSaveFormBase<T>({
		...options,
		payloadKey: "notificationPreferences",
		logAction: "autosave_notification-preferences",
	});
}
