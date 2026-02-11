<template>
	<form
		ref="extrasFormElement"
		:id="DASHBOARD_DAILY_NOTIFICATIONS_FORM_ID"
		method="POST"
		action="/api/notification-preferences/update"
		aria-label="Daily Digest"
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

			<div :class="`card-accent ${CARD_GRADIENT_ACCENTS.teal}`"></div>
			<div class="card-body">
			<header class="mb-4">
				<h2
					:id="DASHBOARD_SECTION_IDS.dailyNotifications"
					class="text-xl sm:text-2xl font-bold text-gray-900"
				>
					Daily Digest
				</h2>
			<p
				class="text-sm text-gray-600 mt-1"
			>
				Everything you enable below is bundled into <strong class="font-semibold text-gray-700">one daily message</strong> sent at the time you choose — separate from market price alerts.
			</p>
			</header>

		<SetupRequiredNotice
			:needsChannelSelection="needsChannelSelection"
			:needsPhoneVerification="needsPhoneVerification"
			:phoneVerificationSectionId="phoneVerificationSectionId"
		/>

			<FadeTransition>
				<p
					v-if="dailyEnabled && dailyDeliveryTimeMinutes === null"
					class="flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm bg-info-bg border border-info-border text-info-text"
					role="note"
				>
					<InformationCircleIcon class="size-5 shrink-0 mt-0.5" aria-hidden="true" />
					<span>No daily digest will be sent until you choose a notification time.</span>
				</p>
			</FadeTransition>

	<fieldset
			class="divide-y divide-gray-100 transition-opacity duration-200"
				:class="{ 'opacity-50': needsChannelSelection }"
				:aria-disabled="needsChannelSelection ? 'true' : undefined"
			>
					<legend class="sr-only">Daily digest settings</legend>

				<div class="flex items-center justify-between gap-3 py-3">
					<input
						type="hidden"
					name="daily_include_news_email"
					:value="includeNewsEmail ? 'on' : 'off'"
				/>
				<div class="min-w-0">
					<div class="flex items-center gap-2">
						<span
							id="daily_include_news_label"
								class="text-base font-semibold text-gray-900"
							>
								🗞️ News
							</span>
							<GrokLogoIcon class="h-4.5 w-auto shrink-0" aria-label="Powered by Grok" role="img" />
							<FinnhubLogoIcon class="h-4.5 w-auto shrink-0" aria-label="Powered by Finnhub" role="img" />
						</div>
						<p
							id="daily_include_news_description"
							class="text-sm text-gray-600 mt-0.5"
						>
							Add a short news summary about the assets you're tracking.
						</p>
					</div>
				<div class="shrink-0">
					<label class="inline-flex items-center gap-1.5" :class="emailOnlyDisabled ? 'cursor-not-allowed' : 'cursor-pointer'">
						<input
							type="checkbox"
							v-model="includeNewsEmail"
							:disabled="emailOnlyDisabled"
							class="rounded border-gray-300 text-teal-600 focus:ring-teal-500 h-4 w-4"
							:class="emailOnlyDisabled ? 'cursor-not-allowed' : 'cursor-pointer'"
							aria-describedby="daily_include_news_description"
						/>
						<span class="text-sm text-gray-700">Email</span>
					</label>
				</div>
				</div>

				<div class="flex items-center justify-between gap-3 py-3">
					<input
						type="hidden"
					name="daily_include_rumors_email"
					:value="includeRumorsEmail ? 'on' : 'off'"
				/>
				<div class="min-w-0">
					<div class="flex items-center gap-2">
						<span
							id="daily_include_rumors_label"
								class="text-base font-semibold text-gray-900"
							>
								🤫 Rumors
							</span>
							<GrokLogoIcon class="h-4.5 w-auto shrink-0" aria-label="Powered by Grok" role="img" />
						</div>
						<p
							id="daily_include_rumors_description"
							class="text-sm text-gray-600 mt-0.5"
						>
							Add a short rumors/chatter summary about the assets you're tracking.
						</p>
					</div>
				<div class="shrink-0">
					<label class="inline-flex items-center gap-1.5" :class="emailOnlyDisabled ? 'cursor-not-allowed' : 'cursor-pointer'">
						<input
							type="checkbox"
							v-model="includeRumorsEmail"
							:disabled="emailOnlyDisabled"
							class="rounded border-gray-300 text-teal-600 focus:ring-teal-500 h-4 w-4"
							:class="emailOnlyDisabled ? 'cursor-not-allowed' : 'cursor-pointer'"
							aria-describedby="daily_include_rumors_description"
						/>
						<span class="text-sm text-gray-700">Email</span>
					</label>
				</div>
				</div>

					<div class="flex items-center justify-between gap-3 py-3">
						<input
							type="hidden"
							name="daily_include_analyst_email"
							:value="includeAnalystEmail ? 'on' : 'off'"
						/>
						<input
							type="hidden"
							name="daily_include_analyst_sms"
							:value="includeAnalystSms ? 'on' : 'off'"
						/>
						<div class="min-w-0">
							<div class="flex items-center gap-2">
							<span
								id="daily_include_analyst_label"
								class="text-base font-semibold text-gray-900"
							>
								📊 Analyst Consensus
							</span>
							<FinnhubLogoIcon class="h-4.5 w-auto shrink-0" aria-label="Powered by Finnhub" role="img" />
							</div>
							<p
								id="daily_include_analyst_description"
								class="text-sm text-gray-600 mt-0.5"
							>
								See how analysts rate the stocks you're tracking (buy/hold/sell). <span class="text-gray-500 italic">Stocks only.</span>
							</p>
						</div>
						<div class="flex items-center gap-4 shrink-0">
							<label class="inline-flex items-center gap-1.5" :class="smsReady ? 'cursor-pointer' : needsChannelSelection ? 'cursor-not-allowed' : 'cursor-not-allowed opacity-50'">
								<input
									type="checkbox"
									v-model="includeAnalystSms"
									:disabled="needsChannelSelection || !smsReady"
									class="rounded border-gray-300 text-teal-600 focus:ring-teal-500 h-4 w-4 cursor-pointer"
									aria-describedby="daily_include_analyst_description"
								/>
								<span class="text-sm text-gray-700">SMS</span>
							</label>
							<label class="inline-flex items-center gap-1.5" :class="needsChannelSelection ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'">
								<input
									type="checkbox"
									v-model="includeAnalystEmail"
									:disabled="needsChannelSelection"
									class="rounded border-gray-300 text-teal-600 focus:ring-teal-500 h-4 w-4"
									:class="needsChannelSelection ? 'cursor-not-allowed' : 'cursor-pointer'"
									aria-describedby="daily_include_analyst_description"
								/>
								<span class="text-sm text-gray-700">Email</span>
							</label>
						</div>
					</div>

					<div class="flex items-center justify-between gap-3 py-3">
						<input
							type="hidden"
							name="daily_include_insider_email"
							:value="includeInsiderEmail ? 'on' : 'off'"
						/>
						<input
							type="hidden"
							name="daily_include_insider_sms"
							:value="includeInsiderSms ? 'on' : 'off'"
						/>
						<div class="min-w-0">
							<div class="flex items-center gap-2">
							<span
								id="daily_include_insider_label"
								class="text-base font-semibold text-gray-900"
							>
								🏦 Insider Trades
							</span>
							<FinnhubLogoIcon class="h-4.5 w-auto shrink-0" aria-label="Powered by Finnhub" role="img" />
							</div>
							<p
								id="daily_include_insider_description"
								class="text-sm text-gray-600 mt-0.5"
							>
								Recent insider buying and selling activity from SEC filings. <span class="text-gray-500 italic">Stocks only.</span>
							</p>
						</div>
						<div class="flex items-center gap-4 shrink-0">
							<label class="inline-flex items-center gap-1.5" :class="smsReady ? 'cursor-pointer' : needsChannelSelection ? 'cursor-not-allowed' : 'cursor-not-allowed opacity-50'">
								<input
									type="checkbox"
									v-model="includeInsiderSms"
									:disabled="needsChannelSelection || !smsReady"
									class="rounded border-gray-300 text-teal-600 focus:ring-teal-500 h-4 w-4 cursor-pointer"
									aria-describedby="daily_include_insider_description"
								/>
								<span class="text-sm text-gray-700">SMS</span>
							</label>
							<label class="inline-flex items-center gap-1.5" :class="needsChannelSelection ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'">
								<input
									type="checkbox"
									v-model="includeInsiderEmail"
									:disabled="needsChannelSelection"
									class="rounded border-gray-300 text-teal-600 focus:ring-teal-500 h-4 w-4"
									:class="needsChannelSelection ? 'cursor-not-allowed' : 'cursor-pointer'"
									aria-describedby="daily_include_insider_description"
								/>
								<span class="text-sm text-gray-700">Email</span>
							</label>
						</div>
					</div>

			<div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 py-3">
				<div class="min-w-0">
					<span
						id="daily_delivery_time_label"
						class="text-base font-semibold text-gray-900"
					>
						Delivery time
					</span>
					<p
						id="daily_delivery_time_description"
						class="text-sm text-gray-600 mt-0.5"
					>
						Sent once every day.
					</p>
				</div>
		<div class="sm:shrink-0">
			<div class="flex flex-col sm:flex-row sm:items-center gap-2">
					<TimePicker
						:inputId="`daily_delivery_time`"
						:inputName="`daily_delivery_time`"
						:initialTime="dailyDeliveryTimeInput"
						inputAriaLabel="Daily digest delivery time"
						:disabled="needsChannelSelection"
						:clearable="dailyDeliveryTimeMinutes !== null && !needsChannelSelection"
						clearAriaLabel="Clear delivery time"
						@time-change="handleDailyTimeChange"
						@clear="handleClearDeliveryTime"
					/>
					<button
						v-if="marketOpenLabel"
						type="button"
						class="btn btn-md btn-secondary h-[41px] shrink-0 whitespace-nowrap"
						:disabled="!canSetMarketOpen"
						:aria-label="`Set delivery time to US market open (${marketOpenLabel})`"
						@click="handleSetMarketOpen"
					>
						<PresentationChartLineIcon class="size-4 shrink-0" aria-hidden="true" />
						Market open
					</button>
				</div>
			</div>
			</div>
				</fieldset>

				<div v-if="isHydrated && nextDailyDeliveryText" class="mt-4 border-t border-gray-200 pt-4">
					<p class="inline-flex items-center gap-2 text-sm text-gray-600">
						<BellAlertIcon class="size-4 shrink-0 text-success-strong" aria-hidden="true" />
						<span>Next delivery <span class="font-medium text-gray-900">{{ nextDailyDeliveryText }}</span>.</span>
					</p>
				</div>
			</div>
		</section>
	</form>
