<template>
	<form
		ref="scheduledFormElement"
		:id="DASHBOARD_MARKET_FORM_ID"
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
		<fieldset :disabled="isSaving" class="min-w-0">
		<header class="mb-4">
			<h2
					:id="DASHBOARD_SECTION_IDS.marketNotifications"
					class="text-xl sm:text-2xl font-bold text-heading transition-opacity duration-200"
					:class="{ 'opacity-50': needsChannelSelection }"
				>
					Market Notifications
				</h2>
			<p
				class="text-sm text-body-secondary mt-1"
			>
				Configure market-related notifications for your tracked assets during trading hours.
			</p>
			</header>

			<SetupRequiredNotice
				:needsChannelSelection="needsChannelSelection"
				:needsPhoneVerification="needsPhoneVerification"
				:phoneVerificationSectionId="phoneVerificationSectionId"
			/>

			<div
				class="rounded-xl border border-edge bg-surface p-4 transition-opacity duration-200"
				:class="{ 'opacity-50': needsChannelSelection }"
			>
				<div class="flex items-center justify-between gap-3">
					<input
						type="hidden"
						name="market_scheduled_asset_price_enabled"
						:value="marketNotificationsEnabled ? 'on' : 'off'"
					/>
					<input
						type="hidden"
						name="market_scheduled_asset_price_include_email"
						:value="marketIncludeEmail ? 'on' : 'off'"
					/>
					<input
						type="hidden"
						name="market_scheduled_asset_price_include_sms"
						:value="marketIncludeSms ? 'on' : 'off'"
					/>
					<div class="min-w-0">
						<div class="flex items-center gap-2">
							<span
								id="market_scheduled_asset_price_enabled_label"
								class="text-base font-semibold text-heading"
							>
								Scheduled Asset Price Notifications
							</span>
							<MassiveLogoIcon class="h-4.5 w-auto shrink-0" aria-label="Powered by Massive" role="img" />
						</div>
						<p id="market_scheduled_asset_price_enabled_description" class="text-sm text-body-secondary mt-0.5">
							Scheduled asset price updates for all tracked assets, including ETFs.
						</p>
					</div>
					<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4 shrink-0">
						<label class="inline-flex items-center gap-1.5 cursor-pointer">
							<input
								type="checkbox"
								v-model="marketIncludeEmail"
								:disabled="needsChannelSelection || !emailEnabled"
								class="rounded border-edge-strong text-emerald-600 focus:ring-emerald-500 h-4 w-4 cursor-pointer"
								aria-describedby="market_scheduled_asset_price_enabled_description"
							/>
							<span class="text-sm text-label">Email</span>
						</label>
						<label class="inline-flex items-center gap-1.5" :class="smsReady ? 'cursor-pointer' : needsChannelSelection ? 'cursor-not-allowed' : 'cursor-not-allowed opacity-50'">
							<input
								type="checkbox"
								v-model="marketIncludeSms"
								:disabled="needsChannelSelection || !smsReady"
								class="rounded border-edge-strong text-emerald-600 focus:ring-emerald-500 h-4 w-4 cursor-pointer"
								aria-describedby="market_scheduled_asset_price_enabled_description"
							/>
							<span class="text-sm text-label">SMS</span>
						</label>
					</div>
				</div>

				<FadeTransition>
					<div v-if="marketNotificationsEnabled" class="mt-3 border-t border-divider pt-3 pl-3 sm:pl-4">
						<p class="text-sm text-body-secondary mb-3">
							Delivery times for scheduled asset price notifications.
						</p>

						<FadeTransition>
							<p
								v-if="!needsChannelSelection && scheduledUpdateTimesMinutes.length === 0"
								class="flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm bg-info-bg border border-info-border text-info-text"
								role="note"
							>
								<InformationCircleIcon class="size-5 shrink-0 mt-0.5" aria-hidden="true" />
								<span>No scheduled asset price notification delivery times selected.</span>
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
							:countdownDelayReasons="countdownDelayReasons"
							:countdownHolidayName="countdownHolidayName"
							:outsideMarketHoursIndices="outsideMarketHoursIndices"
							:is24="is24"
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
				class="mt-4 rounded-xl border border-edge bg-surface p-4 transition-opacity duration-200"
				:class="{ 'opacity-50': needsChannelSelection }"
			>
				<div class="flex items-center justify-between gap-3">
					<input
						type="hidden"
						name="market_asset_price_alerts_enabled"
						:value="priceAlertsEnabled ? 'on' : 'off'"
					/>
					<input
						type="hidden"
						name="market_asset_price_alerts_include_email"
						:value="priceAlertsIncludeEmail ? 'on' : 'off'"
					/>
					<input
						type="hidden"
						name="market_asset_price_alerts_include_sms"
						:value="priceAlertsIncludeSms ? 'on' : 'off'"
					/>
					<input
						type="hidden"
						name="market_asset_price_alert_sensitivity"
						:value="priceAlertSensitivity"
					/>
					<div class="min-w-0">
						<div class="flex items-center gap-2">
							<span
								id="market_asset_price_alerts_enabled_label"
								class="text-base font-semibold text-heading"
							>
								Realtime Asset Price Alerts
							</span>
							<MassiveLogoIcon class="h-4.5 w-auto shrink-0" aria-label="Powered by Massive" role="img" />
							<GrokLogoLightIcon class="h-4.5 w-auto shrink-0 dark:hidden" aria-label="Powered by Grok" role="img" />
							<GrokLogoDarkIcon class="hidden h-4.5 w-auto shrink-0 dark:inline" aria-label="Powered by Grok" role="img" />
						</div>
						<p id="market_asset_price_alerts_enabled_description" class="text-sm text-body-secondary mt-0.5">
							Immediate alerts for significant price movement. Alerts may include related headlines and a brief AI summary when available.
						</p>
						<details class="mt-2 group">
							<summary
								class="text-xs font-medium text-emerald-700 cursor-pointer hover:text-emerald-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded"
							>
								How asset price alerts work
							</summary>
							<div class="mt-2 rounded-md border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
								<ul class="list-disc pl-4 space-y-1">
									<li>Runs only during US market hours and checks symbols you track.</li>
									<li>Builds a score from rapid price moves, breakouts, and breaking news.</li>
									<li>Sends an alert when the score crosses the configured threshold, with price and signal context.</li>
									<li>May include recent headlines and an AI summary when relevant context is available.</li>
									<li>Uses a cooldown per symbol to avoid repeated alerts in a short window.</li>
									<li>News and Rumors is separate and delivered through Daily Digest (email-only).</li>
								</ul>
							</div>
						</details>
					</div>
					<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4 shrink-0">
						<label class="inline-flex items-center gap-1.5 cursor-pointer">
							<input
								type="checkbox"
								v-model="priceAlertsIncludeEmail"
								:disabled="needsChannelSelection || !emailEnabled"
								class="rounded border-edge-strong text-emerald-600 focus:ring-emerald-500 h-4 w-4 cursor-pointer"
								aria-describedby="market_asset_price_alerts_enabled_description"
							/>
							<span class="text-sm text-label">Email</span>
						</label>
						<label class="inline-flex items-center gap-1.5" :class="smsReady ? 'cursor-pointer' : needsChannelSelection ? 'cursor-not-allowed' : 'cursor-not-allowed opacity-50'">
							<input
								type="checkbox"
								v-model="priceAlertsIncludeSms"
								:disabled="needsChannelSelection || !smsReady"
								class="rounded border-edge-strong text-emerald-600 focus:ring-emerald-500 h-4 w-4 cursor-pointer"
								aria-describedby="market_asset_price_alerts_enabled_description"
							/>
							<span class="text-sm text-label">SMS</span>
						</label>
					</div>
				</div>

				<FadeTransition>
					<div v-if="priceAlertsEnabled" class="mt-3 border-t border-divider pt-3 pl-3 sm:pl-4">
						<fieldset :disabled="needsChannelSelection">
							<legend class="text-sm font-medium text-label mb-2">
								Price Sensitivity
							</legend>
							<div
								class="inline-flex rounded-lg border border-edge bg-surface-alt p-0.5"
								role="radiogroup"
								aria-label="Alert sensitivity level"
							>
								<label
									v-for="option in SENSITIVITY_OPTIONS"
									:key="option.value"
									class="relative cursor-pointer rounded-md px-3.5 py-1.5 text-sm font-medium transition-all duration-150 select-none focus-within:z-10 focus-within:ring-2 focus-within:ring-emerald-500 focus-within:ring-offset-1"
									:class="
										priceAlertSensitivity === option.value
											? 'bg-surface text-heading shadow-sm border border-edge'
											: 'text-muted hover:text-label border border-transparent'
									"
								>
									<input
										type="radio"
										:value="option.value"
										v-model.number="priceAlertSensitivity"
										class="sr-only"
										name="price_alert_sensitivity_radio"
									/>
									{{ option.label }}
								</label>
							</div>
						<p class="mt-2 text-xs" :class="isAggressivePriceSensitivity ? 'text-amber-600' : 'text-muted'">
							<span v-if="isAggressivePriceSensitivity" class="inline-flex items-start gap-1">
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

			</fieldset>
			</div>
		</section>
	</form>

