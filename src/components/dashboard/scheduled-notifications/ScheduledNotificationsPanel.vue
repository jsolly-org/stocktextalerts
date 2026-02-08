<template>
	<form
		ref="scheduledFormElement"
		:id="DASHBOARD_SCHEDULED_FORM_ID"
		method="POST"
		action="/api/notification-preferences/update"
		class="space-y-6"
		aria-label="Scheduled price notifications"
		:aria-busy="isSaving"
		@input="handleFormInput"
		@change="handleFormChange"
		@submit="handleFormSubmit"
	>
		<section class="card relative mb-6">
			<FadeTransition>
				<div
					v-if="statusMessage"
					class="absolute top-3 right-3 flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium z-10 border"
					:class="STATUS_TONE_CLASSES[statusTone]"
					role="status"
					aria-live="polite"
					:aria-busy="isSaving"
					:data-tone="statusTone"
				>
					<ArrowPathIcon
						v-show="isSaving"
						class="animate-spin size-3 shrink-0"
						aria-hidden="true"
					/>
					{{ statusMessage }}
				</div>
			</FadeTransition>

			<div :class="`h-1 ${CARD_GRADIENT_ACCENTS.success}`"></div>
			<div class="card-body">
				<header class="flex items-start justify-between gap-4">
					<div class="min-w-0">
						<input
							type="hidden"
							name="scheduled_updates_enabled"
							:value="scheduledUpdatesEnabled ? 'on' : 'off'"
						/>
						<h2
							:id="DASHBOARD_SECTION_IDS.scheduled"
							class="text-xl sm:text-2xl font-bold text-gray-900"
						>
							Scheduled Price Notifications
						</h2>
						<p
						class="text-sm text-gray-500 mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 transition-opacity duration-200"
						:class="{ 'opacity-50': needsChannelSelection || !scheduledUpdatesEnabled }"
					>
							<span class="inline-flex items-center gap-1.5">
								<ClockIcon class="size-4 shrink-0 text-gray-400" aria-hidden="true" />
								<span>
									Local time:
									<span class="font-medium text-gray-700">
										{{ currentTimeInTimezone ?? "—" }}
									</span>
								</span>
							</span>
							<a
								href="/profile"
								class="inline-flex items-center gap-1 link-primary text-xs rounded-sm"
								aria-label="Change timezone in profile settings"
							>
								Change timezone
								<ArrowTopRightOnSquareIcon class="size-3 shrink-0" aria-hidden="true" />
							</a>
						</p>
					</div>
					<ToggleSwitch
						v-model="scheduledUpdatesEnabledToggle"
						:disabled="needsChannelSelection"
						sr-label="Enable scheduled price notifications"
						:aria-labelledby="DASHBOARD_SECTION_IDS.scheduled"
					/>
				</header>

				<SetupRequiredNotice
					:needsChannelSelection="needsChannelSelection"
					:needsPhoneVerification="needsPhoneVerification"
					:phoneVerificationSectionId="phoneVerificationSectionId"
				/>

				<ScheduledUpdateControls
					:scheduledUpdateTimes="scheduledUpdateTimes"
					:onlyNotifyWhenMarketOpen="onlyNotifyWhenMarketOpen"
					:marketClosedSkipNote="marketClosedSkipNote"
					:needsChannelSelection="needsChannelSelection"
					:timePickerDisabled="timePickerDisabled"
					:canAddTime="canAddTime"
					:maxTimes="MAX_DELIVERY_TIMES"
					:maxTimesReached="maxTimesReached"
					:countdownText="countdownText"
					@update:onlyNotifyWhenMarketOpen="handleOnlyNotifyWhenMarketOpenUpdate"
					@time-change="handleTimeChange"
					@add-time="handleAddTime"
					@remove-time="handleRemoveTime"
				/>
			</div>
		</section>
	</form>

</template>