</template>

<script lang="ts" setup>
import { DateTime } from "luxon";
import { computed, onMounted, onUnmounted, ref, toRefs, watch } from "vue";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import ArrowPathIcon from "../../icons/arrow-path.svg?component";
import BellAlertIcon from "../../icons/bell-alert.svg?component";
import FinnhubLogoIcon from "../../icons/finnhub.svg?component";
import GrokLogoIcon from "../../icons/grok.svg?component";
import InformationCircleIcon from "../../icons/information-circle-20.svg?component";
import PresentationChartLineIcon from "../../icons/presentation-chart-line.svg?component";
import {
	CARD_GRADIENT_ACCENTS,
	DASHBOARD_DAILY_NOTIFICATIONS_FORM_ID,
	DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID,
	DASHBOARD_SECTION_IDS,
	STATUS_TONE_CLASSES,
} from "../../lib/constants";
import {
	formatCountdownWithSeconds,
	formatMinutesAsLocalTime,
	getSecondsUntilNextSend,
	getUsMarketOpenLocalMinutes,
	minutesToTimeInputValue,
	parseTimeToMinutes,
} from "../../lib/time/format";
import FadeTransition from "../FadeTransition.vue";
import {
	type NotificationPreferencesData,
	useAutoSaveForm,
} from "./composables/useAutoSaveNotificationPreferences";
import { useDashboardUser } from "./composables/useDashboardUser";
import SetupRequiredNotice from "./scheduled-notifications/SetupRequiredNotice.vue";
import TimePicker from "./scheduled-notifications/TimePicker.vue";

