import { DEFAULT_TIMEZONE } from "../../../lib/timezones/constants";
import { setupDetectedTimezoneOption } from "../../../lib/timezones/select";

function onDOMReady(callback: () => void) {
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", callback, { once: true });
		return;
	}

	callback();
}

function setupSaveHint(options: { formId: string; saveHintId: string }) {
	const hint = document.getElementById(options.saveHintId);
	if (!(hint instanceof HTMLElement)) {
		return;
	}

	const formElement = document.getElementById(options.formId);
	if (!(formElement instanceof HTMLFormElement)) {
		return;
	}

	const timezoneSelect = formElement.querySelector("#timezone");
	const emailCheckbox = formElement.querySelector(
		`#${options.formId}-email_notifications_enabled`,
	);
	const smsCheckbox = formElement.querySelector(
		`#${options.formId}-sms_notifications_enabled`,
	);

	if (
		!(timezoneSelect instanceof HTMLSelectElement) ||
		!(emailCheckbox instanceof HTMLInputElement) ||
		!(smsCheckbox instanceof HTMLInputElement)
	) {
		return;
	}

	const initial = {
		timezone: timezoneSelect.value,
		emailEnabled: emailCheckbox.checked,
		smsEnabled: smsCheckbox.checked,
	};

	const update = () => {
		const isDirty =
			timezoneSelect.value !== initial.timezone ||
			emailCheckbox.checked !== initial.emailEnabled ||
			smsCheckbox.checked !== initial.smsEnabled;

		hint.classList.toggle("hidden", !isDirty);
	};

	update();
	timezoneSelect.addEventListener("change", update);
	emailCheckbox.addEventListener("input", update);
	smsCheckbox.addEventListener("input", update);

	const cleanup = () => {
		timezoneSelect.removeEventListener("change", update);
		emailCheckbox.removeEventListener("input", update);
		smsCheckbox.removeEventListener("input", update);
		window.removeEventListener("pagehide", cleanup);
		window.removeEventListener("beforeunload", cleanup);
	};

	window.addEventListener("pagehide", cleanup, { once: true });
	window.addEventListener("beforeunload", cleanup, { once: true });
}

export function initNotificationPreferencesCards() {
	onDOMReady(() => {
		setupDetectedTimezoneOption({ defaultTimezone: DEFAULT_TIMEZONE });

		const cards = document.querySelectorAll<HTMLElement>(
			"[data-notification-preferences-card]",
		);

		for (const card of cards) {
			if (card.dataset.initialized === "1") {
				continue;
			}

			card.dataset.initialized = "1";

			const formId = card.dataset.formId ?? "";
			const saveHintId = card.dataset.saveHintId ?? "";
			if (!formId || !saveHintId) {
				continue;
			}

			setupSaveHint({ formId, saveHintId });
		}
	});
}
