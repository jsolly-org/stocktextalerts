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
	only_notify_when_market_open: boolean;
	add_ons_only_notify_when_market_open: boolean;
	add_ons_delivery_time: number | null;
	add_ons_next_send_at: string | null;
	next_send_at: string | null;
	dismiss_timezone_mismatch_prompts: boolean;
	add_ons_include_news: boolean;
	add_ons_include_rumors: boolean;
};

type AutoSaveOptions = Omit<AutoSaveFormOptions, "payloadKey" | "logAction">;

/* ============= Composable ============= */
export function useAutoSaveForm<T = unknown>(options: AutoSaveOptions) {
	return useAutoSaveFormBase<T>({
		...options,
		payloadKey: "notificationPreferences",
		logAction: "autosave_notification-preferences",
	});
}