interface Props {
	emailEnabled: boolean;
	smsEnabled: boolean;
	phoneVerified: boolean;
}

const props = defineProps<Props>();
const { emailEnabled, smsEnabled, phoneVerified } = toRefs(props);

const user = useDashboardUser();

const smsReady = computed(() => smsEnabled.value && phoneVerified.value);
const hasNotificationChannel = computed(() => emailEnabled.value || smsReady.value);
const needsChannelSelection = computed(() => !hasNotificationChannel.value);
const needsPhoneVerification = computed(() => smsEnabled.value && !phoneVerified.value);

/** News & Rumors are email-only — disable when email channel isn't enabled */
const emailOnlyDisabled = computed(() => needsChannelSelection.value || !emailEnabled.value);
const phoneVerificationSectionId = `${DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID}-phone-verification-section`;

const isHydrated = ref(false);
const tick = ref(0);
let intervalId: number | null = null;

onMounted(() => {
	isHydrated.value = true;
	tick.value = Date.now();
	intervalId = window.setInterval(() => {
		tick.value = Date.now();
	}, 1000);

	if (dailyEnabled.value) {
		// On initial mount we may "inherit" a time from market notifications for display,
		// but we should not autosave during hydration.
		maybeDefaultToMarketTime();
	}
});
onUnmounted(() => {
	if (intervalId === null) return;
	window.clearInterval(intervalId);
	intervalId = null;
});

