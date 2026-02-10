<template>
	<form
		ref="weeklyFormElement"
		:id="DASHBOARD_WEEKLY_CALENDAR_FORM_ID"
		method="POST"
		action="/api/notification-preferences/update"
		aria-label="Weekly Calendar Notifications"
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

			<div :class="`card-accent ${CARD_GRADIENT_ACCENTS.purple}`"></div>
			<div class="card-body">
				<header class="mb-4">
					<h2
						:id="DASHBOARD_SECTION_IDS.occasionalNotifications"
						class="text-xl sm:text-2xl font-bold text-gray-900"
					>
						Weekly Calendar
					</h2>
				<p class="text-sm text-gray-600 mt-1">
					Everything you enable below is bundled into <strong class="font-semibold text-gray-700">one weekly message</strong> every Monday — covering upcoming earnings for your tracked assets.
				</p>
					<p
						v-if="deliveryTimeLabel"
						class="text-sm text-gray-500 mt-1.5 transition-opacity duration-200"
						:class="{ 'opacity-50': needsChannelSelection }"
					>
						<span class="inline-flex items-center gap-1.5">
							<ClockIcon class="size-4 shrink-0 text-gray-400" aria-hidden="true" />
							<span>
								Delivered Mondays at
								<span class="font-medium text-gray-700">{{ deliveryTimeLabel }}</span>
								<span v-if="timezoneLabel" class="text-gray-400"> ({{ timezoneLabel }})</span>
								<template v-if="hasDailyDeliveryTime">
									— synced with your
									<button
										type="button"
										class="underline cursor-pointer hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 rounded"
										@click="scrollToDailyNotifications"
									>daily delivery time</button>.
								</template>
								<template v-else>
									— set your
									<button
										type="button"
										class="underline cursor-pointer hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 rounded"
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

				<fieldset
					class="divide-y divide-gray-100 transition-opacity duration-200"
					:class="{ 'opacity-50': needsChannelSelection }"
					:aria-disabled="needsChannelSelection ? 'true' : undefined"
				>
					<legend class="sr-only">Weekly calendar settings</legend>

					<div class="flex items-center justify-between gap-3 py-3">
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
									📅 Earnings Reports
								</span>
								<FinnhubLogoIcon class="h-4.5 w-auto shrink-0" aria-label="Powered by Finnhub" role="img" />
							</div>
							<p
								id="weekly_include_earnings_description"
								class="text-sm text-gray-600 mt-0.5"
							>
								See which of your tracked stocks report earnings this week. <span class="text-gray-400 italic">Stocks only.</span>
							</p>
						</div>
						<div class="flex items-center gap-4 shrink-0">
							<label class="inline-flex items-center gap-1.5" :class="smsReady ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'">
								<input
									type="checkbox"
									v-model="includeEarningsSms"
									:disabled="needsChannelSelection || !smsReady"
									class="rounded border-gray-300 text-purple-600 focus:ring-purple-500 h-4 w-4 cursor-pointer"
									aria-describedby="weekly_include_earnings_description"
								/>
								<span class="text-sm text-gray-700">SMS</span>
							</label>
							<label class="inline-flex items-center gap-1.5" :class="needsChannelSelection ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'">
								<input
									type="checkbox"
									v-model="includeEarningsEmail"
									:disabled="needsChannelSelection"
									class="rounded border-gray-300 text-purple-600 focus:ring-purple-500 h-4 w-4"
									:class="needsChannelSelection ? 'cursor-not-allowed' : 'cursor-pointer'"
									aria-describedby="weekly_include_earnings_description"
								/>
								<span class="text-sm text-gray-700">Email</span>
							</label>
						</div>
					</div>

					</fieldset>

				<div v-if="isHydrated && nextWeeklyDeliveryText" class="mt-4 border-t border-gray-200 pt-4">
					<p class="inline-flex items-center gap-2 text-sm text-gray-600">
						<BellAlertIcon class="size-4 shrink-0 text-success-strong" aria-hidden="true" />
						<span>Next delivery <span class="font-medium text-gray-900">{{ nextWeeklyDeliveryText }}</span>.</span>
					</p>
				</div>
			</div>
		</section>
	</form>
</template>

