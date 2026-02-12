<!--
	This component uses v-if="isClient" which renders nothing on the server but content on the client.
	To avoid SSR hydration mismatches, this component must be used within a parent component that
	has client:load or client:only directive.
-->
<template>
	<StatusMessage v-if="isClient && isVisible" tone="warning">
		<div class="space-y-3">
			<div>
				<p class="font-medium">
					We detected your timezone is
					<span class="font-mono">{{ detectedTimezone }}</span>,
					but your account is set to
					<span class="font-mono">{{ savedTimezoneValue }}</span>.
				</p>
				<p class="text-sm mt-1">
					Would you like to update your default timezone?
				</p>
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<form @submit.prevent="handleUpdateTimezone">
					<input type="hidden" name="timezone" :value="detectedTimezone" />
					<button
						type="submit"
						class="btn btn-sm btn-warning"
					>
						Update timezone
					</button>
				</form>
				<button
					type="button"
					@click="handleDismiss"
					class="btn btn-sm btn-warning-outline"
				>
					Not now
				</button>
				<button
					type="button"
					@click="handleDismissPermanently"
					class="btn btn-sm btn-warning-outline"
				>
					Don't ask me again
				</button>
			</div>
			<p v-if="errorMessage" class="text-sm text-error-text">
				{{ errorMessage }}
			</p>
		</div>
	</StatusMessage>
</template>

<script lang="ts" setup>
import { DateTime } from "luxon";
import { computed, ref, toRefs, watch } from "vue";
import { updateNotificationTimezonePreference } from "../../lib/api/notification-preferences";
import {
	isUnauthorizedResponse,
	redirectToSignIn,
} from "../../lib/auth/session-expired";
import type { NotificationPreferencesSnapshot } from "../../lib/db";
import { rootLogger } from "../../lib/logging";
import StatusMessage from "../StatusMessage.vue";

interface Props {
	isClient: boolean;
	savedTimezone: string;
	allowedTimezones: string[];
	dismissTimezoneMismatchPrompts: boolean;
	savedNotificationPreferences?: NotificationPreferencesSnapshot | null;
}

const props = defineProps<Props>();
const {
	allowedTimezones,
	dismissTimezoneMismatchPrompts,
	savedNotificationPreferences,
	savedTimezone,
} = toRefs(props);

const emit = defineEmits<{
	(event: "timezone-updated", value: string): void;
	(event: "notification-preferences-updated"): void;
}>();

const detectedTimezone = computed(() => DateTime.local().zoneName ?? "");
const savedTimezoneValue = computed(() =>
	savedNotificationPreferences.value
		? savedNotificationPreferences.value.timezone
		: savedTimezone.value,
);
const dismissPromptsValue = computed(() =>
	savedNotificationPreferences.value
		? savedNotificationPreferences.value.dismiss_timezone_mismatch_prompts
		: dismissTimezoneMismatchPrompts.value,
);

const dismissedForSession = ref(false);
const errorMessage = ref<string | null>(null);

function getDismissalKey(
	savedTimezone: string,
	detectedTimezone: string,
): string {
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

const allowedTimezoneSet = computed(() => new Set(allowedTimezones.value));

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
	if (dismissPromptsValue.value || permanentlyDismissed.value) {
		return false;
	}
	if (
		!savedTimezoneValue.value ||
		detectedTimezone.value === savedTimezoneValue.value
	) {
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
		const prefs = await updateNotificationTimezonePreference(
			detectedTimezone.value,
		);
		if (!prefs) {
			errorMessage.value = "Failed to update timezone. Please try again.";
			return;
		}

		dismissedForSession.value = true;
		emit("timezone-updated", detectedTimezone.value);
		emit("notification-preferences-updated");
	} catch (error) {
		rootLogger.error(
			"Failed to update timezone from banner",
			{
				action: "update_notification_preferences_timezone_from_banner",
				detectedTimezone: detectedTimezone.value,
			},
			error,
		);
		errorMessage.value = "Failed to update timezone. Please try again.";
	}
}

const permanentlyDismissed = ref(false);

async function handleDismissPermanently() {
	errorMessage.value = null;
	try {
		const response = await fetch(
			"/api/notification-preferences/dismiss-timezone-banner",
			{
				method: "POST",
				credentials: "same-origin",
				headers: { Accept: "application/json" },
				signal: AbortSignal.timeout(10_000),
			},
		);

		if (!response.ok) {
			if (isUnauthorizedResponse(response)) {
				redirectToSignIn();
				return;
			}
			rootLogger.error("Failed to dismiss timezone banner permanently", {
				action: "dismiss_timezone_banner_permanently",
				status: response.status,
			});
			errorMessage.value = "Failed to dismiss banner. Please try again.";
			return;
		}

		permanentlyDismissed.value = true;
		dismissedForSession.value = true;
		emit("notification-preferences-updated");
	} catch (error) {
		rootLogger.error(
			"Failed to dismiss timezone banner permanently",
			{ action: "dismiss_timezone_banner_permanently" },
			error,
		);
		errorMessage.value = "Failed to dismiss banner. Please try again.";
	}
}

watch(dismissalKey, () => {
	if (!permanentlyDismissed.value) {
		dismissedForSession.value = false;
	}
});
</script>
