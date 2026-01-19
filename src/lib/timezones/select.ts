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

	// `Intl.DateTimeFormat().resolvedOptions().timeZone` can be undefined, so normalize
	// before using it for comparisons.
	const detected = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";

	const knownValues = new Set(
		Array.from(select.options).map((option) => option.value),
	);

	if (detected !== "" && knownValues.has(detected)) {
		select.value = detected;
		return;
	}

	if (defaultTimezone !== "" && knownValues.has(defaultTimezone)) {
		select.value = defaultTimezone;
	}
}