<script lang="ts" setup>
import { DateTime } from "luxon";
import { computed, onMounted, ref, toRefs, watch } from "vue";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import ArrowPathIcon from "../../../icons/arrow-path.svg?component";
import ArrowTopRightOnSquareIcon from "../../../icons/arrow-top-right-on-square.svg?component";
import ClockIcon from "../../../icons/clock.svg?component";
import {
	CARD_GRADIENT_ACCENTS,
	DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID,
	DASHBOARD_SCHEDULED_FORM_ID,
	DASHBOARD_SECTION_IDS,
	DEFAULT_SCHEDULED_UPDATE_TIME_MINUTES,
	STATUS_TONE_CLASSES,
} from "../../../lib/constants";
import {
	minutesToTimeInputValue,
	parseTimeToMinutes,
} from "../../../lib/time/format";
import FadeTransition from "../../FadeTransition.vue";
import ToggleSwitch from "../../ToggleSwitch.vue";
import {
	type NotificationPreferencesData,
	useAutoSaveForm,
} from "../composables/useAutoSaveNotificationPreferences";
import { useDashboardUser } from "../composables/useDashboardUser";
import ScheduledUpdateControls from "./ScheduledUpdateControls.vue";
import SetupRequiredNotice from "./SetupRequiredNotice.vue";
import { useScheduledUpdateTiming } from "./scheduled-notifications-helpers";

interface Props {
	emailEnabled: boolean;
	smsEnabled: boolean;
	phoneVerified: boolean;
}

const props = defineProps<Props>();
const {
	emailEnabled,
	smsEnabled,
	phoneVerified,
} = toRefs(props);

// Inject the shared mutable user ref from DashboardPanels
const user = useDashboardUser();

const scheduledFormElement = ref<HTMLFormElement | null>(null);
const {
	handleFormChange,
	handleFormInput,
	handleFormSubmit,
	isSaving,
	notifyChange,
	savedData: savedScheduledData,
	statusMessage,
	statusTone,
} = useAutoSaveForm<NotificationPreferencesData>({
	formRef: scheduledFormElement,
});

const scheduledUpdatesEnabled = ref(user.value.scheduled_updates_enabled);
const onlyNotifyWhenMarketOpen = ref(user.value.only_notify_when_market_open);
const isHydrated = ref(false);

onMounted(() => {
	isHydrated.value = true;
});

const MAX_SCHEDULED_UPDATE_MINUTES = 23 * 60 + 59;
const SCHEDULED_UPDATE_INCREMENT_MINUTES = 1;
const MAX_DELIVERY_TIMES = 5;
const QUICK_ADD_LATE_EVENING_START = 21 * 60;
const QUICK_ADD_LATE_NIGHT_START = 23 * 60;
const QUICK_ADD_LATE_NIGHT_MEDIUM_START = 23 * 60 + 30;
const QUICK_ADD_LATE_NIGHT_SHORT_START = 23 * 60 + 45;
const QUICK_ADD_LATE_NIGHT_TINY_START = 23 * 60 + 58;
const MINUTES_PER_DAY = MAX_SCHEDULED_UPDATE_MINUTES + 1;

function getQuickAddIncrementMinutes(latestMinutes: number): number {
	if (latestMinutes >= QUICK_ADD_LATE_NIGHT_TINY_START) {
		return 1;
	}
	if (latestMinutes >= QUICK_ADD_LATE_NIGHT_SHORT_START) {
		return 5;
	}
	if (latestMinutes >= QUICK_ADD_LATE_NIGHT_MEDIUM_START) {
		return 15;
	}
	if (latestMinutes >= QUICK_ADD_LATE_NIGHT_START) {
		return 30;
	}
	if (latestMinutes >= QUICK_ADD_LATE_EVENING_START) {
		return 60;
	}
	return 180;
}

