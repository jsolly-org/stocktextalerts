import {
	type AutoSaveFormOptions,
	useAutoSaveFormBase,
} from "./useAutoSaveFormBase";

export type NotificationPreferencesData = {
	email_notifications_enabled: boolean;
	sms_notifications_enabled: boolean;
	phone_verified: boolean;
	timezone: string;
	scheduled_updates_enabled: boolean;
	scheduled_update_times: number[] | null;
	next_send_at: string | null;
	dismiss_timezone_mismatch_prompts: boolean;
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
