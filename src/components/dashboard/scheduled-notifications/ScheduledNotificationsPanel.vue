<template>
	<form
		ref="scheduledFormElement"
		:id="formId"
		method="POST"
		action="/api/notification-preferences/update"
		:aria-label="ariaLabel"
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

			<div :class="`card-accent ${showMarketSections ? CARD_GRADIENT_ACCENTS.success : CARD_GRADIENT_ACCENTS.purple}`"></div>
		<div class="card-body">
		<fieldset :disabled="isSaving" class="min-w-0">
		<header v-if="showMarketSections" class="mb-4">
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
				Configure market-related notifications for your tracked assets during trading hours.
			</p>
			</header>
		<header v-else-if="showWeeklySection" class="mb-4">
			<h2
				:id="DASHBOARD_SECTION_IDS.weeklyCalendar"
				class="text-xl sm:text-2xl font-bold text-gray-900 transition-opacity duration-200"
				:class="{ 'opacity-50': needsChannelSelection }"
			>
				Asset Events
			</h2>
			<p
				v-if="weeklyDeliveryTimeLabel"
				class="text-sm text-gray-600 mt-1 transition-opacity duration-200"
				:class="{ 'opacity-50': needsChannelSelection }"
			>
				<span class="inline-flex items-center gap-1.5">
					<ClockIcon class="size-4 shrink-0 text-gray-400" aria-hidden="true" />
					<span>
						Sent Mondays at
						<span class="font-medium text-gray-700">{{ weeklyDeliveryTimeLabel }}</span>
						<span v-if="weeklyTimezoneLabel" class="text-gray-500"> ({{ weeklyTimezoneLabel }})</span>
					<template v-if="hasDailyDeliveryTime">
						— synced with your
						<button
							type="button"
							class="font-medium text-gray-700 underline decoration-gray-400 underline-offset-2 cursor-pointer hover:text-gray-900 hover:decoration-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 rounded transition-colors"
							@click="scrollToDailyNotifications"
						>daily delivery time</button>.
					</template>
					<template v-else>
						— set your
						<button
							type="button"
							class="font-medium text-gray-700 underline decoration-gray-400 underline-offset-2 cursor-pointer hover:text-gray-900 hover:decoration-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 rounded transition-colors"
							@click="scrollToDailyNotifications"
						>daily delivery time</button>
						to change.
					</template>
					</span>
				</span>
			</p>
		</header>

			<SetupRequiredNotice
				:needsChannelSelection="needsChannelSelection"
				:needsPhoneVerification="needsPhoneVerification"
				:phoneVerificationSectionId="phoneVerificationSectionId"
			/>

			<template v-if="showMarketSections">
			<div
				class="rounded-xl border border-gray-200 bg-white p-4 transition-opacity duration-200"
				:class="{ 'opacity-50': needsChannelSelection }"
			>
				<div class="flex items-center justify-between gap-3">
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
							Scheduled Price Notifications
						</span>
						<p id="price_notifications_enabled_description" class="text-sm text-gray-600 mt-0.5">
							Scheduled price updates for all tracked assets, including ETFs.
						</p>
					</div>
					<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4 shrink-0">
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
					<div v-if="priceNotificationsEnabled" class="mt-3 border-t border-gray-100 pt-3 pl-3 sm:pl-4">
						<p class="text-sm text-gray-600 mb-3">
							Delivery times for scheduled price notifications.
						</p>

						<FadeTransition>
							<p
								v-if="!needsChannelSelection && scheduledUpdateTimesMinutes.length === 0"
								class="flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm bg-info-bg border border-info-border text-info-text"
								role="note"
							>
								<InformationCircleIcon class="size-5 shrink-0 mt-0.5" aria-hidden="true" />
								<span>No scheduled price notification delivery times selected.</span>
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
				</FadeTransition>
			</div>

			<div
				class="mt-4 rounded-xl border border-gray-200 bg-white p-4 transition-opacity duration-200"
				:class="{ 'opacity-50': needsChannelSelection }"
			>
				<div class="flex items-center justify-between gap-3">
					<input
						type="hidden"
						name="instant_notifications_enabled"
						:value="instantNotificationsEnabled ? 'on' : 'off'"
					/>
					<input
						type="hidden"
						name="instant_include_email"
						:value="instantIncludeEmail ? 'on' : 'off'"
					/>
					<input
						type="hidden"
						name="instant_include_sms"
						:value="instantIncludeSms ? 'on' : 'off'"
					/>
					<input
						type="hidden"
						name="instant_alert_sensitivity"
						:value="instantAlertSensitivity"
					/>
					<div class="min-w-0">
						<span
							id="instant_notifications_enabled_label"
							class="text-base font-semibold text-gray-900"
						>
							Market Movement Alerts
						</span>
						<p id="instant_notifications_enabled_description" class="text-sm text-gray-600 mt-0.5">
							Notified immediately when tracked assets show significant movement, up or down.
						</p>
						<details class="mt-2 group">
							<summary
								class="text-xs font-medium text-emerald-700 cursor-pointer hover:text-emerald-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded"
							>
								How market movement alerts work
							</summary>
							<div class="mt-2 rounded-md border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
								<ul class="list-disc pl-4 space-y-1">
									<li>Runs only during US market hours and checks symbols you track.</li>
									<li>Builds a score from rapid price moves, breakouts, and breaking news.</li>
									<li>Sends an alert when the score crosses the configured threshold.</li>
									<li>Uses a cooldown per symbol to avoid repeated alerts in a short window.</li>
								</ul>
							</div>
						</details>
					</div>
					<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4 shrink-0">
						<label class="inline-flex items-center gap-1.5 cursor-pointer">
							<input
								type="checkbox"
								v-model="instantIncludeEmail"
								:disabled="needsChannelSelection || !emailEnabled"
								class="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500 h-4 w-4 cursor-pointer"
								aria-describedby="instant_notifications_enabled_description"
							/>
							<span class="text-sm text-gray-700">Email</span>
						</label>
						<label class="inline-flex items-center gap-1.5" :class="smsReady ? 'cursor-pointer' : needsChannelSelection ? 'cursor-not-allowed' : 'cursor-not-allowed opacity-50'">
							<input
								type="checkbox"
								v-model="instantIncludeSms"
								:disabled="needsChannelSelection || !smsReady"
								class="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500 h-4 w-4 cursor-pointer"
								aria-describedby="instant_notifications_enabled_description"
							/>
							<span class="text-sm text-gray-700">SMS</span>
						</label>
					</div>
				</div>

				<FadeTransition>
					<div v-if="instantNotificationsEnabled" class="mt-3 border-t border-gray-100 pt-3 pl-3 sm:pl-4">
						<fieldset :disabled="needsChannelSelection">
							<legend class="text-sm font-medium text-gray-700 mb-2">
								Movement Sensitivity
							</legend>
							<div
								class="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5"
								role="radiogroup"
								aria-label="Alert sensitivity level"
							>
								<label
									v-for="option in SENSITIVITY_OPTIONS"
									:key="option.value"
									class="relative cursor-pointer rounded-md px-3.5 py-1.5 text-sm font-medium transition-all duration-150 select-none focus-within:z-10 focus-within:ring-2 focus-within:ring-emerald-500 focus-within:ring-offset-1"
									:class="
										instantAlertSensitivity === option.value
											? 'bg-white text-gray-900 shadow-sm border border-gray-200'
											: 'text-gray-500 hover:text-gray-700 border border-transparent'
									"
								>
									<input
										type="radio"
										:value="option.value"
										v-model.number="instantAlertSensitivity"
										class="sr-only"
										name="instant_alert_sensitivity_radio"
									/>
									{{ option.label }}
								</label>
							</div>
						<p class="mt-2 text-xs" :class="isAggressiveSensitivity ? 'text-amber-600' : 'text-gray-500'">
							<span v-if="isAggressiveSensitivity" class="inline-flex items-start gap-1">
								<svg class="mt-px h-3.5 w-3.5 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
									<path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" />
								</svg>
								{{ sensitivityDescription }}
							</span>
							<template v-else>{{ sensitivityDescription }}</template>
						</p>
						</fieldset>
					</div>
				</FadeTransition>
			</div>
			</template>

			<!-- Weekly Calendar -->
			<div
				:id="showMarketSections ? DASHBOARD_SECTION_IDS.weeklyCalendar : null"
				class="rounded-xl border border-gray-200 bg-white p-4 transition-opacity duration-200"
				:class="[
					{ 'opacity-50': needsChannelSelection },
					showMarketSections ? 'mt-4' : ''
				]"
				v-if="showWeeklySection"
			>
				<div class="flex items-center justify-between gap-3">
					<input
						type="hidden"
						name="weekly_include_earnings_email"
						:value="includeEarningsEmail ? 'on' : 'off'"
					/>
					<input
						type="hidden"
						name="weekly_include_earnings_sms"
						:value="includeEarningsSms ? 'on' : 'off'"
					/>
					<div class="min-w-0">
						<div class="flex items-center gap-2">
							<span
								id="weekly_include_earnings_label"
								class="text-base font-semibold text-gray-900"
							>
								Earnings Reports
							</span>
							<FinnhubLogoIcon class="h-4.5 w-auto shrink-0" aria-label="Powered by Finnhub" role="img" />
						</div>
						<p
							id="weekly_include_earnings_description"
							class="text-sm text-gray-600 mt-0.5"
						>
							Sent when tracked stocks have earnings in the next 1-3 days.
						</p>
					</div>
					<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4 shrink-0">
						<label
							class="inline-flex items-center gap-1.5"
							:class="(needsChannelSelection || !emailEnabled) ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'"
						>
							<input
								type="checkbox"
								v-model="includeEarningsEmail"
								:disabled="needsChannelSelection || !emailEnabled"
								class="rounded border-gray-300 h-4 w-4"
								:class="[
									weeklyAccentClasses,
									(needsChannelSelection || !emailEnabled) ? 'cursor-not-allowed' : 'cursor-pointer',
								]"
								aria-label="Earnings Reports Email"
								aria-describedby="weekly_include_earnings_description"
							/>
							<span class="text-sm text-gray-700">Email</span>
						</label>
						<label class="inline-flex items-center gap-1.5" :class="smsReady ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'">
							<input
								type="checkbox"
								v-model="includeEarningsSms"
								:disabled="needsChannelSelection || !smsReady"
								class="rounded border-gray-300 h-4 w-4"
								:class="[
									weeklyAccentClasses,
									smsReady ? 'cursor-pointer' : 'cursor-not-allowed',
								]"
								aria-label="Earnings Reports SMS"
								aria-describedby="weekly_include_earnings_description"
							/>
							<span class="text-sm text-gray-700">SMS</span>
						</label>
					</div>
				</div>

				<div v-if="isHydrated && weeklyEnabled && nextWeeklyDeliveryText" class="mt-3 border-t border-gray-100 pt-3 pl-3 sm:pl-4">
					<p class="inline-flex items-center gap-2 text-sm text-gray-600">
						<BellAlertIcon class="size-4 shrink-0 text-success-strong" aria-hidden="true" />
						<span>Next delivery <span class="font-medium text-gray-900">{{ nextWeeklyDeliveryText }}</span>.</span>
					</p>
				</div>
			</div>

			</fieldset>
			</div>
		</section>
	</form>

