<!--
	This component uses v-if="isClient" which renders nothing on the server but content on the client.
	To avoid SSR hydration mismatches, this component must be used within a parent component that
	has client:load or client:only directive (e.g., DashboardPanels with client:load).
-->
<template>
	<div
		v-if="isClient && isVisible"
		class="rounded-lg border border-yellow-200 bg-yellow-50 p-4 text-yellow-900"
		role="alert"
	>
		<div class="space-y-3">
			<div>
				<p class="font-medium">
					We detected your timezone is
					<span class="font-mono">{{ detectedTimezone }}</span>,
					but your account is set to
					<span class="font-mono">{{ savedTimezoneValue }}</span>.
				</p>
				<p class="text-sm text-yellow-800 mt-1">
					Would you like to update your default timezone?
				</p>
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<form @submit.prevent="handleUpdateTimezone">
					<input type="hidden" name="timezone" :value="detectedTimezone" />
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
			<p v-if="errorMessage" class="text-sm text-yellow-800">
				{{ errorMessage }}
			</p>
		</div>
	</div>
</template>

<script lang="ts" setup>
import { DateTime } from "luxon";
import { computed, ref, toRefs, watch } from "vue";

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
const { allowedTimezones, dismissTimezoneMismatchPrompts, savedPreferences, savedTimezone } =
	toRefs(props);

const detectedTimezone = computed(() => DateTime.local().zoneName ?? "");
const savedTimezoneValue = computed(
	() => savedPreferences.value?.timezone ?? savedTimezone.value,
);
const dismissPromptsValue = computed(
	() =>
		savedPreferences.value?.dismiss_timezone_mismatch_prompts ??
		dismissTimezoneMismatchPrompts.value,
);

const dismissedForSession = ref(false);
const errorMessage = ref<string | null>(null);

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

const allowedTimezoneSet = computed(
	() => new Set(allowedTimezones.value),
);

const dismissalKey = computed(() => {
	if (!savedTimezoneValue.value || !detectedTimezone.value) {
		return null;
	}
	return getDismissalKey(savedTimezoneValue.value, detectedTimezone.value);
});

const isVisible = computed(() => {
	if (!props.isClient) {
		return false;
	}
	if (!detectedTimezone.value) {
		return false;
	}
	if (!allowedTimezoneSet.value.has(detectedTimezone.value)) {
		return false;
	}
	if (dismissPromptsValue.value) {
		return false;
	}
	if (!savedTimezoneValue.value || detectedTimezone.value === savedTimezoneValue.value) {
		return false;
	}
	if (dismissedForSession.value) {
		return false;
	}
	return !isDismissed(savedTimezoneValue.value, detectedTimezone.value);
});

function handleDismiss() {
	if (!savedTimezoneValue.value || !detectedTimezone.value) {
		return;
	}
	setDismissed(savedTimezoneValue.value, detectedTimezone.value);
	dismissedForSession.value = true;
	errorMessage.value = null;
}

async function handleUpdateTimezone() {
	if (!detectedTimezone.value) {
		return;
	}
	errorMessage.value = null;

	try {
		const formData = new FormData();
		formData.set("timezone", detectedTimezone.value);
		const response = await fetch("/api/preferences/timezone", {
			method: "POST",
			body: formData,
			credentials: "same-origin",
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(10_000),
		});

		if (response.redirected) {
			window.location.assign(response.url);
			return;
		}

		if (!response.ok) {
			errorMessage.value = "Failed to update timezone. Please try again.";
			return;
		}

		dismissedForSession.value = true;
	} catch (error) {
		rootLogger.error("Failed to update timezone from banner", undefined, error);
		errorMessage.value = "Failed to update timezone. Please try again.";
	}
}

async function handleDismissPermanently() {
	errorMessage.value = null;
	try {
		const response = await fetch("/api/preferences/dismiss-timezone-banner", {
			method: "POST",
			credentials: "same-origin",
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(10_000),
		});

		if (!response.ok) {
			rootLogger.error("Failed to dismiss timezone banner permanently");
			errorMessage.value = "Failed to dismiss banner. Please try again.";
			return;
		}

		dismissedForSession.value = true;
	} catch (error) {
		rootLogger.error(
			"Failed to dismiss timezone banner permanently",
			undefined,
			error,
		);
		errorMessage.value = "Failed to dismiss banner. Please try again.";
	}
}

watch(dismissalKey, () => {
	dismissedForSession.value = false;
});

</script>
