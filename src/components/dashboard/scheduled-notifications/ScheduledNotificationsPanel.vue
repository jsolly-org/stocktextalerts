<template>
	<form
		ref="scheduledFormElement"
		:id="DASHBOARD_FREQUENT_FORM_ID"
		method="POST"
		action="/api/notification-preferences/update"
		class="space-y-6"
		aria-label="Frequent notifications"
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
			<header>
				<h2
					:id="DASHBOARD_SECTION_IDS.frequent"
					class="text-xl sm:text-2xl font-bold text-gray-900 transition-opacity duration-200"
					:class="{ 'opacity-50': needsChannelSelection }"
				>
					Frequent Notifications
				</h2>
				<p
					class="text-sm text-gray-500 mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 transition-opacity duration-200"
					:class="{ 'opacity-50': needsChannelSelection }"
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
			</header>

			<SetupRequiredNotice
				:needsChannelSelection="needsChannelSelection"
				:needsPhoneVerification="needsPhoneVerification"
				:phoneVerificationSectionId="phoneVerificationSectionId"
			/>

			<div
				class="flex items-center justify-between gap-3 py-3 transition-opacity duration-200"
				:class="{ 'opacity-50': needsChannelSelection }"
			>
				<input
					type="hidden"
					name="price_notifications_enabled"
					:value="priceNotificationsEnabled ? 'on' : 'off'"
				/>
				<div class="min-w-0">
					<span
						id="price_notifications_enabled_label"
						class="text-base font-semibold text-gray-900"
					>
						Price Notifications
					</span>
					<p id="price_notifications_enabled_description" class="text-sm text-gray-600 mt-0.5">
						Receive scheduled stock price updates.
					</p>
				</div>
				<ToggleSwitch
					v-model="priceNotificationsEnabled"
					:disabled="needsChannelSelection"
					sr-label="Price Notifications"
					aria-labelledby="price_notifications_enabled_label"
					aria-describedby="price_notifications_enabled_description"
				/>
			</div>

			<FadeTransition>
				<p
					v-if="!needsChannelSelection && scheduledUpdateTimesMinutes.length === 0"
					class="flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm bg-info-bg border border-info-border text-info-text"
					role="note"
				>
					<InformationCircleIcon class="size-5 shrink-0 mt-0.5" aria-hidden="true" />
					<span>No notifications will be sent until you choose at least one delivery time below.</span>
				</p>
			</FadeTransition>

		<ScheduledUpdateControls
				:scheduledUpdateTimes="scheduledUpdateTimes"
				:onlyNotifyWhenMarketOpen="onlyNotifyWhenMarketOpen"
				:marketClosedSkipNote="marketClosedSkipNote"
				:needsChannelSelection="needsChannelSelection"
				:timePickerDisabled="timePickerDisabled"
				:canAddTime="canAddTime"
				:canAddMarketOpen="canAddMarketOpen"
				:marketOpenLabel="marketOpenLabel"
				:maxTimes="MAX_DELIVERY_TIMES"
				:maxTimesReached="maxTimesReached"
				:countdownText="countdownText"
				:outsideMarketHoursIndices="outsideMarketHoursIndices"
			@update:onlyNotifyWhenMarketOpen="handleOnlyNotifyWhenMarketOpenUpdate"
			@time-change="handleTimeChange"
			@add-time="handleAddTime"
			@add-initial-time="handleAddInitialTime"
			@add-market-open="handleAddMarketOpen"
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
import InformationCircleIcon from "../../../icons/information-circle-20.svg?component";
import {
	CARD_GRADIENT_ACCENTS,
	DASHBOARD_FREQUENT_FORM_ID,
	DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID,
	DASHBOARD_SECTION_IDS,
	DEFAULT_SCHEDULED_UPDATE_TIME_MINUTES,
	STATUS_TONE_CLASSES,
} from "../../../lib/constants";
import {
	formatMinutesAsLocalTime,
	getUsMarketOpenLocalMinutes,
	isOutsideMarketHours,
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

const priceNotificationsEnabled = ref(user.value.price_notifications_enabled);
const onlyNotifyWhenMarketOpen = ref(user.value.only_notify_when_market_open);
const isHydrated = ref(false);

onMounted(() => {
	isHydrated.value = true;
});

const MAX_SCHEDULED_UPDATE_MINUTES = 23 * 60 + 59;
const SCHEDULED_UPDATE_INCREMENT_MINUTES = 1;
const MAX_DELIVERY_TIMES = 5;
const MINUTES_PER_DAY = MAX_SCHEDULED_UPDATE_MINUTES + 1;

// [threshold in minutes, increment] — checked high-to-low
const QUICK_ADD_INCREMENTS: [number, number][] = [
	[23 * 60 + 58, 1],
	[23 * 60 + 45, 5],
	[23 * 60 + 30, 15],
	[23 * 60, 30],
	[21 * 60, 60],
];

function getQuickAddIncrementMinutes(latestMinutes: number): number {
	for (const [threshold, increment] of QUICK_ADD_INCREMENTS) {
		if (latestMinutes >= threshold) return increment;
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
const timePickerDisabled = computed(() => needsChannelSelection.value);
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
	// Always possible to add when list is empty
	if (times.length === 0) {
		return true;
	}
	return getNextQuickAddMinute(times, 0) !== null;
});

const marketOpenLocalMinutes = computed(() => {
	const tz = timezone.value;
	if (tz === "") return null;
	return getUsMarketOpenLocalMinutes(tz);
});

const marketOpenLabel = computed(() => {
	if (marketOpenLocalMinutes.value === null) return null;
	return formatMinutesAsLocalTime(marketOpenLocalMinutes.value);
});

const hasMarketOpenTime = computed(() => {
	if (marketOpenLocalMinutes.value === null) return true;
	return scheduledUpdateTimesMinutes.value.includes(marketOpenLocalMinutes.value);
});

const canAddMarketOpen = computed(
	() => !timePickerDisabled.value && !hasMarketOpenTime.value && !maxTimesReached.value,
);

const outsideMarketHoursIndices = computed<Set<number>>(() => {
	if (!onlyNotifyWhenMarketOpen.value) return new Set();
	const tz = timezone.value;
	if (tz === "") return new Set();
	const indices = new Set<number>();
	for (let i = 0; i < scheduledUpdateTimesMinutes.value.length; i++) {
		if (isOutsideMarketHours(scheduledUpdateTimesMinutes.value[i], tz)) {
			indices.add(i);
		}
	}
	return indices;
});

watch(
	() => user.value.price_notifications_enabled,
	(value) => {
		priceNotificationsEnabled.value = value;
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
const nextSendAt = computed(
	() =>
		savedScheduledData.value?.next_send_at ??
			user.value.next_send_at ??
			null,
);
const { currentTimeInTimezone, countdownText } = useScheduledUpdateTiming({
	timezone,
	nextSendAtIso: nextSendAt,
	timeInputs: scheduledUpdateTimes,
});

const marketClosedSkipNote = computed(() => {
	if (!isHydrated.value || !onlyNotifyWhenMarketOpen.value) return null;

	const skippedAtIso = user.value.last_market_closed_skip_scheduled_at;
	if (!skippedAtIso) return null;

	const skippedUtc = DateTime.fromISO(skippedAtIso, { zone: "utc" });
	if (!skippedUtc.isValid) return null;

	const hoursAgo = DateTime.utc().diff(skippedUtc, "hours").hours;
	if (!Number.isFinite(hoursAgo) || hoursAgo > 72) return null;

	const skippedLocal = skippedUtc.setZone(user.value.timezone);
	const timeLabel = skippedLocal.isValid
		? skippedLocal.toFormat("ccc, h:mm a")
		: "your scheduled time";

	return `We skipped ${timeLabel} because the market was closed. If you'd like to receive scheduled notifications anyway, turn off "Only notify when market is open" above.`;
});

// Update shared user ref directly when auto-save response arrives
watch(
	() => savedScheduledData.value,
	(newData) => {
		if (newData) {
		user.value = {
			...user.value,
			price_notifications_enabled: newData.price_notifications_enabled,
			scheduled_update_times: newData.scheduled_update_times,
			only_notify_when_market_open: newData.only_notify_when_market_open,
			next_send_at: newData.next_send_at,
		};
		}
	},
);

watch(priceNotificationsEnabled, (value) => {
	user.value = { ...user.value, price_notifications_enabled: value };
	notifyChange();
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
	if (!canAddTime.value) return;
	const times = normalizeScheduledTimes(scheduledUpdateTimesMinutes.value);
	// When empty, use market open as the first suggested time (falls back to 9:00 AM)
	if (times.length === 0) {
		scheduledUpdateTimesMinutes.value = [marketOpenLocalMinutes.value ?? DEFAULT_SCHEDULED_UPDATE_TIME_MINUTES];
		notifyChange();
		return;
	}
	const nextMinutes = getNextQuickAddMinute(times, 0);
	if (nextMinutes === null) return;
	scheduledUpdateTimesMinutes.value = normalizeScheduledTimes([...times, nextMinutes]);
	notifyChange();
}

function handleAddInitialTime(value: string) {
	const parsedMinutes = parseTimeToMinutes(value);
	if (parsedMinutes === null) {
		return;
	}
	scheduledUpdateTimesMinutes.value = [parsedMinutes];
	notifyChange();
}

function handleAddMarketOpen() {
	if (!canAddMarketOpen.value || marketOpenLocalMinutes.value === null) {
		return;
	}
	const times = normalizeScheduledTimes(scheduledUpdateTimesMinutes.value);
	const baseTimes =
		times.length === 0 ? [marketOpenLocalMinutes.value] : [...times, marketOpenLocalMinutes.value];
	scheduledUpdateTimesMinutes.value = normalizeScheduledTimes(baseTimes);
	notifyChange();
}

function handleRemoveTime(index: number) {
	const updated = [...scheduledUpdateTimesMinutes.value];
	updated.splice(index, 1);
	scheduledUpdateTimesMinutes.value = normalizeScheduledTimes(updated);
	notifyChange();
}
</script>
