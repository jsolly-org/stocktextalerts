import { DateTime } from "luxon";
import { rootLogger } from "../logging";

export function setupTimezoneMismatchBanner(options: {
	savedTimezone: string;
	allowedTimezones: string[];
}) {
	const savedTimezone = options.savedTimezone;
	const allowedTimezones = options.allowedTimezones;

	const banner = document.getElementById("timezone-mismatch-banner");
	const detectedSpan = document.getElementById("detected-timezone");
	const savedSpan = document.getElementById("saved-timezone");
	const timezoneInput = document.getElementById("timezone-update-value");
	const dismissButton = document.getElementById("dismiss-timezone-banner");

	if (
		!(banner instanceof HTMLElement) ||
		!(detectedSpan instanceof HTMLElement) ||
		!(savedSpan instanceof HTMLElement) ||
		!(timezoneInput instanceof HTMLInputElement) ||
		!(dismissButton instanceof HTMLButtonElement)
	) {
		rootLogger.warn("TimezoneMismatchBanner: Required DOM elements not found");
		return;
	}

	const detected = DateTime.local().zoneName ?? "";

	if (!detected) {
		return;
	}

	const allowedTimezoneSet = new Set(allowedTimezones);
	if (!allowedTimezoneSet.has(detected)) {
		return;
	}

	if (!savedTimezone || detected === savedTimezone) {
		return;
	}

	const dismissalKey = `timezone_mismatch_banner_dismissed:${savedTimezone}:${detected}`;
	let dismissed = false;
	try {
		dismissed = sessionStorage.getItem(dismissalKey) === "1";
	} catch {
		dismissed = false;
	}
	if (dismissed) {
		return;
	}

	detectedSpan.textContent = detected;
	savedSpan.textContent = savedTimezone;
	timezoneInput.value = detected;

	dismissButton.addEventListener(
		"click",
		() => {
			try {
				sessionStorage.setItem(dismissalKey, "1");
			} catch {
				// Ignore sessionStorage errors (SecurityError / QuotaExceededError)
			}
			banner.classList.add("hidden");
		},
		{ once: true },
	);

	banner.classList.remove("hidden");
}

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
