<template>
	<section class="card mb-6">
		<div :class="`h-1 ${CARD_GRADIENT_ACCENTS.success}`"></div>
		<div class="card-body">
			<header class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div class="min-w-0">
					<h2
						:id="DASHBOARD_SECTION_IDS.scheduled"
						class="text-xl sm:text-2xl font-bold text-gray-900"
					>
						Scheduled Notifications
					</h2>
					<p class="text-sm text-gray-600 mt-1 flex flex-wrap items-center gap-2">
						<span class="text-gray-700">
							Local time:
							<span class="font-medium text-gray-900">
								{{ currentTimeInTimezone ?? "—" }}
							</span>
						</span>
						<a
							href="/profile"
							class="link-primary rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
							aria-label="Change timezone in profile settings"
						>
							Change timezone
						</a>
					</p>
				</div>
			</header>

			<div v-if="allFlashMessages.length" class="space-y-2 mt-4">
				<StatusMessage
					v-for="(flash, index) in allFlashMessages"
					:key="index"
					:tone="flash.tone"
				>
					{{ flash.message }}
				</StatusMessage>
			</div>

			<DailyDigestControls
				v-model:enabled="dailyDigestEnabled"
				:dailyDigestTimes="dailyDigestTimes"
				:needsChannelSelection="needsChannelSelection"
				:timePickerDisabled="timePickerDisabled"
				:canAddTime="canAddTime"
				:saveDisabled="saveDisabled"
				:isSaving="isSaving ?? false"
				:countdownText="countdownText"
				@time-change="handleTimeChange"
				@add-time="handleAddTime"
				@remove-time="handleRemoveTime"
			>
				<template #setup>
					<SetupRequiredNotice
						:needsChannelSelection="needsChannelSelection"
						:needsPhoneVerification="needsPhoneVerification"
						:phoneVerificationSectionId="phoneVerificationSectionId"
					/>
				</template>
			</DailyDigestControls>
		</div>
	</section>

</template>

<script lang="ts" setup>
import { computed, ref, toRefs, watch } from "vue";
import {
	CARD_GRADIENT_ACCENTS,
	DASHBOARD_FORM_ID,
	DASHBOARD_SECTION_IDS,
	type FlashMessage,
} from "../../../../lib/constants";
import type { User } from "../../../../lib/db";
import {
	minutesToTimeInputValue,
	parseTimeToMinutes,
} from "../../../../lib/time/format";
import StatusMessage from "../../../StatusMessage.vue";
import DailyDigestControls from "./DailyDigestControls.vue";
import SetupRequiredNotice from "./SetupRequiredNotice.vue";
import { useScheduledDigestTiming } from "./scheduled-notifications-helpers";

interface Props {
	user: User;
	emailEnabled: boolean;
	smsEnabled: boolean;
	smsOptedOut: boolean;
	phoneVerified: boolean;
	onFormChanged?: () => void;
	isSaving?: boolean;
	flashMessages?: FlashMessage[];
	savedPreferences?: {
		next_send_at: string | null;
	} | null;
}

const props = withDefaults(defineProps<Props>(), {
	flashMessages: () => [],
});
const {
	user,
	emailEnabled,
	smsEnabled,
	smsOptedOut,
	phoneVerified,
	onFormChanged,
	flashMessages,
	isSaving,
} = toRefs(props);

const dailyDigestEnabled = ref(user.value.daily_digest_enabled);

const MAX_DAILY_DIGEST_MINUTES = 23 * 60 + 45;
const DIGEST_INCREMENT_MINUTES = 15;
const ADD_DIGEST_OFFSET_MINUTES = 180;

function normalizeDigestTimes(times: number[]): number[] {
	const filtered = times.filter(
		(value) =>
			Number.isFinite(value) &&
			value >= 0 &&
			value <= MAX_DAILY_DIGEST_MINUTES &&
			value % DIGEST_INCREMENT_MINUTES === 0,
	);
	return [...new Set(filtered)].sort((a, b) => a - b);
}

const dailyDigestTimesMinutes = ref<number[]>(
	normalizeDigestTimes(user.value.daily_digest_notification_times ?? []),
);

if (dailyDigestEnabled.value && dailyDigestTimesMinutes.value.length === 0) {
	dailyDigestTimesMinutes.value = [540];
}

const phoneVerificationSectionId = `${DASHBOARD_FORM_ID}-phone-verification-section`;

