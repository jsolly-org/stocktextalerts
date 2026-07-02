import { type AutoSaveFormOptions, useAutoSaveFormBase } from "./useAutoSaveFormBase";

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
