import { DateTime } from "luxon";

/**
 * Set the selected timezone `<select>` option based on the browser-detected timezone.
 *
 * Only applies when no value is already selected; falls back to an optional default timezone.
 */
export function setupDetectedTimezoneOption(options?: {
	selectId?: string;
	defaultTimezone?: string;
}) {
	const selectId = options?.selectId ?? "timezone";
	const defaultTimezone = options?.defaultTimezone ?? "";

	const select = document.getElementById(selectId);
	if (!(select instanceof HTMLSelectElement)) {
		return;
	}

	if (select.value !== "") {
		return;
	}

	const detected = DateTime.local().zoneName ?? "";

	const knownValues = new Set(Array.from(select.options).map((option) => option.value));

	if (detected !== "" && knownValues.has(detected)) {
		select.value = detected;
		return;
	}

	if (defaultTimezone !== "" && knownValues.has(defaultTimezone)) {
		select.value = defaultTimezone;
	}
}