const dailyDigestTimes = computed(() =>
	dailyDigestTimesMinutes.value.map((value) => minutesToTimeInputValue(value)),
);

const timezone = computed(() => props.user.timezone ?? "");

const smsReady = computed(
	() => smsEnabled.value && !smsOptedOut.value && phoneVerified.value,
);
const hasNotificationChannel = computed(
	() => emailEnabled.value || smsReady.value,
);
const needsChannelSelection = computed(() => !hasNotificationChannel.value);
const needsPhoneVerification = computed(
	() => smsEnabled.value && !smsOptedOut.value && !phoneVerified.value,
);
const timePickerDisabled = computed(
	() => needsChannelSelection.value || !dailyDigestEnabled.value,
);
const canAddTime = computed(() => {
	if (timePickerDisabled.value) {
		return false;
	}
	const times = normalizeDigestTimes(dailyDigestTimesMinutes.value);
	if (times.length === 0) {
		return true;
	}
	const nextMinutes = times[times.length - 1] + ADD_DIGEST_OFFSET_MINUTES;
	return nextMinutes <= MAX_DAILY_DIGEST_MINUTES;
});

watch(
	() => user.value.daily_digest_enabled,
	(value) => {
		dailyDigestEnabled.value = value;
	},
);
watch(
	() => user.value.daily_digest_notification_times,
	(value) => {
		dailyDigestTimesMinutes.value = normalizeDigestTimes(value ?? []);
	},
);
// Only auto-enable daily digest when user gains their first channel (transition
// from no channel to has channel). Do not run on mount: that would overwrite
// a saved preference of daily_digest_enabled = false when they already have a channel.
watch(
	hasNotificationChannel,
	(hasChannel, previousHasChannel) => {
		if (previousHasChannel === false && hasChannel && !dailyDigestEnabled.value) {
			dailyDigestEnabled.value = true;
			onFormChanged.value?.();
		}
	},
);

const nextSendAt = computed(
	() =>
		props.savedPreferences?.next_send_at ?? props.user.next_send_at ?? null,
);
const allFlashMessages = flashMessages;
const { currentTimeInTimezone, countdownText } = useScheduledDigestTiming({
	timezone,
	dailyDigestEnabled,
	nextSendAtIso: nextSendAt,
	timeInputs: dailyDigestTimes,
});

watch(dailyDigestEnabled, () => {
	if (dailyDigestEnabled.value && dailyDigestTimesMinutes.value.length === 0) {
		dailyDigestTimesMinutes.value = [540];
	}
});

const baselineTimes = computed(() =>
	normalizeDigestTimes(user.value.daily_digest_notification_times ?? []),
);
const hasPendingScheduleChanges = computed(() => {
	if (dailyDigestEnabled.value !== user.value.daily_digest_enabled) {
		return true;
	}
	const currentTimes = normalizeDigestTimes(dailyDigestTimesMinutes.value);
	if (currentTimes.length !== baselineTimes.value.length) {
		return true;
	}
	return currentTimes.some(
		(value, index) => value !== baselineTimes.value[index],
	);
});
const saveDisabled = computed(
	() =>
		!hasPendingScheduleChanges.value ||
		needsChannelSelection.value ||
		Boolean(isSaving?.value),
);

function handleTimeChange(index: number, value: string) {
	const parsedMinutes = parseTimeToMinutes(value);
	if (parsedMinutes === null) {
		return;
	}
	const updated = [...dailyDigestTimesMinutes.value];
	updated[index] = parsedMinutes;
	dailyDigestTimesMinutes.value = normalizeDigestTimes(updated);
}

function handleAddTime() {
	if (!canAddTime.value) {
		return;
	}
	const times = normalizeDigestTimes(dailyDigestTimesMinutes.value);
	const baseTimes = times.length === 0 ? [540] : times;
	const nextMinutes =
		baseTimes[baseTimes.length - 1] + ADD_DIGEST_OFFSET_MINUTES;
	if (nextMinutes > MAX_DAILY_DIGEST_MINUTES) {
		return;
	}
	dailyDigestTimesMinutes.value = normalizeDigestTimes([
		...baseTimes,
		nextMinutes,
	]);
}

function handleRemoveTime(index: number) {
	if (dailyDigestTimesMinutes.value.length <= 1) {
		return;
	}
	const updated = [...dailyDigestTimesMinutes.value];
	updated.splice(index, 1);
	dailyDigestTimesMinutes.value = normalizeDigestTimes(updated);
}
</script>