</template>

<script lang="ts" setup>
import { computed, ref, toRefs, watch } from "vue";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import ArrowPathIcon from "../../../icons/arrow-path.svg?component";
import GrokLogoDarkIcon from "../../../icons/grok-dark.svg?component";
import GrokLogoLightIcon from "../../../icons/grok-light.svg?component";
import InformationCircleIcon from "../../../icons/information-circle-20.svg?component";
import MassiveLogoIcon from "../../../icons/massive.svg?component";
import {
	CARD_GRADIENT_ACCENTS,
	DASHBOARD_MARKET_FORM_ID,
	DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID,
	DASHBOARD_SECTION_IDS,
	DEFAULT_MARKET_UPDATE_TIME_MINUTES,
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
import SetupRequiredNotice from "../shared/SetupRequiredNotice.vue";
import { useScheduledUpdateTiming } from "./helpers";
import ScheduledUpdateControls from "./ScheduledUpdateControls.vue";

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

const marketIncludeEmail = ref(user.value.market_scheduled_asset_price_include_email);
const marketIncludeSms = ref(user.value.market_scheduled_asset_price_include_sms);
const marketNotificationsEnabled = computed(
	() => marketIncludeEmail.value || marketIncludeSms.value,
);

const priceAlertsIncludeEmail = ref(user.value.market_asset_price_alerts_include_email);
const priceAlertsIncludeSms = ref(user.value.market_asset_price_alerts_include_sms);
const priceAlertsEnabled = computed(
	() => priceAlertsIncludeEmail.value || priceAlertsIncludeSms.value,
);
const priceAlertSensitivity = ref<number>(user.value.market_asset_price_alert_sensitivity ?? 1);

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
	() => SENSITIVITY_DESCRIPTIONS[priceAlertSensitivity.value] ?? SENSITIVITY_DESCRIPTIONS[1],
);

