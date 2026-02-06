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
					<p class="text-sm text-gray-600 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
						<span class="inline-flex items-center gap-1.5">
							<ClockIcon class="size-4 shrink-0 text-gray-500" aria-hidden="true" />
							<span class="text-gray-700">
								Local time:
								<span class="font-medium text-gray-900">
									{{ currentTimeInTimezone ?? "—" }}
								</span>
							</span>
						</span>
						<a
							href="/profile"
							class="inline-flex items-center gap-1 link-primary rounded-sm"
							aria-label="Change timezone in profile settings"
						>
							Change timezone
							<ArrowTopRightOnSquareIcon class="size-3.5 shrink-0" aria-hidden="true" />
						</a>
					</p>
				</div>
			</header>

			<div v-if="flashMessages.length" class="space-y-2 mt-4">
				<StatusMessage
					v-for="(flash, index) in flashMessages"
					:key="index"
					:tone="flash.tone"
				>
					{{ flash.message }}
				</StatusMessage>
			</div>

			<DailyDigestControls
				:enabled="dailyDigestEnabled"
				:dailyDigestTimes="dailyDigestTimes"
				:needsChannelSelection="needsChannelSelection"
				:timePickerDisabled="timePickerDisabled"
				:canAddTime="canAddTime"
				:countdownText="countdownText"
				@update:enabled="handleDailyDigestEnabledUpdate"
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
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import ArrowTopRightOnSquareIcon from "../../../../icons/arrow-top-right-on-square.svg?component";
import ClockIcon from "../../../../icons/clock.svg?component";
import {
	CARD_GRADIENT_ACCENTS,
	DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID,
	DASHBOARD_SECTION_IDS,
	DEFAULT_DAILY_DIGEST_TIME_MINUTES,
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
	phoneVerified: boolean;
	onFormChanged?: () => void;
	flashMessages?: FlashMessage[];
	savedNotificationPreferences?: {
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
	phoneVerified,
	onFormChanged,
	flashMessages,
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
	dailyDigestTimesMinutes.value = [DEFAULT_DAILY_DIGEST_TIME_MINUTES];
}

const phoneVerificationSectionId = `${DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID}-phone-verification-section`;

const dailyDigestTimes = computed(() =>
	dailyDigestTimesMinutes.value.map((value) => minutesToTimeInputValue(value)),
);

const timezone = computed(() => props.user.timezone ?? "");

const smsReady = computed(
	() => smsEnabled.value && phoneVerified.value,
);
const hasNotificationChannel = computed(
	() => emailEnabled.value || smsReady.value,
);
const needsChannelSelection = computed(() => !hasNotificationChannel.value);
const needsPhoneVerification = computed(
	() => smsEnabled.value && !phoneVerified.value,
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
			if (dailyDigestTimesMinutes.value.length === 0) {
				dailyDigestTimesMinutes.value = [DEFAULT_DAILY_DIGEST_TIME_MINUTES];
			}
			dailyDigestEnabled.value = true;
			onFormChanged.value?.();
		}
	},
);

const nextSendAt = computed(
	() =>
		props.savedNotificationPreferences?.next_send_at ??
			props.user.next_send_at ??
			null,
);
const { currentTimeInTimezone, countdownText } = useScheduledDigestTiming({
	timezone,
	dailyDigestEnabled,
	nextSendAtIso: nextSendAt,
	timeInputs: dailyDigestTimes,
});

watch(dailyDigestEnabled, () => {
	if (dailyDigestEnabled.value && dailyDigestTimesMinutes.value.length === 0) {
		dailyDigestTimesMinutes.value = [DEFAULT_DAILY_DIGEST_TIME_MINUTES];
	}
});

function handleDailyDigestEnabledUpdate(value: boolean) {
	dailyDigestEnabled.value = value;
	onFormChanged.value?.();
}

function handleTimeChange(index: number, value: string) {
	const parsedMinutes = parseTimeToMinutes(value);
	if (parsedMinutes === null) {
		return;
	}
	const updated = [...dailyDigestTimesMinutes.value];
	updated[index] = parsedMinutes;
	dailyDigestTimesMinutes.value = normalizeDigestTimes(updated);
	onFormChanged.value?.();
}

function handleAddTime() {
	if (!canAddTime.value) {
		return;
	}
	const times = normalizeDigestTimes(dailyDigestTimesMinutes.value);
	const baseTimes = times.length === 0 ? [DEFAULT_DAILY_DIGEST_TIME_MINUTES] : times;
	const nextMinutes =
		baseTimes[baseTimes.length - 1] + ADD_DIGEST_OFFSET_MINUTES;
	if (nextMinutes > MAX_DAILY_DIGEST_MINUTES) {
		return;
	}
	dailyDigestTimesMinutes.value = normalizeDigestTimes([
		...baseTimes,
		nextMinutes,
	]);
	onFormChanged.value?.();
}

function handleRemoveTime(index: number) {
	if (dailyDigestTimesMinutes.value.length <= 1) {
		return;
	}
	const updated = [...dailyDigestTimesMinutes.value];
	updated.splice(index, 1);
	dailyDigestTimesMinutes.value = normalizeDigestTimes(updated);
	onFormChanged.value?.();
}
</script>
