import { DateTime } from "luxon";
import { rootLogger } from "../../../lib/logging";
import {
	formatArrivalTime,
	formatTimeRemaining,
	formatTimezone,
	getNowInTimezone,
	getSecondsUntilNextSend,
} from "../../../lib/time/format";

type ScheduledNotificationsOptions = {
	formId: string;
	timezone: string;
	nextSendAtIso: string | null;
	emailNotificationsEnabled: boolean;
	smsNotificationsEnabled: boolean;
	smsOptedOut: boolean;
	phoneVerified: boolean;
};

function setupDailyDigestUI(options: ScheduledNotificationsOptions) {
	const {
		formId,
		timezone,
		nextSendAtIso,
		emailNotificationsEnabled,
		smsNotificationsEnabled,
		smsOptedOut,
		phoneVerified,
	} = options;

	const formElement = document.getElementById(formId);
	if (!(formElement instanceof HTMLFormElement)) {
		return;
	}
	const form = formElement;

	const enabledCheckbox = form.querySelector<HTMLInputElement>(
		"#daily_digest_enabled",
	);
	if (!enabledCheckbox) {
		return;
	}
	const enabledCheckboxEl: HTMLInputElement = enabledCheckbox;

	const settingsContainer = form.querySelector<HTMLElement>(
		"#daily-digest-settings",
	);
	const currentTimeDisplay = document.getElementById(
		"daily-digest-current-time",
	);
	const countdownDisplay = document.getElementById("daily-digest-countdown");
	const arrivalTimeDisplay = document.getElementById(
		"daily-digest-arrival-time",
	);
	const timezoneDisplay = document.getElementById("daily-digest-timezone");
	const sendNowButton = document.getElementById(
		"daily-digest-send-now",
	) as HTMLButtonElement | null;
	const liveDetails = document.getElementById("daily-digest-live-details");
	const skipModal = document.getElementById(
		"daily-digest-skip-modal",
	) as HTMLElement | null;
	const skipModalBackdrop = document.getElementById(
		"daily-digest-skip-modal-backdrop",
	) as HTMLButtonElement | null;
	const skipModalDueIn = document.getElementById(
		"daily-digest-skip-modal-due-in",
	) as HTMLElement | null;
	const skipModalSendAndSkip = document.getElementById(
		"daily-digest-skip-modal-send-and-skip",
	) as HTMLButtonElement | null;
	const skipModalSendNoSkip = document.getElementById(
		"daily-digest-skip-modal-send-no-skip",
	) as HTMLButtonElement | null;

	if (
		!sendNowButton ||
		!skipModal ||
		!skipModalBackdrop ||
		!skipModalDueIn ||
		!skipModalSendAndSkip ||
		!skipModalSendNoSkip
	) {
		return;
	}

	initializeDailyDigestUI({
		form,
		enabledCheckbox: enabledCheckboxEl,
		settingsContainer,
		currentTimeDisplay,
		countdownDisplay,
		arrivalTimeDisplay,
		timezoneDisplay,
		sendNowButton,
		liveDetails,
		skipModal,
		skipModalBackdrop,
		skipModalDueIn,
		skipModalSendAndSkip,
		skipModalSendNoSkip,
		timezone,
		nextSendAtIso,
		emailNotificationsEnabled,
		smsNotificationsEnabled,
		smsOptedOut,
		phoneVerified,
	});
}

