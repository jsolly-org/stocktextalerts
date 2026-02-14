import {
	type AutoSaveFormOptions,
	useAutoSaveFormBase,
} from "./useAutoSaveFormBase";

export type FormatPreferencesData = {
	show_sparklines: boolean;
};

type AutoSaveOptions = Omit<AutoSaveFormOptions, "payloadKey" | "logAction">;

/* ============= Composable ============= */
/**
 * Auto-save wrapper for the format-preferences form.
 *
 * Preconfigures the payload key and log action used by the shared auto-save base composable.
 */
export function useAutoSaveFormatPreferences<T = unknown>(
	options: AutoSaveOptions,
) {
	return useAutoSaveFormBase<T>({
		...options,
		payloadKey: "formatPreferences",
		logAction: "autosave_format-preferences",
	});
}