</template>

<script lang="ts" setup>
import { DateTime } from "luxon";
import { computed, onMounted, onUnmounted, ref, toRefs, watch } from "vue";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import ArrowPathIcon from "../../../icons/arrow-path.svg?component";
import BellAlertIcon from "../../../icons/bell-alert.svg?component";
import ClockIcon from "../../../icons/clock.svg?component";
import FinnhubLogoIcon from "../../../icons/finnhub.svg?component";
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
	formatCountdownWithSeconds,
	formatMinutesAsLocalTime,
	getUsMarketOpenLocalMinutes,
	isOutsideMarketHours,
	minutesToTimeInputValue,
	parseTimeToMinutes,
} from "../../../lib/time/format";
import { calculateNextMondaySendAt } from "../../../lib/time/scheduled-times";
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
	showMarketSections?: boolean;
	showWeeklySection?: boolean;
	formId?: string;
	ariaLabel?: string;
}

const props = withDefaults(defineProps<Props>(), {
	showMarketSections: true,
	showWeeklySection: true,
	formId: DASHBOARD_FREQUENT_FORM_ID,
	ariaLabel: "Market and weekly calendar notifications",
});
const {
	emailEnabled,
	smsEnabled,
	phoneVerified,
	showMarketSections,
	showWeeklySection,
	formId,
	ariaLabel,
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

const instantIncludeEmail = ref(user.value.instant_include_email);
const instantIncludeSms = ref(user.value.instant_include_sms);
const instantNotificationsEnabled = computed(
	() => instantIncludeEmail.value || instantIncludeSms.value,
);
const instantAlertSensitivity = ref<number>(user.value.instant_alert_sensitivity ?? 1);

const SENSITIVITY_OPTIONS = [
	{ value: 1, label: "Chill" },
	{ value: 2, label: "Balanced" },
	{ value: 3, label: "Aggressive" },
] as const;

const SENSITIVITY_DESCRIPTIONS: Record<number, string> = {
	1: "Only high-confidence alerts for major market-moving events.",
	2: "Notifies more than Chill, but still waits for solid confirmation before alerting.",
	3: "Lowest threshold — alerts on smaller moves and weaker signals. May send a lot of notifications.",
};

const sensitivityDescription = computed(
	() => SENSITIVITY_DESCRIPTIONS[instantAlertSensitivity.value] ?? SENSITIVITY_DESCRIPTIONS[1],
);

const isAggressiveSensitivity = computed(() => instantAlertSensitivity.value === 3);

const includeEarningsEmail = ref(user.value.weekly_include_earnings_email);
const includeEarningsSms = ref(user.value.weekly_include_earnings_sms);

/** Checkbox accent: purple for weekly-only, emerald when combined with market sections. */
const weeklyAccentClasses = computed(() =>
	showMarketSections.value
		? "text-emerald-600 focus:ring-emerald-500"
		: "text-purple-600 focus:ring-purple-500",
);
const weeklyEnabled = computed(
	() => includeEarningsEmail.value || includeEarningsSms.value,
);

const DEFAULT_WEEKLY_DELIVERY_MINUTES = 540; // 9:00 AM
const weeklyDeliveryTimeMinutes = computed(() =>
	user.value.daily_delivery_time ?? DEFAULT_WEEKLY_DELIVERY_MINUTES,
);
const weeklyDeliveryTimeLabel = computed(() =>
	formatMinutesAsLocalTime(weeklyDeliveryTimeMinutes.value),
);
const weeklyTimezoneLabel = computed(() => {
	if (!user.value.timezone) return null;
	const dt = DateTime.now().setZone(user.value.timezone);
	return dt.isValid ? dt.toFormat("ZZZZ") : null;
});
const hasDailyDeliveryTime = computed(() => user.value.daily_delivery_time != null);

const tick = ref(0);
let tickIntervalId: number | null = null;
const nextWeeklyDeliveryText = computed(() => {
	if (!isHydrated.value || !weeklyEnabled.value) return null;
	void tick.value; // Subscribe to tick updates for countdown reactivity

	const now = DateTime.utc();
	const nextSendAt = user.value.weekly_next_send_at;
	if (nextSendAt) {
		const next = DateTime.fromISO(nextSendAt, { zone: "utc" });
		if (next.isValid) {
			const diffSeconds = next.diff(now, "seconds").seconds;
			if (diffSeconds > 0) {
				return `in ${formatCountdownWithSeconds(Math.round(diffSeconds))}`;
			}
		}
	}
	const tz = user.value.timezone;
	if (!tz) return null;
	const nextMonday = calculateNextMondaySendAt(weeklyDeliveryTimeMinutes.value, tz, now);
	if (!nextMonday) return null;
	const fallbackSeconds = Math.ceil(nextMonday.diff(now, "seconds").seconds);
	if (fallbackSeconds <= 0) return null;
	return `in ${formatCountdownWithSeconds(fallbackSeconds)}`;
});

function scrollToDailyNotifications() {
	const el = document.getElementById(DASHBOARD_SECTION_IDS.dailyNotifications);
	if (el) el.scrollIntoView({ behavior: "smooth" });
}

const isHydrated = ref(false);

function startWeeklyTickInterval() {
	if (tickIntervalId !== null) return;
	isHydrated.value = true;
	tick.value = Date.now();
	tickIntervalId = window.setInterval(() => {
		tick.value = Date.now();
	}, 1000);
}

function stopWeeklyTickInterval() {
	if (tickIntervalId === null) return;
	window.clearInterval(tickIntervalId);
	tickIntervalId = null;
	isHydrated.value = false;
}

onMounted(() => {
	watch(
		[showWeeklySection, weeklyEnabled],
		([isVisible, isEnabled]) => {
			if (isVisible && isEnabled) {
				startWeeklyTickInterval();
				return;
			}
			stopWeeklyTickInterval();
		},
		{ immediate: true },
	);
});
onUnmounted(() => {
	stopWeeklyTickInterval();
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

watch(
	emailEnabled,
	(enabled) => {
		if (!enabled && includeEarningsEmail.value) {
			includeEarningsEmail.value = false;
		}
	},
	{ immediate: true },
);
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
	() => user.value.instant_include_email,
	(value) => {
		instantIncludeEmail.value = value;
	},
);
watch(
	() => user.value.instant_include_sms,
	(value) => {
		instantIncludeSms.value = value;
	},
);
watch(
	() => user.value.instant_alert_sensitivity,
	(value) => {
		instantAlertSensitivity.value = value ?? 1;
	},
);
watch(
	() => user.value.scheduled_update_times,
	(value) => {
		scheduledUpdateTimesMinutes.value = normalizeScheduledTimes(value ?? []);
	},
);
watch(
	() => user.value.weekly_include_earnings_email,
	(value) => {
		includeEarningsEmail.value = value;
	},
);
watch(
	() => user.value.weekly_include_earnings_sms,
	(value) => {
		includeEarningsSms.value = value;
	},
);
watch([includeEarningsEmail, includeEarningsSms], ([email, sms]) => {
	if (
		email === user.value.weekly_include_earnings_email &&
		sms === user.value.weekly_include_earnings_sms
	) {
		return;
	}
	user.value = {
		...user.value,
		weekly_include_earnings_email: email,
		weekly_include_earnings_sms: sms,
	};
	notifyChange();
});
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
			// Sync instant alerts state from server response
			...(newData.instant_notifications_enabled !== undefined && {
				instant_notifications_enabled: newData.instant_notifications_enabled,
			}),
			...(newData.instant_include_email !== undefined && {
				instant_include_email: newData.instant_include_email,
			}),
			...(newData.instant_include_sms !== undefined && {
				instant_include_sms: newData.instant_include_sms,
			}),
			...(newData.instant_alert_sensitivity !== undefined && {
				instant_alert_sensitivity: newData.instant_alert_sensitivity,
			}),
			// Sync weekly calendar state from server response
			...(newData.weekly_include_earnings_email !== undefined && {
				weekly_include_earnings_email: newData.weekly_include_earnings_email,
			}),
			...(newData.weekly_include_earnings_sms !== undefined && {
				weekly_include_earnings_sms: newData.weekly_include_earnings_sms,
			}),
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

watch(instantAlertSensitivity, (value) => {
	if (value === (user.value.instant_alert_sensitivity ?? 1)) {
		return;
	}
	user.value = {
		...user.value,
		instant_alert_sensitivity: value,
	};
	notifyChange();
});

watch([instantIncludeEmail, instantIncludeSms], ([email, sms]) => {
	if (
		email === user.value.instant_include_email &&
		sms === user.value.instant_include_sms
	) {
		return;
	}
	user.value = {
		...user.value,
		instant_include_email: email,
		instant_include_sms: sms,
		instant_notifications_enabled: email || sms,
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