function initializeDailyDigestUI(options: {
	form: HTMLFormElement;
	enabledCheckbox: HTMLInputElement;
	settingsContainer: HTMLElement | null;
	currentTimeDisplay: HTMLElement | null;
	countdownDisplay: HTMLElement | null;
	arrivalTimeDisplay: HTMLElement | null;
	timezoneDisplay: HTMLElement | null;
	sendNowButton: HTMLButtonElement;
	liveDetails: HTMLElement | null;
	skipModal: HTMLElement;
	skipModalBackdrop: HTMLButtonElement;
	skipModalDueIn: HTMLElement;
	skipModalSendAndSkip: HTMLButtonElement;
	skipModalSendNoSkip: HTMLButtonElement;
	timezone: string;
	nextSendAtIso: string | null;
	emailNotificationsEnabled: boolean;
	smsNotificationsEnabled: boolean;
	smsOptedOut: boolean;
	phoneVerified: boolean;
}) {
	const {
		form,
		enabledCheckbox,
		settingsContainer,
		currentTimeDisplay,
		countdownDisplay,
		arrivalTimeDisplay,
		timezoneDisplay,
		sendNowButton,
		liveDetails,
		skipModal,
		skipModalBackdrop,
		skipModalDueIn,
		skipModalSendAndSkip,
		skipModalSendNoSkip,
		timezone,
		nextSendAtIso,
		emailNotificationsEnabled,
		smsNotificationsEnabled,
		smsOptedOut,
		phoneVerified,
	} = options;

	function getTimeInput() {
		return form.querySelector<HTMLInputElement>(
			'input[name="daily_digest_notification_time"]',
		);
	}

	function getSecondsUntilNextDigest() {
		const timeInput = getTimeInput();
		if (!(timeInput instanceof HTMLInputElement)) {
			return null;
		}
		return getSecondsUntilNextSend({
			timezone,
			nextSendAtIso,
			timeInput: timeInput.value,
			now: DateTime.now(),
		});
	}

	function updateNowAndCountdown() {
		if (currentTimeDisplay) {
			currentTimeDisplay.textContent = getNowInTimezone(timezone) ?? "";
		}

		if (!countdownDisplay) {
			return;
		}

		const enabled = enabledCheckbox.checked;

		const emailEnabled = emailNotificationsEnabled === true;
		const smsEnabled = smsNotificationsEnabled === true;

		const smsReady =
			smsEnabled && smsOptedOut !== true && phoneVerified === true;
		const hasNotificationChannel = emailEnabled || smsReady;

		if (!enabled || !hasNotificationChannel) {
			if (liveDetails instanceof HTMLElement) {
				liveDetails.classList.add("hidden");
			}

			countdownDisplay.textContent = "";
			if (arrivalTimeDisplay) {
				arrivalTimeDisplay.textContent = "";
			}
			if (timezoneDisplay) {
				timezoneDisplay.textContent = "";
			}
			sendNowButton.disabled = true;
			return;
		}

		if (liveDetails instanceof HTMLElement) {
			liveDetails.classList.remove("hidden");
		}

		const secondsUntil = getSecondsUntilNextDigest();
		if (typeof secondsUntil !== "number") {
			countdownDisplay.textContent = "";
			if (arrivalTimeDisplay) {
				arrivalTimeDisplay.textContent = "";
			}
			if (timezoneDisplay) {
				timezoneDisplay.textContent = "";
			}
			sendNowButton.disabled = true;
			return;
		}

		countdownDisplay.textContent = formatTimeRemaining(secondsUntil);
		if (arrivalTimeDisplay) {
			arrivalTimeDisplay.textContent = formatArrivalTime(
				secondsUntil,
				timezone,
			);
		}
		if (timezoneDisplay) {
			const tz = formatTimezone(secondsUntil, timezone);
			timezoneDisplay.textContent = tz === "" ? "" : ` ${tz}`;
		}
		sendNowButton.disabled = false;
	}

	const update = () => {
		const enabled = enabledCheckbox.checked;
		const timeInput = getTimeInput();
		if (timeInput instanceof HTMLInputElement) {
			timeInput.disabled = !enabled;
		}

		document.dispatchEvent(
			new CustomEvent("daily-digest-enabled-changed", {
				detail: { enabled },
			}),
		);
		form.dispatchEvent(new Event("input", { bubbles: true }));
		updateNowAndCountdown();
	};

	const handleTimeInputEvent = (event: Event) => {
		const target = event.target;
		if (
			target instanceof HTMLInputElement &&
			target.name === "daily_digest_notification_time"
		) {
			updateNowAndCountdown();
		}
	};

	if (settingsContainer instanceof HTMLElement) {
		settingsContainer.addEventListener("input", handleTimeInputEvent);
		settingsContainer.addEventListener("change", handleTimeInputEvent);
	}

	function openSkipModal(dueInSeconds: number) {
		skipModalDueIn.textContent = formatTimeRemaining(dueInSeconds);
		skipModal.classList.remove("hidden");
	}

	skipModalBackdrop.addEventListener("click", () => {
		skipModal.classList.add("hidden");
	});

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === "Escape") {
			skipModal.classList.add("hidden");
		}
	}

	document.addEventListener("keydown", handleKeydown);

	const skipPromptSuppressKey = "daily_digest_skip_prompt_suppress_once";

	async function sendNow(sendOptions?: { skipNext?: boolean }) {
		const previousLabel = sendNowButton.textContent;
		sendNowButton.disabled = true;
		sendNowButton.textContent = "Sending…";

		try {
			const url = sendOptions?.skipNext
				? "/api/notifications/daily-digest-now?skip_next=1"
				: "/api/notifications/daily-digest-now";
			const response = await fetch(url, {
				method: "POST",
				credentials: "same-origin",
				signal: AbortSignal.timeout(10_000),
			});

			if (response.redirected) {
				window.location.assign(response.url);
				return;
			}

			if (response.ok) {
				window.location.assign("/dashboard?success=daily_digest_sent");
				return;
			}

			window.location.assign("/dashboard?error=daily_digest_send_failed");
		} catch (error) {
			if (error instanceof Error && error.name === "TimeoutError") {
				rootLogger.error(
					"Daily digest send request timed out",
					undefined,
					error,
				);
				window.location.assign("/dashboard?error=daily_digest_timed_out");
			} else {
				rootLogger.error("Failed to send daily digest now", undefined, error);
				window.location.assign("/dashboard?error=daily_digest_send_failed");
			}
		} finally {
			if (document.visibilityState === "visible") {
				sendNowButton.textContent = previousLabel;
			}
		}
	}

	sendNowButton.addEventListener("click", async () => {
		if (sendNowButton.disabled) {
			return;
		}

		let suppressOnce = false;
		try {
			suppressOnce = sessionStorage.getItem(skipPromptSuppressKey) === "1";
		} catch {
			suppressOnce = false;
		}
		if (suppressOnce) {
			try {
				sessionStorage.removeItem(skipPromptSuppressKey);
			} catch {
				// Ignore sessionStorage errors (SecurityError / QuotaExceededError)
			}
			await sendNow({ skipNext: false });
			return;
		}

		const dueInSeconds = getSecondsUntilNextDigest();
		const shouldPrompt =
			typeof nextSendAtIso === "string" &&
			typeof dueInSeconds === "number" &&
			dueInSeconds > 0 &&
			dueInSeconds < 24 * 60 * 60;

		if (!shouldPrompt) {
			await sendNow({ skipNext: false });
			return;
		}

		openSkipModal(dueInSeconds);
	});

	skipModalSendAndSkip.addEventListener("click", async () => {
		skipModal.classList.add("hidden");
		try {
			sessionStorage.setItem(skipPromptSuppressKey, "1");
		} catch {
			// Ignore sessionStorage errors (SecurityError / QuotaExceededError)
		}
		await sendNow({ skipNext: true });
	});

	skipModalSendNoSkip.addEventListener("click", async () => {
		skipModal.classList.add("hidden");
		await sendNow({ skipNext: false });
	});

	updateNowAndCountdown();
	const intervalId = window.setInterval(updateNowAndCountdown, 1_000);
	window.addEventListener(
		"pagehide",
		() => {
			window.clearInterval(intervalId);
			document.removeEventListener("keydown", handleKeydown);
			if (settingsContainer instanceof HTMLElement) {
				settingsContainer.removeEventListener("input", handleTimeInputEvent);
				settingsContainer.removeEventListener("change", handleTimeInputEvent);
			}
			enabledCheckbox.removeEventListener("input", update);
		},
		{ once: true },
	);

	update();
	enabledCheckbox.addEventListener("input", update);
}

