import {
	type AutoSaveFormOptions,
	useAutoSaveFormBase,
} from "./useAutoSaveFormBase";

export type FormatPreferencesData = {
	show_change_percent: boolean;
	show_company_name: boolean;
	detailed_format: boolean;
};

type AutoSaveOptions = Omit<AutoSaveFormOptions, "payloadKey" | "logAction">;

/* ============= Composable ============= */
export function useAutoSaveFormatPreferences<T = unknown>(
	options: AutoSaveOptions,
) {
	return useAutoSaveFormBase<T>({
		...options,
		payloadKey: "formatPreferences",
		logAction: "autosave_format-preferences",
	});
}
