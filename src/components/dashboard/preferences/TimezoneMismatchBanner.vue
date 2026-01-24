<!--
	This component uses v-if="isClient" which renders nothing on the server but content on the client.
	To avoid SSR hydration mismatches, this component must be used within a parent component that
	has client:load or client:only directive (e.g., DashboardPanels with client:load).
-->
<template>
	<div
		v-if="isClient"
		ref="bannerRef"
		id="timezone-mismatch-banner"
		class="rounded-lg border border-yellow-200 bg-yellow-50 p-4 text-yellow-900"
		:class="{ hidden: !isVisible }"
		role="alert"
	>
		<div class="space-y-3">
			<div>
				<p class="font-medium">
					We detected your timezone is
					<span ref="detectedSpanRef" id="detected-timezone" class="font-mono"></span>,
					but your account is set to
					<span ref="savedSpanRef" id="saved-timezone" class="font-mono"></span>.
				</p>
				<p class="text-sm text-yellow-800 mt-1">
					Would you like to update your default timezone?
				</p>
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<form method="POST" action="/api/preferences/timezone">
					<input
						ref="timezoneInputRef"
						type="hidden"
						name="timezone"
						id="timezone-update-value"
						:value="detectedTimezone"
					/>
					<button
						type="submit"
						class="px-3 py-1.5 bg-yellow-600 text-white rounded-md hover:bg-yellow-700 transition-colors cursor-pointer"
					>
						Update timezone
					</button>
				</form>
				<button
					type="button"
					@click="handleDismiss"
					class="px-3 py-1.5 bg-white border border-yellow-300 text-yellow-900 rounded-md hover:bg-yellow-100 transition-colors cursor-pointer"
				>
					Not now
				</button>
				<button
					type="button"
					@click="handleDismissPermanently"
					class="px-3 py-1.5 bg-white border border-yellow-300 text-yellow-900 rounded-md hover:bg-yellow-100 transition-colors cursor-pointer"
				>
					Don't ask me again
				</button>
			</div>
		</div>
	</div>
</template>

<script lang="ts" setup>
import { DateTime } from "luxon";
import { ref, toRefs, watch } from "vue";

import { rootLogger } from "../../../lib/logging";

interface Props {
	isClient: boolean;
	savedTimezone: string;
	allowedTimezones: string[];
	dismissTimezoneMismatchPrompts: boolean;
	savedPreferences?: {
		email_notifications_enabled: boolean;
		sms_notifications_enabled: boolean;
		sms_opted_out: boolean;
		phone_verified: boolean;
		timezone: string;
		daily_digest_enabled: boolean;
		daily_digest_notification_time: number;
		next_send_at: string | null;
		dismiss_timezone_mismatch_prompts: boolean;
	} | null;
}

const props = defineProps<Props>();
const { allowedTimezones } = toRefs(props);

const localSavedTimezone = ref(props.savedTimezone);
const localDismissTimezoneMismatchPrompts = ref(props.dismissTimezoneMismatchPrompts);

const bannerRef = ref<HTMLElement | null>(null);
const detectedSpanRef = ref<HTMLElement | null>(null);
const savedSpanRef = ref<HTMLElement | null>(null);
const timezoneInputRef = ref<HTMLInputElement | null>(null);
const isVisible = ref(false);
const detectedTimezone = ref<string>("");

const detected = DateTime.local().zoneName ?? "";

function getDismissalKey(savedTimezone: string, detectedTimezone: string): string {
	return `timezone_mismatch_banner_dismissed:${savedTimezone}:${detectedTimezone}`;
}

function isDismissed(savedTimezone: string, detectedTimezone: string): boolean {
	const dismissalKey = getDismissalKey(savedTimezone, detectedTimezone);
	try {
		return sessionStorage.getItem(dismissalKey) === "1";
	} catch {
		return false;
	}
}

function setDismissed(savedTimezone: string, detectedTimezone: string): void {
	const dismissalKey = getDismissalKey(savedTimezone, detectedTimezone);
	try {
		sessionStorage.setItem(dismissalKey, "1");
	} catch {
		// Ignore sessionStorage errors (SecurityError / QuotaExceededError)
	}
}

function shouldShowBanner(
	detected: string,
	savedTimezone: string,
	allowedTimezones: string[],
	dismissTimezoneMismatchPrompts: boolean,
): boolean {
	if (!detected) {
		return false;
	}

	const allowedTimezoneSet = new Set(allowedTimezones);
	if (!allowedTimezoneSet.has(detected)) {
		return false;
	}

	if (dismissTimezoneMismatchPrompts) {
		return false;
	}

	if (!savedTimezone || detected === savedTimezone) {
		return false;
	}

	if (isDismissed(savedTimezone, detected)) {
		return false;
	}

	return true;
}

function updateVisibility() {
	if (!detected) {
		isVisible.value = false;
		detectedTimezone.value = "";
		return;
	}

	detectedTimezone.value = detected;

	const allowedTimezoneSet = new Set(allowedTimezones.value);
	if (!allowedTimezoneSet.has(detected)) {
		isVisible.value = false;
		return;
	}

	const shouldShow = shouldShowBanner(
		detected,
		localSavedTimezone.value,
		allowedTimezones.value,
		localDismissTimezoneMismatchPrompts.value,
	);

	if (shouldShow) {
		if (detectedSpanRef.value) {
			detectedSpanRef.value.textContent = detected;
		}
		if (savedSpanRef.value) {
			savedSpanRef.value.textContent = localSavedTimezone.value;
		}
		if (timezoneInputRef.value) {
			timezoneInputRef.value.value = detected;
		}
		if (bannerRef.value) {
			bannerRef.value.dataset.savedTimezone = localSavedTimezone.value;
		}
		isVisible.value = true;
	} else {
		isVisible.value = false;
	}
}

function handleDismiss() {
	const currentSavedTimezone =
		bannerRef.value?.dataset.savedTimezone ?? localSavedTimezone.value;
	setDismissed(currentSavedTimezone, detected);
	isVisible.value = false;
}

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
			window.alert("Failed to dismiss banner. Please try again.");
			return;
		}

		if (bannerRef.value) {
			bannerRef.value.dataset.dismissTimezoneMismatchPrompts = "true";
		}
		localDismissTimezoneMismatchPrompts.value = true;
		isVisible.value = false;
	} catch (error) {
		rootLogger.error(
			"Failed to dismiss timezone banner permanently",
			undefined,
			error,
		);
		window.alert("Failed to dismiss banner. Please try again.");
	}
}

watch(
	() => props.savedTimezone,
	(newValue) => {
		localSavedTimezone.value = newValue;
	},
	{ immediate: true },
);

watch(
	() => props.dismissTimezoneMismatchPrompts,
	(newValue) => {
		localDismissTimezoneMismatchPrompts.value = newValue;
	},
	{ immediate: true },
);

watch(
	() => props.savedPreferences,
	(preferences) => {
		if (!preferences) {
			return;
		}

		if (typeof preferences.timezone === "string") {
			localSavedTimezone.value = preferences.timezone;
		}
		if (typeof preferences.dismiss_timezone_mismatch_prompts === "boolean") {
			localDismissTimezoneMismatchPrompts.value =
				preferences.dismiss_timezone_mismatch_prompts;
		}
	},
	{ immediate: true },
);

watch(
	[localSavedTimezone, allowedTimezones, localDismissTimezoneMismatchPrompts, bannerRef, detectedSpanRef, savedSpanRef, timezoneInputRef],
	() => {
		updateVisibility();
	},
	{ immediate: true },
);

</script>