function getNextQuickAddMinute(
	existingTimes: number[],
	fallbackLatest: number,
): number | null {
	const normalized = normalizeScheduledTimes(existingTimes);
	const latestMinutes =
		normalized.length > 0
			? normalized[normalized.length - 1]
			: fallbackLatest;
	const incrementMinutes = getQuickAddIncrementMinutes(latestMinutes);
	let candidate = latestMinutes + incrementMinutes;
	if (candidate > MAX_SCHEDULED_UPDATE_MINUTES) {
		candidate = 0;
	}
	const existingSet = new Set(normalized);

	for (let offset = 0; offset < MINUTES_PER_DAY; offset += 1) {
		const minute = (candidate + offset) % MINUTES_PER_DAY;
		if (!existingSet.has(minute)) {
			return minute;
		}
	}
	return null;
}

function normalizeScheduledTimes(times: number[]): number[] {
	const filtered = times.filter(
		(value) =>
			Number.isFinite(value) &&
			value >= 0 &&
			value <= MAX_SCHEDULED_UPDATE_MINUTES &&
			value % SCHEDULED_UPDATE_INCREMENT_MINUTES === 0,
	);
	return [...new Set(filtered)].sort((a, b) => a - b);
}

const scheduledUpdateTimesMinutes = ref<number[]>(
	normalizeScheduledTimes(user.value.scheduled_update_times ?? []),
);

if (scheduledUpdatesEnabled.value && scheduledUpdateTimesMinutes.value.length === 0) {
	scheduledUpdateTimesMinutes.value = [DEFAULT_SCHEDULED_UPDATE_TIME_MINUTES];
}

const phoneVerificationSectionId = `${DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID}-phone-verification-section`;

const scheduledUpdateTimes = computed(() =>
	scheduledUpdateTimesMinutes.value.map((value) => minutesToTimeInputValue(value)),
);

const timezone = computed(() => user.value.timezone ?? "");

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
	() => needsChannelSelection.value || !scheduledUpdatesEnabled.value,
);
const maxTimesReached = computed(
	() => scheduledUpdateTimesMinutes.value.length >= MAX_DELIVERY_TIMES,
);
const canAddTime = computed(() => {
	if (timePickerDisabled.value) {
		return false;
	}
	if (maxTimesReached.value) {
		return false;
	}
	const times = normalizeScheduledTimes(scheduledUpdateTimesMinutes.value);
	const baseTimes =
		times.length === 0 ? [DEFAULT_SCHEDULED_UPDATE_TIME_MINUTES] : times;
	return (
		getNextQuickAddMinute(baseTimes, DEFAULT_SCHEDULED_UPDATE_TIME_MINUTES) !==
		null
	);
});

watch(
	() => user.value.scheduled_updates_enabled,
	(value) => {
		scheduledUpdatesEnabled.value = value;
	},
);
watch(
	() => user.value.only_notify_when_market_open,
	(value) => {
		onlyNotifyWhenMarketOpen.value = value;
	},
);
watch(
	() => user.value.scheduled_update_times,
	(value) => {
		scheduledUpdateTimesMinutes.value = normalizeScheduledTimes(value ?? []);
	},
);
// Only auto-enable scheduled updates when user gains their first channel (transition
// from no channel to has channel). Do not run on mount: that would overwrite
// a saved preference of scheduled_updates_enabled = false when they already have a channel.
watch(
	hasNotificationChannel,
	(hasChannel, previousHasChannel) => {
		if (previousHasChannel === false && hasChannel && !scheduledUpdatesEnabled.value) {
			if (scheduledUpdateTimesMinutes.value.length === 0) {
				scheduledUpdateTimesMinutes.value = [DEFAULT_SCHEDULED_UPDATE_TIME_MINUTES];
			}
			scheduledUpdatesEnabled.value = true;
			notifyChange();
		}
	},
);

const nextSendAt = computed(
	() =>
		savedScheduledData.value?.next_send_at ??
			user.value.next_send_at ??
			null,
);
const { currentTimeInTimezone, countdownText } = useScheduledUpdateTiming({
	timezone,
	scheduledUpdatesEnabled,
	nextSendAtIso: nextSendAt,
	timeInputs: scheduledUpdateTimes,
});

