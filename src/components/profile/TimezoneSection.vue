<template>
	<div class="bg-white rounded-lg shadow-md border border-gray-200 overflow-hidden">
		<div :class="`h-1 ${CARD_GRADIENT_ACCENTS.gray}`"></div>
		<div class="p-6">
			<h2 class="text-2xl font-bold text-gray-900 mb-2">Timezone</h2>
			<p class="text-gray-600 text-sm mb-4">
				Set the timezone used for scheduling notifications.
			</p>

			<StatusMessage v-if="timezoneLoadError" tone="warning" class="mb-4">
				Unable to load all timezone options. Only your current timezone is
				available. Please refresh the page to try again.
			</StatusMessage>

			<StatusMessage
				v-if="statusMessage"
				:tone="statusTone"
				class="mb-4"
			>
				{{ statusMessage }}
			</StatusMessage>

			<div class="space-y-6">
				<TimezoneSelect
					id="profile-timezone"
					v-model="selectedTimezone"
					:timezones="timezones"
					:disabled="timezoneLoadError || isSaving"
					@change="handleTimezoneChange"
				/>

				<TimezoneMismatchBanner
					:is-client="isClient"
					:saved-timezone="user.timezone"
					:allowed-timezones="timezones.map((tz) => tz.value)"
					:dismiss-timezone-mismatch-prompts="user.dismiss_timezone_mismatch_prompts"
					:saved-preferences="savedPreferences"
					@timezone-updated="handleTimezoneUpdated"
					@preferences-updated="handlePreferencesUpdated"
				/>
			</div>
		</div>
	</div>
</template>

<script lang="ts" setup>
import { DateTime } from "luxon";
import { onMounted, ref, toRefs, watch } from "vue";

import { CARD_GRADIENT_ACCENTS, DEFAULT_TIMEZONE } from "../../lib/constants";
import type { User } from "../../lib/db";
import { rootLogger } from "../../lib/logging";
import type { TimezoneOption } from "../../lib/time/cache";
import TimezoneMismatchBanner from "../preferences/TimezoneMismatchBanner.vue";
import TimezoneSelect from "../preferences/TimezoneSelect.vue";
import StatusMessage from "../StatusMessage.vue";

interface Props {
	user: User;
	timezones: TimezoneOption[];
	timezoneLoadError?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	timezoneLoadError: false,
});

const { user, timezones, timezoneLoadError } = toRefs(props);

type PreferencesSnapshot = {
	email_notifications_enabled: boolean;
	sms_notifications_enabled: boolean;
	sms_opted_out: boolean;
	phone_verified: boolean;
	timezone: string;
	daily_digest_enabled: boolean;
	daily_digest_notification_time: number;
	next_send_at: string | null;
	dismiss_timezone_mismatch_prompts: boolean;
};

function buildSavedPreferences(sourceUser: User): PreferencesSnapshot {
	return {
		email_notifications_enabled: sourceUser.email_notifications_enabled,
		sms_notifications_enabled: sourceUser.sms_notifications_enabled,
		sms_opted_out: sourceUser.sms_opted_out,
		phone_verified: sourceUser.phone_verified,
		timezone: sourceUser.timezone,
		daily_digest_enabled: sourceUser.daily_digest_enabled,
		daily_digest_notification_time: sourceUser.daily_digest_notification_time,
		next_send_at: sourceUser.next_send_at,
		dismiss_timezone_mismatch_prompts:
			sourceUser.dismiss_timezone_mismatch_prompts,
	};
}

const savedPreferences = ref<PreferencesSnapshot | null>(
	buildSavedPreferences(user.value),
);

const selectedTimezone = ref(user.value.timezone);
const isClient = ref(false);
const isSaving = ref(false);
const statusMessage = ref<string | null>(null);
const statusTone = ref<"success" | "error" | "warning" | "info">("info");

function resolveDefaultTimezone() {
	const knownValues = new Set(
		timezones.value.map((timezone) => timezone.value),
	);
	const selectedValue = selectedTimezone.value;
	if (selectedValue && knownValues.has(selectedValue)) {
		return;
	}

	const detected = DateTime.local().zoneName ?? "";
	if (detected && knownValues.has(detected)) {
		selectedTimezone.value = detected;
		return;
	}

	if (DEFAULT_TIMEZONE && knownValues.has(DEFAULT_TIMEZONE)) {
		selectedTimezone.value = DEFAULT_TIMEZONE;
	}
}

async function refreshPreferences() {
	try {
		const response = await fetch("/api/preferences/current", {
			method: "GET",
			credentials: "same-origin",
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(10_000),
		});

		if (!response.ok) {
			return;
		}

		const payload = (await response.json()) as {
			ok: boolean;
			preferences?: PreferencesSnapshot;
		};
		if (payload.preferences) {
			savedPreferences.value = payload.preferences;
		}
	} catch (error) {
		rootLogger.warn("Failed to refresh preferences", {
			action: "refresh_preferences",
			error,
		});
	}
}

async function saveTimezone(nextTimezone: string) {
	if (!nextTimezone) {
		return;
	}

	statusMessage.value = "Saving timezone...";
	statusTone.value = "info";
	isSaving.value = true;

	try {
		const formData = new FormData();
		formData.set("timezone", nextTimezone);
		const response = await fetch("/api/preferences/timezone", {
			method: "POST",
			body: formData,
			credentials: "same-origin",
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(10_000),
		});

		if (!response.ok) {
			statusMessage.value = "Failed to update timezone. Please try again.";
			statusTone.value = "error";
			return;
		}

		const payload = (await response.json()) as { ok: boolean };
		if (!payload.ok) {
			statusMessage.value = "Failed to update timezone. Please try again.";
			statusTone.value = "error";
			return;
		}

		statusMessage.value = "Timezone updated.";
		statusTone.value = "success";
		savedPreferences.value = savedPreferences.value
			? { ...savedPreferences.value, timezone: nextTimezone }
			: buildSavedPreferences({ ...user.value, timezone: nextTimezone });
	} catch (error) {
		rootLogger.error(
			"Failed to update timezone from profile",
			{
				action: "update_timezone_from_profile",
				timezone: nextTimezone,
			},
			error,
		);
		statusMessage.value = "Failed to update timezone. Please try again.";
		statusTone.value = "error";
	} finally {
		isSaving.value = false;
	}
}

function handleTimezoneChange() {
	if (timezoneLoadError.value || isSaving.value) {
		return;
	}
	void saveTimezone(selectedTimezone.value);
}

function handleTimezoneUpdated(newTimezone: string) {
	selectedTimezone.value = newTimezone;
	statusMessage.value = "Timezone updated.";
	statusTone.value = "success";
	savedPreferences.value = savedPreferences.value
		? { ...savedPreferences.value, timezone: newTimezone }
		: buildSavedPreferences({ ...user.value, timezone: newTimezone });
}

function handlePreferencesUpdated() {
	void refreshPreferences();
}

watch(timezones, () => {
	resolveDefaultTimezone();
});

onMounted(() => {
	isClient.value = true;
	resolveDefaultTimezone();
});
</script>
