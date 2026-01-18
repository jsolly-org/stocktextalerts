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
		console.warn("TimezoneMismatchBanner: Required DOM elements not found");
		return;
	}

	const detected = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";

	if (!detected || detected === "") {
		return;
	}

	const allowedTimezoneSet = new Set(allowedTimezones ?? []);
	if (!allowedTimezoneSet.has(detected)) {
		return;
	}

	const saved = savedTimezone ?? "";
	const dismissalKey = `timezone_mismatch_banner_dismissed:${saved}:${detected}`;
	let dismissed = false;
	try {
		dismissed = sessionStorage.getItem(dismissalKey) === "1";
	} catch {
		dismissed = false;
	}
	if (dismissed) {
		return;
	}

	if (!saved || detected === saved) {
		return;
	}

	detectedSpan.textContent = detected;
	savedSpan.textContent = saved;
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
