<template>
	<section
		class="card"
		aria-labelledby="timezone-heading"
		:data-hydrated="isClient || undefined"
	>
		<div :class="`card-accent ${CARD_GRADIENT_ACCENTS.gray}`"></div>
		<div class="card-body">
			<div class="flex items-center gap-3 mb-2">
				<div class="flex items-center justify-center w-10 h-10 rounded-lg bg-surface-active">
					<GlobeAltIcon class="size-5 text-body-secondary" aria-hidden="true" />
				</div>
				<h2 id="timezone-heading" class="text-2xl font-bold text-heading">Timezone</h2>
			</div>
			<p class="text-body-secondary text-sm mb-6">
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
import {
	fetchCurrentNotificationPreferences,
	updateNotificationTimezonePreference,
} from "../../lib/api/notification-preferences";
import { CARD_GRADIENT_ACCENTS, DEFAULT_TIMEZONE } from "../../lib/constants";
import type { NotificationPreferencesSnapshot, User } from "../../lib/db";
import { rootLogger } from "../../lib/logging";
import type { TimezoneOption } from "../../lib/time/types";
import StatusMessage from "../StatusMessage.vue";
import TimezoneMismatchBanner from "./TimezoneMismatchBanner.vue";
import TimezoneSelect from "./TimezoneSelect.vue";

interface Props {
	user: User;
	timezones: TimezoneOption[];
	timezoneLoadError?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	timezoneLoadError: false,
});

const { user, timezones, timezoneLoadError } = toRefs(props);

/**
 * Create a stable snapshot of notification preferences relevant to timezone mismatch prompts.
 *
 * This is used for comparison/UX in `TimezoneMismatchBanner`.
 */
function buildSavedNotificationPreferences(
	sourceUser: User,
): NotificationPreferencesSnapshot {
	const marketScheduledAssetPriceTimes = sourceUser.market_scheduled_asset_price_times;
	return {
		email_notifications_enabled: sourceUser.email_notifications_enabled,
		sms_opted_out: sourceUser.sms_opted_out,
		phone_verified: sourceUser.phone_verified,
		timezone: sourceUser.timezone,
		market_scheduled_asset_price_times: Array.isArray(marketScheduledAssetPriceTimes)
			? [...marketScheduledAssetPriceTimes]
			: marketScheduledAssetPriceTimes,
		market_scheduled_asset_price_next_send_at: sourceUser.market_scheduled_asset_price_next_send_at,
		dismiss_timezone_mismatch_prompts:
			sourceUser.dismiss_timezone_mismatch_prompts,
		market_scheduled_asset_price_enabled: sourceUser.market_scheduled_asset_price_enabled,
		daily_digest_time: sourceUser.daily_digest_time,
		daily_digest_next_send_at: sourceUser.daily_digest_next_send_at,
		daily_digest_include_news_email: sourceUser.daily_digest_include_news_email,
		daily_digest_include_rumors_email: sourceUser.daily_digest_include_rumors_email,
		market_scheduled_asset_price_include_email: sourceUser.market_scheduled_asset_price_include_email,
		market_scheduled_asset_price_include_sms: sourceUser.market_scheduled_asset_price_include_sms,
		asset_events_include_calendar_email: sourceUser.asset_events_include_calendar_email,
		asset_events_include_calendar_sms: sourceUser.asset_events_include_calendar_sms,
		asset_events_include_ipo_email: sourceUser.asset_events_include_ipo_email,
		asset_events_include_ipo_sms: sourceUser.asset_events_include_ipo_sms,
		asset_events_include_analyst_email: sourceUser.asset_events_include_analyst_email,
		asset_events_include_analyst_sms: sourceUser.asset_events_include_analyst_sms,
		asset_events_include_insider_email: sourceUser.asset_events_include_insider_email,
		asset_events_include_insider_sms: sourceUser.asset_events_include_insider_sms,
		asset_events_next_send_at: sourceUser.asset_events_next_send_at,
		asset_events_last_analyst_sent_month: sourceUser.asset_events_last_analyst_sent_month,
		market_asset_price_alerts_enabled: sourceUser.market_asset_price_alerts_enabled,
		market_asset_price_alerts_include_email: sourceUser.market_asset_price_alerts_include_email,
		market_asset_price_alerts_include_sms: sourceUser.market_asset_price_alerts_include_sms,
		market_asset_price_alert_onboarding_completed:
			sourceUser.market_asset_price_alert_onboarding_completed,
		market_asset_price_alert_risk_priority: sourceUser.market_asset_price_alert_risk_priority,
		market_asset_price_alert_market_context: sourceUser.market_asset_price_alert_market_context,
		market_asset_price_alert_move_size: sourceUser.market_asset_price_alert_move_size,
		market_asset_price_alert_follow_up_mode:
			sourceUser.market_asset_price_alert_follow_up_mode,
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

/**
 * Ensure `selectedTimezone` is set to a valid value available in the options list.
 *
 * Prefers: currently-selected (if valid) → detected local zone → app default → first available option.
 */
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
		return;
	}

	const fallback = timezones.value[0]?.value;
	if (fallback) {
		selectedTimezone.value = fallback;
	}
}

