import { DateTime } from "luxon";
import { rootLogger } from "../logging";

export function setupTimezoneMismatchBanner(options: {
	savedTimezone: string;
	allowedTimezones: string[];
	dismissTimezoneMismatchPrompts: boolean;
}) {
	const banner = document.getElementById("timezone-mismatch-banner");
	const detectedSpan = document.getElementById("detected-timezone");
	const savedSpan = document.getElementById("saved-timezone");
	const timezoneInput = document.getElementById("timezone-update-value");
	const dismissButton = document.getElementById("dismiss-timezone-banner");
	const dismissPermanentlyButton = document.getElementById(
		"dismiss-timezone-banner-permanently",
	);

	if (
		!(banner instanceof HTMLElement) ||
		!(detectedSpan instanceof HTMLElement) ||
		!(savedSpan instanceof HTMLElement) ||
		!(timezoneInput instanceof HTMLInputElement) ||
		!(dismissButton instanceof HTMLButtonElement) ||
		!(dismissPermanentlyButton instanceof HTMLButtonElement)
	) {
		rootLogger.warn("TimezoneMismatchBanner: Required DOM elements not found");
		return;
	}

	const bannerElement = banner;
	const detectedSpanElement = detectedSpan;
	const savedSpanElement = savedSpan;
	const timezoneInputElement = timezoneInput;
	const dismissButtonElement = dismissButton;
	const dismissPermanentlyButtonElement = dismissPermanentlyButton;

	const detected = DateTime.local().zoneName ?? "";

	if (!detected) {
		return;
	}

	const allowedTimezoneSet = new Set(options.allowedTimezones);
	if (!allowedTimezoneSet.has(detected)) {
		return;
	}

	function checkAndShowBanner(
		savedTimezone: string,
		dismissTimezoneMismatchPrompts: boolean,
	) {
		if (dismissTimezoneMismatchPrompts) {
			bannerElement.classList.add("hidden");
			return;
		}

		if (!savedTimezone || detected === savedTimezone) {
			bannerElement.classList.add("hidden");
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
			bannerElement.classList.add("hidden");
			return;
		}

		detectedSpanElement.textContent = detected;
		savedSpanElement.textContent = savedTimezone;
		timezoneInputElement.value = detected;
		bannerElement.dataset.savedTimezone = savedTimezone;
		bannerElement.classList.remove("hidden");
	}

	function handleDismiss() {
		const currentSavedTimezone =
			bannerElement.dataset.savedTimezone ?? options.savedTimezone;
		const dismissalKey = `timezone_mismatch_banner_dismissed:${currentSavedTimezone}:${detected}`;
		try {
			sessionStorage.setItem(dismissalKey, "1");
		} catch {
			// Ignore sessionStorage errors (SecurityError / QuotaExceededError)
		}
		bannerElement.classList.add("hidden");
	}

	checkAndShowBanner(
		options.savedTimezone,
		options.dismissTimezoneMismatchPrompts,
	);

	dismissButtonElement.addEventListener("click", handleDismiss);

	async function handleDismissPermanently() {
		try {
			const response = await fetch("/api/preferences/dismiss-timezone-banner", {
				method: "POST",
				credentials: "same-origin",
				headers: { Accept: "application/json" },
				signal: AbortSignal.timeout(10_000),
			});

			if (!response.ok) {
				rootLogger.error("Failed to dismiss timezone banner permanently");
				return;
			}

			bannerElement.dataset.dismissTimezoneMismatchPrompts = "true";
			bannerElement.classList.add("hidden");
		} catch (error) {
			rootLogger.error(
				"Failed to dismiss timezone banner permanently",
				undefined,
				error,
			);
		}
	}

	dismissPermanentlyButtonElement.addEventListener(
		"click",
		handleDismissPermanently,
	);

	function handlePreferencesUpdated(event: Event) {
		if (!(event instanceof CustomEvent)) {
			return;
		}

		const preferences = event.detail?.preferences;
		if (!preferences) {
			return;
		}

		const savedTimezone =
			typeof preferences.timezone === "string"
				? preferences.timezone
				: options.savedTimezone;
		const dismissTimezoneMismatchPrompts =
			typeof preferences.dismiss_timezone_mismatch_prompts === "boolean"
				? preferences.dismiss_timezone_mismatch_prompts
				: options.dismissTimezoneMismatchPrompts;

		checkAndShowBanner(savedTimezone, dismissTimezoneMismatchPrompts);
	}

	document.addEventListener("preferences-updated", handlePreferencesUpdated);

	window.addEventListener(
		"pagehide",
		() => {
			document.removeEventListener(
				"preferences-updated",
				handlePreferencesUpdated,
			);
			dismissButtonElement.removeEventListener("click", handleDismiss);
			dismissPermanentlyButtonElement.removeEventListener(
				"click",
				handleDismissPermanently,
			);
		},
		{ once: true },
	);
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
