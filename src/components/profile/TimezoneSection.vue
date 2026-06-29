<template>
	<section
		class="card"
		aria-labelledby="timezone-heading"
		:data-hydrated="isHydrated || undefined"
	>
		<div class="card-accent card-accent-gray"></div>
		<div class="card-body">
			<div class="flex items-center gap-3 mb-2">
				<div class="flex items-center justify-center w-10 h-10 rounded-lg bg-surface-active">
					<GlobeAltIcon class="size-5 text-body-secondary" aria-hidden="true" />
				</div>
				<h2 id="timezone-heading" class="text-2xl font-bold text-heading">Timezone</h2>
			</div>
			<p class="text-body-secondary text-sm mb-2">
				Set the timezone used for scheduling notifications.
			</p>
			<p class="text-body-secondary text-sm mb-6">
				<strong>Note:</strong> Your scheduled price-update times are anchored to US market hours.
				Changing your timezone updates the displayed time only — it does not change when the
				notification fires.
			</p>

			<StatusMessage v-if="timezoneLoadError" tone="warning" class="mb-4">
				Unable to load all timezone options. Only your current timezone is
				available. Please refresh the page to try again.
			</StatusMessage>

			<!-- Persistent, static live region: always mounted with a fixed
			     politeness so a save-status change (success OR the silent error
			     revert) reliably announces. Only the visual tone varies inside. -->
			<div role="status" aria-live="polite" aria-atomic="true">
				<StatusMessage
					:message="statusMessage ?? ''"
					:tone="statusTone"
					:live="false"
					class="mb-4"
				/>
			</div>

			<div class="space-y-6" role="group" aria-label="Timezone settings">
				<TimezoneSelect
					id="profile-timezone"
					v-model="selectedTimezone"
					:timezones="timezones"
					:disabled="timezoneLoadError"
					@change="handleTimezoneChange"
				/>

				<TimezoneMismatchBanner
					:is-client="isHydrated"
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
import { fetchCurrentNotificationPreferences } from "../../lib/client/notification-preferences";
import { updateProfileTimezone } from "../../lib/client/profile-timezone";
import { DEFAULT_TIMEZONE } from "../../lib/constants";
import type { NotificationPreferencesSnapshot, User } from "../../lib/db";
import { createSaveSequencer, type SequencedResult } from "../../lib/forms/save-sequencer";
import { rootLogger } from "../../lib/logging";
import type { TimezoneOption } from "../../lib/types";
import { useHydrated } from "../composables/useHydrated";
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
		sms_notifications_enabled: sourceUser.sms_notifications_enabled,
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
		daily_notification_time: sourceUser.daily_notification_time,
		daily_notification_next_send_at: sourceUser.daily_notification_next_send_at,
		daily_digest_include_prices_email: sourceUser.daily_digest_include_prices_email,
		daily_digest_include_prices_sms: sourceUser.daily_digest_include_prices_sms,
		daily_digest_include_top_movers_email:
			sourceUser.daily_digest_include_top_movers_email,
		daily_digest_include_top_movers_sms:
			sourceUser.daily_digest_include_top_movers_sms,
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
		asset_events_last_analyst_sent_month: sourceUser.asset_events_last_analyst_sent_month,
		market_asset_price_alerts_enabled: sourceUser.market_asset_price_alerts_enabled,
		market_asset_price_alerts_include_email: sourceUser.market_asset_price_alerts_include_email,
		market_asset_price_alerts_include_sms: sourceUser.market_asset_price_alerts_include_sms,
		market_asset_price_alert_move_size: sourceUser.market_asset_price_alert_move_size,
		price_move_alerts_include_email: sourceUser.price_move_alerts_include_email,
		price_move_alerts_include_sms: sourceUser.price_move_alerts_include_sms,
		price_targets_include_email: sourceUser.price_targets_include_email,
		price_targets_include_sms: sourceUser.price_targets_include_sms,
	};
}

const savedNotificationPreferences =
	ref<NotificationPreferencesSnapshot | null>(
		buildSavedNotificationPreferences(user.value),
	);

const selectedTimezone = ref(user.value.timezone);
const isHydrated = useHydrated();
const statusMessage = ref<string | null>(null);
const statusTone = ref<"success" | "error" | "warning" | "info">("info");