const extrasFormElement = ref<HTMLFormElement | null>(null);
const {
	handleFormChange,
	handleFormInput,
	handleFormSubmit,
	isSaving,
	notifyChange,
	savedData,
	statusMessage,
	statusTone,
} = useAutoSaveForm<NotificationPreferencesData>({
	formRef: extrasFormElement,
});

const includeNewsEmail = ref(user.value.daily_include_news_email);
const includeRumorsEmail = ref(user.value.daily_include_rumors_email);
const includeAnalystEmail = ref(user.value.daily_include_analyst_email);
const includeInsiderEmail = ref(user.value.daily_include_insider_email);
const includeAnalystSms = ref(user.value.daily_include_analyst_sms);
const includeInsiderSms = ref(user.value.daily_include_insider_sms);
const dailyDeliveryTimeMinutes = ref<number | null>(
	user.value.daily_delivery_time ?? getEarliestMarketNotificationTime(),
);

const dailyEnabled = computed(() =>
	includeNewsEmail.value || includeRumorsEmail.value || includeAnalystEmail.value || includeInsiderEmail.value || includeAnalystSms.value || includeInsiderSms.value,
);

/**
 * When the daily digest is enabled but no delivery time is set,
 * default to the earliest scheduled market notification time (if any).
 * The user can still change to a different time.
 */
function getEarliestMarketNotificationTime(): number | null {
	const times = user.value.scheduled_update_times;
	if (!times || times.length === 0) return null;
	return Math.min(...times);
}

/**
 * If the daily digest is enabled but no explicit daily delivery time is set,
 * inherit the earliest scheduled market notification time for display (and optional save).
 */
function maybeDefaultToMarketTime(): boolean {
	if (dailyDeliveryTimeMinutes.value !== null) return false;
	const earliestMarketNotificationTime = getEarliestMarketNotificationTime();
	if (earliestMarketNotificationTime === null) return false;
	dailyDeliveryTimeMinutes.value = earliestMarketNotificationTime;
	return true;
}

const dailyDeliveryTimeInput = computed(() =>
	dailyDeliveryTimeMinutes.value !== null
		? minutesToTimeInputValue(dailyDeliveryTimeMinutes.value)
		: null,
);

const marketOpenLocalMinutes = computed(() =>
	user.value.timezone ? getUsMarketOpenLocalMinutes(user.value.timezone) : null,
);

const marketOpenLabel = computed(() =>
	marketOpenLocalMinutes.value !== null
		? formatMinutesAsLocalTime(marketOpenLocalMinutes.value)
		: null,
);

const isMarketOpenTime = computed(() => {
	if (marketOpenLocalMinutes.value === null) return true;
	return dailyDeliveryTimeMinutes.value === marketOpenLocalMinutes.value;
});