const isAggressivePriceSensitivity = computed(() => priceAlertSensitivity.value === 3);

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
	normalizeScheduledTimes(user.value.market_scheduled_asset_price_times ?? []),
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
	return formatMinutesAsLocalTime(marketOpenLocalMinutes.value, user.value.use_24_hour_time);
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
	() => user.value.market_scheduled_asset_price_include_email,
	(value) => {
		marketIncludeEmail.value = value;
	},
);
watch(
	() => user.value.market_scheduled_asset_price_include_sms,
	(value) => {
		marketIncludeSms.value = value;
	},
);
watch(
	() => user.value.market_asset_price_alerts_include_email,
	(value) => {
		priceAlertsIncludeEmail.value = value;
	},
);
watch(
	() => user.value.market_asset_price_alerts_include_sms,
	(value) => {
		priceAlertsIncludeSms.value = value;
	},
);
watch(
	() => user.value.market_asset_price_alert_sensitivity,
	(value) => {
		priceAlertSensitivity.value = value ?? 1;
	},
);
watch(
	() => user.value.market_scheduled_asset_price_times,
	(value) => {
		scheduledUpdateTimesMinutes.value = normalizeScheduledTimes(value ?? []);
	},
);

const nextSendAt = computed(
	() =>
		savedScheduledData.value?.market_scheduled_asset_price_next_send_at ??
			user.value.market_scheduled_asset_price_next_send_at ??
			null,
);
const is24 = computed(() => user.value.use_24_hour_time);
const { countdownText, countdownDelayReasons, countdownHolidayName } = useScheduledUpdateTiming({
	timezone,
	nextSendAtIso: nextSendAt,
	timeInputs: scheduledUpdateTimes,
	is24,
});