/** Fetch the user's current notification preferences snapshot for the mismatch banner. */
async function refreshNotificationPreferences() {
	try {
		const prefs = await fetchCurrentNotificationPreferences();
		if (prefs) {
			savedNotificationPreferences.value = prefs;
		}
	} catch (error) {
		rootLogger.error(
			"Failed to refresh notification preferences for timezone banner",
			{ action: "refresh_notification_preferences" },
			error,
		);
	}
}

/**
 * Persist timezone changes and update UI + cached snapshot.
 *
 * If a new change is requested while a save is in-flight, it is queued and saved next.
 */
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
			selectedTimezone.value =
				savedNotificationPreferences.value?.timezone ?? user.value.timezone;
			return;
		}

		const resolvedTimezone = prefs.timezone ?? nextTimezone;
		selectedTimezone.value = resolvedTimezone;
		statusMessage.value = "Timezone updated.";
		statusTone.value = "success";
		savedNotificationPreferences.value = savedNotificationPreferences.value
			? {
					...savedNotificationPreferences.value,
					timezone: resolvedTimezone,
					...(prefs.market_scheduled_asset_price_next_send_at !== undefined && {
						market_scheduled_asset_price_next_send_at: prefs.market_scheduled_asset_price_next_send_at,
					}),
					...(prefs.daily_digest_next_send_at !== undefined && {
						daily_digest_next_send_at: prefs.daily_digest_next_send_at,
					}),
					...(prefs.asset_events_next_send_at !== undefined && {
						asset_events_next_send_at: prefs.asset_events_next_send_at,
					}),
				}
			: buildSavedNotificationPreferences({
					...user.value,
					timezone: resolvedTimezone,
					...(prefs.market_scheduled_asset_price_next_send_at !== undefined && {
						market_scheduled_asset_price_next_send_at: prefs.market_scheduled_asset_price_next_send_at,
					}),
					...(prefs.daily_digest_next_send_at !== undefined && {
						daily_digest_next_send_at: prefs.daily_digest_next_send_at,
					}),
					...(prefs.asset_events_next_send_at !== undefined && {
						asset_events_next_send_at: prefs.asset_events_next_send_at,
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
		selectedTimezone.value =
			savedNotificationPreferences.value?.timezone ?? user.value.timezone;
	} finally {
		isSaving.value = false;
		const next = pendingTimezoneSave.value;
		if (next != null) {
			pendingTimezoneSave.value = null;
			void saveTimezone(next);
		}
	}
}

/** Handle timezone selection changes initiated from `TimezoneSelect`. */
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

/** Handle timezone updates emitted by `TimezoneMismatchBanner`. */
function handleTimezoneUpdated(newTimezone: string) {
	selectedTimezone.value = newTimezone;
	if (isSaving.value) {
		pendingTimezoneSave.value = newTimezone;
	}
	statusMessage.value = "Timezone updated.";
	statusTone.value = "success";
	savedNotificationPreferences.value = savedNotificationPreferences.value
		? { ...savedNotificationPreferences.value, timezone: newTimezone }
		: buildSavedNotificationPreferences({ ...user.value, timezone: newTimezone });
}

/** Refresh mismatch banner preferences after it updates notification settings. */
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