const canSetMarketOpen = computed(
	() => !needsChannelSelection.value && !isMarketOpenTime.value,
);

/** Clear the daily digest delivery time (disables sending unless inherited elsewhere). */
function handleClearDeliveryTime() {
	if (needsChannelSelection.value) return;
	dailyDeliveryTimeMinutes.value = null;
	notifyChange();
}

/** Set the daily digest delivery time to the user's local US market-open time. */
function handleSetMarketOpen() {
	if (!canSetMarketOpen.value || marketOpenLocalMinutes.value === null) {
		return;
	}
	dailyDeliveryTimeMinutes.value = marketOpenLocalMinutes.value;
	notifyChange();
}

const nextDailyDeliveryText = computed(() => {
	if (!isHydrated.value || !dailyEnabled.value) return null;
	void tick.value;

	if (!user.value.timezone) return null;

	const secondsUntil = getSecondsUntilNextSend({
		nextSendAtIso: user.value.daily_next_send_at,
		timeInput: dailyDeliveryTimeInput.value,
		timezone: user.value.timezone,
		now: DateTime.utc(),
	});
	if (secondsUntil === null) return null;
	return secondsUntil <= 0 ? "is due soon" : `in ${formatCountdownWithSeconds(secondsUntil)}`;
});

watch(
	[includeNewsEmail, includeRumorsEmail, includeAnalystEmail, includeInsiderEmail, includeAnalystSms, includeInsiderSms],
	() => {
		notifyChange();
	},
);

watch(dailyEnabled, (enabled) => {
	if (enabled) {
		// When a user enables the daily digest, default to market time (if needed)
		// and explicitly notify so the defaulted time is persisted.
		const didDefault = maybeDefaultToMarketTime();
		if (didDefault) {
			notifyChange();
		}
	}
});

function handleDailyTimeChange(value: string) {
	const parsed = parseTimeToMinutes(value);
	if (parsed === null) return;
	dailyDeliveryTimeMinutes.value = parsed;
	notifyChange();
}

watch(
	() => user.value.daily_include_news_email,
	(value) => {
		includeNewsEmail.value = value;
	},
);
watch(
	() => user.value.daily_include_rumors_email,
	(value) => {
		includeRumorsEmail.value = value;
	},
);
watch(
	() => user.value.daily_include_analyst_email,
	(value) => {
		includeAnalystEmail.value = value;
	},
);
watch(
	() => user.value.daily_include_insider_email,
	(value) => {
		includeInsiderEmail.value = value;
	},
);
watch(
	() => user.value.daily_include_analyst_sms,
	(value) => {
		includeAnalystSms.value = value;
	},
);
watch(
	() => user.value.daily_include_insider_sms,
	(value) => {
		includeInsiderSms.value = value;
	},
);
watch(
	() => user.value.daily_delivery_time,
	(value) => {
		dailyDeliveryTimeMinutes.value = value ?? getEarliestMarketNotificationTime();
	},
);
watch(
	() => user.value.scheduled_update_times,
	(times) => {
		if (user.value.daily_delivery_time !== null) return;
		dailyDeliveryTimeMinutes.value =
			times && times.length > 0 ? getEarliestMarketNotificationTime() : null;
	},
);
/* =============
Keep dashboard user state aligned with autosave responses
============= */
watch(savedData, (newData) => {
	if (!newData) return;
	user.value = {
		...user.value,
		daily_include_news_email: newData.daily_include_news_email,
		daily_include_rumors_email: newData.daily_include_rumors_email,
		daily_include_analyst_email: newData.daily_include_analyst_email,
		daily_include_insider_email: newData.daily_include_insider_email,
		daily_include_analyst_sms: newData.daily_include_analyst_sms,
		daily_include_insider_sms: newData.daily_include_insider_sms,
		daily_delivery_time: newData.daily_delivery_time,
		daily_next_send_at: newData.daily_next_send_at,
		// Daily delivery time determines the weekly delivery time, so the server
		// recalculates weekly_next_send_at when it changes. Keep all panels'
		// scheduling in sync so countdowns update without a page refresh.
		weekly_next_send_at: newData.weekly_next_send_at,
		next_send_at: newData.next_send_at,
	};
});
</script>

