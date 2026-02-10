<template>
	<section
		class="card"
		aria-labelledby="timezone-heading"
	>
		<div :class="`card-accent ${CARD_GRADIENT_ACCENTS.gray}`"></div>
		<div class="card-body">
			<div class="flex items-center gap-3 mb-2">
				<div class="flex items-center justify-center w-10 h-10 rounded-lg bg-gray-100">
					<GlobeAltIcon class="size-5 text-gray-600" aria-hidden="true" />
				</div>
				<h2 id="timezone-heading" class="text-2xl font-bold text-gray-900">Timezone</h2>
			</div>
			<p class="text-gray-600 text-sm mb-6">
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

			<div class="space-y-6" role="group" aria-label="Timezone settings">
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
					:saved-notification-preferences="savedNotificationPreferences"
					@timezone-updated="handleTimezoneUpdated"
					@notification-preferences-updated="handleNotificationPreferencesUpdated"
				/>
			</div>
		</div>
	</section>
</template>

<script lang="ts" setup>
import { DateTime } from "luxon";
import { onMounted, ref, toRefs, watch } from "vue";

import GlobeAltIcon from "../../icons/globe-alt.svg?component";
import { CARD_GRADIENT_ACCENTS, DEFAULT_TIMEZONE } from "../../lib/constants";
import type { NotificationPreferencesSnapshot, User } from "../../lib/db";
import { rootLogger } from "../../lib/logging";
import {
	fetchCurrentNotificationPreferences,
	updateNotificationTimezonePreference,
} from "../../lib/notification-preferences/client";
import type { TimezoneOption } from "../../lib/time/cache";
import TimezoneMismatchBanner from "../notification-preferences/TimezoneMismatchBanner.vue";
import TimezoneSelect from "../notification-preferences/TimezoneSelect.vue";
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

function buildSavedNotificationPreferences(
	sourceUser: User,
): NotificationPreferencesSnapshot {
	return {
		email_notifications_enabled: sourceUser.email_notifications_enabled,
		sms_notifications_enabled: sourceUser.sms_notifications_enabled,
		sms_opted_out: sourceUser.sms_opted_out,
		phone_verified: sourceUser.phone_verified,
		timezone: sourceUser.timezone,
		scheduled_update_times:
			sourceUser.scheduled_update_times,
		next_send_at: sourceUser.next_send_at,
		dismiss_timezone_mismatch_prompts:
			sourceUser.dismiss_timezone_mismatch_prompts,
	};
}

const savedNotificationPreferences =
	ref<NotificationPreferencesSnapshot | null>(
		buildSavedNotificationPreferences(user.value),
	);

const selectedTimezone = ref(user.value.timezone);
const isClient = ref(false);
const isSaving = ref(false);
const pendingTimezoneSave = ref<string | null>(null);
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

async function refreshNotificationPreferences() {
	const prefs = await fetchCurrentNotificationPreferences();
	if (prefs) {
		savedNotificationPreferences.value = prefs;
	}
}

async function saveTimezone(nextTimezone: string) {
	if (!nextTimezone) {
		return;
	}

	statusMessage.value = "Saving timezone\u2026";
	statusTone.value = "info";
	isSaving.value = true;

	try {
		const prefs = await updateNotificationTimezonePreference(nextTimezone);
		if (!prefs) {
			statusMessage.value = "Failed to update timezone. Please try again.";
			statusTone.value = "error";
			return;
		}

		statusMessage.value = "Timezone updated.";
		statusTone.value = "success";
		savedNotificationPreferences.value = savedNotificationPreferences.value
			? {
					...savedNotificationPreferences.value,
					timezone: prefs.timezone ?? nextTimezone,
					...(prefs.next_send_at !== undefined && {
						next_send_at: prefs.next_send_at,
					}),
				}
			: buildSavedNotificationPreferences({
					...user.value,
					timezone: prefs.timezone ?? nextTimezone,
					...(prefs.next_send_at !== undefined && {
						next_send_at: prefs.next_send_at,
					}),
				});
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
		const next = pendingTimezoneSave.value;
		if (next != null) {
			pendingTimezoneSave.value = null;
			void saveTimezone(next);
		}
	}
}

function handleTimezoneChange() {
	if (timezoneLoadError.value) {
		return;
	}
	if (isSaving.value) {
		pendingTimezoneSave.value = selectedTimezone.value;
		return;
	}
	void saveTimezone(selectedTimezone.value);
}

function handleTimezoneUpdated(newTimezone: string) {
	selectedTimezone.value = newTimezone;
	statusMessage.value = "Timezone updated.";
	statusTone.value = "success";
	savedNotificationPreferences.value = savedNotificationPreferences.value
		? { ...savedNotificationPreferences.value, timezone: newTimezone }
		: buildSavedNotificationPreferences({ ...user.value, timezone: newTimezone });
}

function handleNotificationPreferencesUpdated() {
	void refreshNotificationPreferences();
}

watch(timezones, () => {
	resolveDefaultTimezone();
});

onMounted(() => {
	isClient.value = true;
	resolveDefaultTimezone();
});
</script>