function setupSaveHint(options: { formId: string }) {
	const saveHintId = `${options.formId}-scheduled-notifications-save-hint`;
	const hint = document.getElementById(saveHintId);
	if (!(hint instanceof HTMLElement)) {
		return;
	}

	const formElement = document.getElementById(options.formId);
	if (!(formElement instanceof HTMLFormElement)) {
		return;
	}
	const form = formElement;

	const enabledCheckbox = form.querySelector<HTMLInputElement>(
		"#daily_digest_enabled",
	);
	if (!enabledCheckbox) {
		return;
	}
	const enabledCheckboxEl: HTMLInputElement = enabledCheckbox;

	function getTimeInput() {
		return form.querySelector<HTMLInputElement>(
			'input[name="daily_digest_notification_time"]',
		);
	}

	let timeInput = getTimeInput();
	let initialTime = "";
	if (timeInput instanceof HTMLInputElement) {
		initialTime = timeInput.value;
	}

	const initial = {
		enabled: enabledCheckboxEl.checked,
		time: initialTime,
	};

	const update = () => {
		timeInput = getTimeInput();
		const currentTime =
			timeInput instanceof HTMLInputElement ? timeInput.value : "";

		const isDirty =
			enabledCheckboxEl.checked !== initial.enabled ||
			currentTime !== initial.time;

		hint.classList.toggle("hidden", !isDirty);
	};

	update();
	enabledCheckboxEl.addEventListener("input", update);

	const settingsContainer = form.querySelector<HTMLElement>(
		"#daily-digest-settings",
	);
	const handleTimeChange = (event: Event) => {
		const target = event.target;
		if (
			target instanceof HTMLInputElement &&
			target.name === "daily_digest_notification_time"
		) {
			update();
		}
	};
	if (settingsContainer instanceof HTMLElement) {
		settingsContainer.addEventListener("input", handleTimeChange);
		settingsContainer.addEventListener("change", handleTimeChange);
	}

	const cleanup = () => {
		enabledCheckboxEl.removeEventListener("input", update);
		if (settingsContainer instanceof HTMLElement) {
			settingsContainer.removeEventListener("input", handleTimeChange);
			settingsContainer.removeEventListener("change", handleTimeChange);
		}
		window.removeEventListener("pagehide", cleanup);
	};

	window.addEventListener("pagehide", cleanup, { once: true });
}

export function setupScheduledNotifications(
	options: ScheduledNotificationsOptions,
) {
	if (document.readyState === "loading") {
		document.addEventListener(
			"DOMContentLoaded",
			() => {
				setupDailyDigestUI(options);
				setupSaveHint({ formId: options.formId });
			},
			{ once: true },
		);
		return;
	}

	setupDailyDigestUI(options);
	setupSaveHint({ formId: options.formId });
}