// Last-write-wins: a newer selection aborts and supersedes the in-flight save,
// so a stale/out-of-order response can never reset the dropdown to an old value.
const sequencer = createSaveSequencer();

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

/** The last timezone the server acknowledged \u2014 the revert target when a save fails. */
function confirmedTimezone(): string {
	return savedNotificationPreferences.value?.timezone ?? user.value.timezone;
}

/** Programmatically reset the dropdown to its confirmed value and surface an error. */
function revertTimezone(message: string) {
	// Setting `selectedTimezone` does not dispatch the native `<select>` change
	// event, so this revert never re-triggers `handleTimezoneChange` \u2014 no
	// suppression flag needed.
	selectedTimezone.value = confirmedTimezone();
	statusMessage.value = message;
	statusTone.value = "error";
}

type TimezoneUpdateResult = Awaited<ReturnType<typeof updateProfileTimezone>>;

/**
 * Merge a resolved timezone and any server-recomputed scheduling fields onto a
 * base snapshot. Only `*_next_send_at` fields the server actually returned are
 * overwritten, so unchanged derived times are preserved.
 */
function mergeResolvedTimezone(
	base: NotificationPreferencesSnapshot,
	resolvedTimezone: string,
	prefs: NonNullable<TimezoneUpdateResult>,
): NotificationPreferencesSnapshot {
	return {
		...base,
		timezone: resolvedTimezone,
		...(prefs.market_scheduled_asset_price_next_send_at !== undefined && {
			market_scheduled_asset_price_next_send_at: prefs.market_scheduled_asset_price_next_send_at,
		}),
		...(prefs.daily_notification_next_send_at !== undefined && {
			daily_notification_next_send_at: prefs.daily_notification_next_send_at,
		}),
	};
}

/**
 * Persist timezone changes and update UI + cached snapshot.
 *
 * Each save runs through the sequencer: a newer selection supersedes (and aborts)
 * the in-flight request, and only the latest request's `applied` outcome is
 * committed \u2014 an out-of-order/stale response is dropped, so the dropdown can
 * never settle on a value the user has already moved past.
 */
async function saveTimezone(nextTimezone: string) {
	if (!nextTimezone) {
		return;
	}

	const intended = nextTimezone;
	statusMessage.value = "Saving timezone\u2026";
	statusTone.value = "info";

	let outcome: SequencedResult<TimezoneUpdateResult>;
	try {
		outcome = await sequencer.run((signal) => updateProfileTimezone(intended, signal));
	} catch (error) {
		// Only the latest request's genuine failure reaches here \u2014 superseded
		// saves resolve to "stale" instead of throwing.
		rootLogger.error(
			"Failed to update timezone from profile",
			{ action: "update_timezone_from_profile", timezone: intended },
			error,
		);
		revertTimezone("Failed to update timezone. Please try again.");
		return;
	}

	// A newer selection superseded this save \u2014 it owns the final state; do nothing.
	if (outcome.status !== "applied") return;

	const prefs = outcome.value;
	if (!prefs) {
		revertTimezone("Failed to update timezone. Please try again.");
		return;
	}

	const resolvedTimezone = prefs.timezone ?? intended;
	selectedTimezone.value = resolvedTimezone;
	statusMessage.value = "Timezone updated.";
	statusTone.value = "success";
	const base =
		savedNotificationPreferences.value ?? buildSavedNotificationPreferences(user.value);
	savedNotificationPreferences.value = mergeResolvedTimezone(base, resolvedTimezone, prefs);
}

/** Handle timezone selection changes initiated from `TimezoneSelect`. */
function handleTimezoneChange() {
	if (timezoneLoadError.value) {
		return;
	}
	void saveTimezone(selectedTimezone.value);
}

/** Handle timezone updates emitted by `TimezoneMismatchBanner`. */
function handleTimezoneUpdated(newTimezone: string) {
	// The banner persisted this timezone itself. Supersede any in-flight dropdown
	// save (claims the latest token and aborts it) so a stale dropdown response
	// can't clobber the banner's freshly-saved value.
	sequencer.supersede();
	selectedTimezone.value = newTimezone;
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
	resolveDefaultTimezone();
});
</script>