const marketClosedSkipNote = computed(() => {
	if (!isHydrated.value) {
		return null;
	}
	if (!scheduledUpdatesEnabled.value) {
		return null;
	}
	if (!onlyNotifyWhenMarketOpen.value) {
		return null;
	}
	const skippedAtIso = user.value.last_market_closed_skip_scheduled_at;
	if (!skippedAtIso) {
		return null;
	}
	const skippedUtc = DateTime.fromISO(skippedAtIso, { zone: "utc" });
	if (!skippedUtc.isValid) {
		return null;
	}
	const hoursAgo = DateTime.utc().diff(skippedUtc, "hours").hours;
	if (!Number.isFinite(hoursAgo) || hoursAgo > 72) {
		return null;
	}

	const skippedLocal = skippedUtc.setZone(user.value.timezone);
	const timeLabel = skippedLocal.isValid
		? skippedLocal.toFormat("ccc, h:mm a")
		: "your scheduled time";

	return `We skipped ${timeLabel} because the market was closed. If you’d like to receive scheduled price notifications anyway, turn off “Only notify when market is open” above.`;
});

watch(scheduledUpdatesEnabled, () => {
	if (scheduledUpdatesEnabled.value && scheduledUpdateTimesMinutes.value.length === 0) {
		scheduledUpdateTimesMinutes.value = [DEFAULT_SCHEDULED_UPDATE_TIME_MINUTES];
	}
});

// Update shared user ref directly when auto-save response arrives
watch(
	() => savedScheduledData.value,
	(newData) => {
		if (newData) {
			user.value = {
				...user.value,
				scheduled_updates_enabled: newData.scheduled_updates_enabled,
				scheduled_update_times: newData.scheduled_update_times,
				only_notify_when_market_open: newData.only_notify_when_market_open,
				next_send_at: newData.next_send_at,
			};
		}
	},
);

const scheduledUpdatesEnabledToggle = computed({
	get: () => scheduledUpdatesEnabled.value,
	set: (value: boolean) => {
		scheduledUpdatesEnabled.value = value;
		notifyChange();
	},
});

function handleOnlyNotifyWhenMarketOpenUpdate(value: boolean) {
	onlyNotifyWhenMarketOpen.value = value;
	user.value = { ...user.value, only_notify_when_market_open: value };
	notifyChange();
}

function handleTimeChange(index: number, value: string) {
	const parsedMinutes = parseTimeToMinutes(value);
	if (parsedMinutes === null) {
		return;
	}
	const updated = [...scheduledUpdateTimesMinutes.value];
	updated[index] = parsedMinutes;
	scheduledUpdateTimesMinutes.value = normalizeScheduledTimes(updated);
	notifyChange();
}

function handleAddTime() {
	if (!canAddTime.value) {
		return;
	}
	const times = normalizeScheduledTimes(scheduledUpdateTimesMinutes.value);
	const baseTimes =
		times.length === 0 ? [DEFAULT_SCHEDULED_UPDATE_TIME_MINUTES] : times;
	if (baseTimes.length >= MAX_DELIVERY_TIMES) {
		return;
	}
	const nextMinutes = getNextQuickAddMinute(
		baseTimes,
		DEFAULT_SCHEDULED_UPDATE_TIME_MINUTES,
	);
	if (nextMinutes === null) {
		return;
	}
	scheduledUpdateTimesMinutes.value = normalizeScheduledTimes([
		...baseTimes,
		nextMinutes,
	]);
	notifyChange();
}

function handleRemoveTime(index: number) {
	if (scheduledUpdateTimesMinutes.value.length <= 1) {
		return;
	}
	const updated = [...scheduledUpdateTimesMinutes.value];
	updated.splice(index, 1);
	scheduledUpdateTimesMinutes.value = normalizeScheduledTimes(updated);
	notifyChange();
}
</script>