<script lang="ts" setup>
import { DateTime } from "luxon";
import { computed, onMounted, onUnmounted, ref, toRefs, watch } from "vue";
import ArrowPathIcon from "../../icons/arrow-path.svg?component";
import BellAlertIcon from "../../icons/bell-alert.svg?component";
import ClockIcon from "../../icons/clock.svg?component";
import FinnhubLogoIcon from "../../icons/finnhub.svg?component";
import {
	CARD_GRADIENT_ACCENTS,
	DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID,
	DASHBOARD_SECTION_IDS,
	DASHBOARD_WEEKLY_CALENDAR_FORM_ID,
	STATUS_TONE_CLASSES,
} from "../../lib/constants";
import {
	formatCountdownWithSeconds,
	formatMinutesAsLocalTime,
} from "../../lib/time/format";
import { calculateNextMondaySendAt } from "../../lib/time/scheduled-times";
import FadeTransition from "../FadeTransition.vue";
import {
	type NotificationPreferencesData,
	useAutoSaveForm,
} from "./composables/useAutoSaveNotificationPreferences";
import { useDashboardUser } from "./composables/useDashboardUser";
import SetupRequiredNotice from "./scheduled-notifications/SetupRequiredNotice.vue";

interface Props {
	emailEnabled: boolean;
	smsEnabled: boolean;
	phoneVerified: boolean;
}

const DEFAULT_DELIVERY_MINUTES = 540; // 9:00 AM

const props = defineProps<Props>();
const { emailEnabled, smsEnabled, phoneVerified } = toRefs(props);

const user = useDashboardUser();

const smsReady = computed(() => smsEnabled.value && phoneVerified.value);
const hasNotificationChannel = computed(() => emailEnabled.value || smsReady.value);
const needsChannelSelection = computed(() => !hasNotificationChannel.value);
const needsPhoneVerification = computed(() => smsEnabled.value && !phoneVerified.value);
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
});
onUnmounted(() => {
	if (intervalId === null) return;
	window.clearInterval(intervalId);
	intervalId = null;
});

const weeklyFormElement = ref<HTMLFormElement | null>(null);
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
	formRef: weeklyFormElement,
});

const includeEarningsEmail = ref(user.value.weekly_include_earnings_email);
const includeEarningsSms = ref(user.value.weekly_include_earnings_sms);

const weeklyEnabled = computed(
	() =>
		includeEarningsEmail.value ||
		includeEarningsSms.value,
);

const hasDailyDeliveryTime = computed(() => user.value.daily_delivery_time != null);

const deliveryTimeMinutes = computed(() =>
	user.value.daily_delivery_time ?? DEFAULT_DELIVERY_MINUTES,
);

const deliveryTimeLabel = computed(() =>
	formatMinutesAsLocalTime(deliveryTimeMinutes.value),
);

const timezoneLabel = computed(() => {
	if (!user.value.timezone) return null;
	const dt = DateTime.now().setZone(user.value.timezone);
	return dt.isValid ? dt.toFormat("ZZZZ") : null;
});

function scrollToDailyNotifications() {
	const el = document.getElementById(DASHBOARD_SECTION_IDS.dailyNotifications);
	if (el) {
		el.scrollIntoView({ behavior: "smooth" });
	}
}

const nextWeeklyDeliveryText = computed(() => {
	if (!isHydrated.value || !weeklyEnabled.value) return null;
	void tick.value;

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

	// next_send_at is missing or in the past; fall back to computing the next Monday.
	const tz = user.value.timezone;
	if (!tz) return null;
	const nextMonday = calculateNextMondaySendAt(deliveryTimeMinutes.value, tz, now);
	if (!nextMonday) return null;
	const fallbackSeconds = Math.ceil(nextMonday.diff(now, "seconds").seconds);
	if (fallbackSeconds <= 0) return null;
	return `in ${formatCountdownWithSeconds(fallbackSeconds)}`;
});

watch([includeEarningsEmail, includeEarningsSms], () => {
	notifyChange();
});

// Sync from user prop changes
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
// Keep dashboard user state aligned with autosave responses
watch(savedData, (newData) => {
	if (!newData) return;
	user.value = {
		...user.value,
		weekly_include_earnings_email: newData.weekly_include_earnings_email,
		weekly_include_earnings_sms: newData.weekly_include_earnings_sms,
		weekly_next_send_at: newData.weekly_next_send_at,
		// Keep other panels' scheduling in sync with the server response.
		daily_next_send_at: newData.daily_next_send_at,
		next_send_at: newData.next_send_at,
	};
});
</script>