// Update shared user ref directly when auto-save response arrives
watch(
	() => savedScheduledData.value,
	(newData) => {
		if (newData) {
		user.value = {
			...user.value,
			market_scheduled_asset_price_enabled: newData.market_scheduled_asset_price_enabled,
			market_scheduled_asset_price_include_email: newData.market_scheduled_asset_price_include_email,
			market_scheduled_asset_price_include_sms: newData.market_scheduled_asset_price_include_sms,
			market_scheduled_asset_price_times: newData.market_scheduled_asset_price_times,
			market_scheduled_asset_price_next_send_at: newData.market_scheduled_asset_price_next_send_at,
			// Keep other panels' scheduling in sync with the server response.
			daily_digest_next_send_at: newData.daily_digest_next_send_at,
			asset_events_next_send_at: newData.asset_events_next_send_at,
			// Sync price alerts state from server response
			...(newData.market_asset_price_alerts_enabled !== undefined && {
				market_asset_price_alerts_enabled: newData.market_asset_price_alerts_enabled,
			}),
			...(newData.market_asset_price_alerts_include_email !== undefined && {
				market_asset_price_alerts_include_email: newData.market_asset_price_alerts_include_email,
			}),
			...(newData.market_asset_price_alerts_include_sms !== undefined && {
				market_asset_price_alerts_include_sms: newData.market_asset_price_alerts_include_sms,
			}),
			...(newData.market_asset_price_alert_sensitivity !== undefined && {
				market_asset_price_alert_sensitivity: newData.market_asset_price_alert_sensitivity,
			}),
		};
		}
	},
);

watch([marketIncludeEmail, marketIncludeSms], ([email, sms]) => {
	if (
		email === user.value.market_scheduled_asset_price_include_email &&
		sms === user.value.market_scheduled_asset_price_include_sms
	) {
		return;
	}
	user.value = {
		...user.value,
		market_scheduled_asset_price_include_email: email,
		market_scheduled_asset_price_include_sms: sms,
		market_scheduled_asset_price_enabled: email || sms,
	};
	notifyChange();
});

watch(priceAlertSensitivity, (value) => {
	if (value === (user.value.market_asset_price_alert_sensitivity ?? 1)) {
		return;
	}
	user.value = {
		...user.value,
		market_asset_price_alert_sensitivity: value,
	};
	notifyChange();
});

watch([priceAlertsIncludeEmail, priceAlertsIncludeSms], ([email, sms]) => {
	if (
		email === user.value.market_asset_price_alerts_include_email &&
		sms === user.value.market_asset_price_alerts_include_sms
	) {
		return;
	}
	user.value = {
		...user.value,
		market_asset_price_alerts_include_email: email,
		market_asset_price_alerts_include_sms: sms,
		market_asset_price_alerts_enabled: email || sms,
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
		scheduledUpdateTimesMinutes.value = [marketOpenLocalMinutes.value ?? DEFAULT_MARKET_UPDATE_TIME_MINUTES];
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
