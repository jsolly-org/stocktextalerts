<template>
	<form
		ref="scheduledFormElement"
		:id="DASHBOARD_FREQUENT_FORM_ID"
		method="POST"
		action="/api/notification-preferences/update"
		aria-label="Market notifications"
		:aria-busy="isSaving"
		@input="handleFormInput"
		@change="handleFormChange"
		@submit="handleFormSubmit"
	>
		<section class="card relative">
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

			<div :class="`card-accent ${CARD_GRADIENT_ACCENTS.success}`"></div>
		<div class="card-body">
		<header class="mb-4">
			<h2
					:id="DASHBOARD_SECTION_IDS.frequent"
					class="text-xl sm:text-2xl font-bold text-gray-900 transition-opacity duration-200"
					:class="{ 'opacity-50': needsChannelSelection }"
				>
					Market Notifications
				</h2>
			<p
				class="text-sm text-gray-600 mt-1"
			>
				Scheduled market notifications for all your tracked assets — each selected delivery time sends a separate notification.
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
				<input
					type="hidden"
					name="price_include_email"
					:value="priceIncludeEmail ? 'on' : 'off'"
				/>
				<input
					type="hidden"
					name="price_include_sms"
					:value="priceIncludeSms ? 'on' : 'off'"
				/>
				<div class="min-w-0">
					<span
						id="price_notifications_enabled_label"
						class="text-base font-semibold text-gray-900"
					>
						Price Notifications
					</span>
					<p id="price_notifications_enabled_description" class="text-sm text-gray-600 mt-0.5">
						Receive price updates for all your tracked assets, including ETFs.
					</p>
				</div>
				<div class="flex items-center gap-4 shrink-0">
					<label class="inline-flex items-center gap-1.5 cursor-pointer">
						<input
							type="checkbox"
							v-model="priceIncludeEmail"
							:disabled="needsChannelSelection || !emailEnabled"
							class="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500 h-4 w-4 cursor-pointer"
							aria-describedby="price_notifications_enabled_description"
						/>
						<span class="text-sm text-gray-700">Email</span>
					</label>
					<label class="inline-flex items-center gap-1.5" :class="smsReady ? 'cursor-pointer' : needsChannelSelection ? 'cursor-not-allowed' : 'cursor-not-allowed opacity-50'">
						<input
							type="checkbox"
							v-model="priceIncludeSms"
							:disabled="needsChannelSelection || !smsReady"
							class="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500 h-4 w-4 cursor-pointer"
							aria-describedby="price_notifications_enabled_description"
						/>
						<span class="text-sm text-gray-700">SMS</span>
					</label>
				</div>
			</div>

			<FadeTransition>
				<p
					v-if="!needsChannelSelection && scheduledUpdateTimesMinutes.length === 0"
					class="flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm bg-info-bg border border-info-border text-info-text"
					role="note"
				>
					<InformationCircleIcon class="size-5 shrink-0 mt-0.5" aria-hidden="true" />
					<span>No Market notifications.</span>
				</p>
			</FadeTransition>

		<ScheduledUpdateControls
				:scheduledUpdateTimes="scheduledUpdateTimes"
				:needsChannelSelection="needsChannelSelection"
				:timePickerDisabled="timePickerDisabled"
				:canAddTime="canAddTime"
				:canAddMarketOpen="canAddMarketOpen"
				:marketOpenLabel="marketOpenLabel"
				:maxTimes="MAX_DELIVERY_TIMES"
				:maxTimesReached="maxTimesReached"
				:countdownText="countdownText"
				:outsideMarketHoursIndices="outsideMarketHoursIndices"
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
import { computed, onMounted, ref, toRefs, watch } from "vue";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import ArrowPathIcon from "../../../icons/arrow-path.svg?component";
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

const priceIncludeEmail = ref(user.value.price_include_email);
const priceIncludeSms = ref(user.value.price_include_sms);
const priceNotificationsEnabled = computed(
	() => priceIncludeEmail.value || priceIncludeSms.value,
);
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
	() => user.value.price_include_email,
	(value) => {
		priceIncludeEmail.value = value;
	},
);
watch(
	() => user.value.price_include_sms,
	(value) => {
		priceIncludeSms.value = value;
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
const { countdownText } = useScheduledUpdateTiming({
	timezone,
	nextSendAtIso: nextSendAt,
	timeInputs: scheduledUpdateTimes,
});

// Update shared user ref directly when auto-save response arrives
watch(
	() => savedScheduledData.value,
	(newData) => {
		if (newData) {
		user.value = {
			...user.value,
			price_notifications_enabled: newData.price_notifications_enabled,
			price_include_email: newData.price_include_email,
			price_include_sms: newData.price_include_sms,
			scheduled_update_times: newData.scheduled_update_times,
			next_send_at: newData.next_send_at,
			// Keep other panels' scheduling in sync with the server response.
			daily_next_send_at: newData.daily_next_send_at,
			weekly_next_send_at: newData.weekly_next_send_at,
		};
		}
	},
);

watch([priceIncludeEmail, priceIncludeSms], ([email, sms]) => {
	if (
		email === user.value.price_include_email &&
		sms === user.value.price_include_sms
	) {
		return;
	}
	user.value = {
		...user.value,
		price_include_email: email,
		price_include_sms: sms,
		price_notifications_enabled: email || sms,
	};
	notifyChange();
});

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
