<template>
	<form
		ref="extrasFormElement"
		:id="DASHBOARD_ADDITIONAL_NOTIFICATIONS_FORM_ID"
		method="POST"
		action="/api/notification-preferences/update"
		class="space-y-6"
		aria-label="Additional Notifications"
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

			<div :class="`h-1 ${CARD_GRADIENT_ACCENTS.teal}`"></div>
			<div class="card-body">
			<header class="mb-4">
				<h2
					:id="DASHBOARD_SECTION_IDS.additionalNotifications"
					class="text-xl sm:text-2xl font-bold text-gray-900"
				>
					Additional Notifications
				</h2>
				<p
					class="text-sm text-gray-600 mt-1"
				>
					A daily notification with your selected extras, sent at the time below — separate from scheduled price alerts.
				</p>
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

			<FadeTransition>
				<p
					v-if="!needsChannelSelection && addOnsDeliveryTimeMinutes === null"
					class="flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm bg-info-bg border border-info-border text-info-text"
					role="note"
				>
					<InformationCircleIcon class="size-5 shrink-0 mt-0.5" aria-hidden="true" />
					<span>No notifications will be sent until you choose a delivery time below.</span>
				</p>
			</FadeTransition>

	<fieldset
			class="divide-y divide-gray-100 transition-opacity duration-200"
				:class="{ 'opacity-50': needsChannelSelection }"
				:aria-disabled="needsChannelSelection ? 'true' : undefined"
			>
					<legend class="sr-only">Additional notifications settings</legend>

			<div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 py-3">
				<div class="min-w-0">
					<span
						id="add_ons_delivery_time_label"
						class="text-base font-semibold text-gray-900"
					>
						Delivery time
					</span>
					<p
						id="add_ons_delivery_time_description"
						class="text-sm text-gray-600 mt-0.5"
					>
						Sent once every day.
					</p>
				</div>
		<div class="sm:shrink-0">
			<div class="flex flex-wrap items-center gap-2">
					<TimePicker
						:inputId="`add_ons_delivery_time`"
						:inputName="`add_ons_delivery_time`"
						:initialTime="addOnsDeliveryTimeInput"
						inputAriaLabel="Additional notifications delivery time"
						:disabled="addOnsTimepickerDisabled"
						@time-change="handleAddOnsTimeChange"
					/>
					<button
						v-if="addOnsDeliveryTimeMinutes !== null"
						type="button"
						class="inline-flex items-center justify-center size-8 shrink-0 rounded-lg text-gray-400 hover:bg-error-bg hover:text-error-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error focus-visible:ring-offset-2"
						:disabled="addOnsTimepickerDisabled"
						aria-label="Clear delivery time"
						@click="handleClearDeliveryTime"
					>
						<XMarkIcon class="size-4" aria-hidden="true" />
					</button>
					<button
						v-if="marketOpenLabel"
						type="button"
						class="btn btn-sm btn-secondary"
						:disabled="!canSetMarketOpen"
						:aria-label="`Set delivery time to US market open (${marketOpenLabel})`"
						@click="handleSetMarketOpen"
					>
						<PresentationChartLineIcon class="size-4 shrink-0" aria-hidden="true" />
						<span class="hidden sm:inline">Market open ({{ marketOpenLabel }} your time)</span>
						<span class="sm:hidden">Market open</span>
					</button>
				</div>
				<p
					v-if="isAddOnsTimeOutsideMarketHours"
					class="text-xs text-amber-600 mt-1"
					role="note"
				>
					Outside regular US market hours — this notification will be skipped.
				</p>
			</div>
			</div>

					<div class="flex items-center justify-between gap-3 py-3">
					<input
						type="hidden"
						name="add_ons_only_notify_when_market_open"
						:value="onlyNotifyWhenMarketOpen ? 'on' : 'off'"
					/>
						<div class="min-w-0">
							<span
								id="only_notify_when_market_open_label_add_ons"
								class="text-base font-semibold text-gray-900"
							>
								Only notify when market is open
							</span>
							<p
								id="only_notify_when_market_open_description_add_ons"
								class="text-sm text-gray-600 mt-0.5"
							>
								You won’t be notified unless the market is open.
							</p>
						</div>
					<ToggleSwitch
						v-model="onlyNotifyWhenMarketOpen"
						:disabled="needsChannelSelection"
						sr-label="Only notify when market is open"
							aria-labelledby="only_notify_when_market_open_label_add_ons"
							aria-describedby="only_notify_when_market_open_description_add_ons"
						/>
					</div>

					<div class="flex items-center justify-between gap-3 py-3">
						<input
							type="hidden"
						name="add_ons_include_news"
						:value="includeNews ? 'on' : 'off'"
					/>
					<div class="min-w-0">
						<div class="flex items-center gap-2">
							<span
								id="add_ons_include_news_label"
									class="text-base font-semibold text-gray-900"
								>
									🗞️ News
								</span>
								<GrokLogoIcon class="h-4.5 w-auto shrink-0" aria-label="Powered by Grok" role="img" />
							</div>
							<p
								id="add_ons_include_news_description"
								class="text-sm text-gray-600 mt-0.5"
							>
								Add a short news summary about the stocks you’re tracking.
							</p>
						</div>
					<ToggleSwitch
						v-model="includeNews"
						:disabled="needsChannelSelection"
						sr-label="Include news 🗞️"
							aria-labelledby="add_ons_include_news_label"
							aria-describedby="add_ons_include_news_description"
						/>
					</div>

					<div class="flex items-center justify-between gap-3 py-3">
						<input
							type="hidden"
						name="add_ons_include_rumors"
						:value="includeRumors ? 'on' : 'off'"
					/>
					<div class="min-w-0">
						<div class="flex items-center gap-2">
							<span
								id="add_ons_include_rumors_label"
									class="text-base font-semibold text-gray-900"
								>
									🤫 Rumors
								</span>
								<GrokLogoIcon class="h-4.5 w-auto shrink-0" aria-label="Powered by Grok" role="img" />
							</div>
							<p
								id="add_ons_include_rumors_description"
								class="text-sm text-gray-600 mt-0.5"
							>
								Add a short rumors/chatter summary about the stocks you’re tracking.
							</p>
						</div>
					<ToggleSwitch
						v-model="includeRumors"
						:disabled="needsChannelSelection"
						sr-label="Include rumors 🤫"
							aria-labelledby="add_ons_include_rumors_label"
							aria-describedby="add_ons_include_rumors_description"
						/>
					</div>
				</fieldset>

				<div v-if="isHydrated && nextAddOnsDeliveryText" class="mt-4 border-t border-gray-200 pt-4">
					<p class="inline-flex items-center gap-2 text-sm text-gray-600">
						<BellAlertIcon class="size-4 shrink-0 text-success-strong" aria-hidden="true" />
						<span>Next delivery <span class="font-medium text-gray-900">{{ nextAddOnsDeliveryText }}</span>.</span>
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
import ArrowTopRightOnSquareIcon from "../../icons/arrow-top-right-on-square.svg?component";
import BellAlertIcon from "../../icons/bell-alert.svg?component";
import ClockIcon from "../../icons/clock.svg?component";
import GrokLogoIcon from "../../icons/grok.svg?component";
import InformationCircleIcon from "../../icons/information-circle-20.svg?component";
import PresentationChartLineIcon from "../../icons/presentation-chart-line.svg?component";
import XMarkIcon from "../../icons/x-mark.svg?component";
import {
	CARD_GRADIENT_ACCENTS,
	DASHBOARD_ADDITIONAL_NOTIFICATIONS_FORM_ID,
	DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID,
	DASHBOARD_SECTION_IDS,
	STATUS_TONE_CLASSES,
} from "../../lib/constants";
import {
	formatCountdownWithSeconds,
	formatMinutesAsLocalTime,
	getNowInTimezone,
	getSecondsUntilNextSend,
	getUsMarketOpenLocalMinutes,
	isOutsideMarketHours,
	minutesToTimeInputValue,
	parseTimeToMinutes,
} from "../../lib/time/format";
import FadeTransition from "../FadeTransition.vue";
import ToggleSwitch from "../ToggleSwitch.vue";
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

const includeNews = ref(user.value.add_ons_include_news);
const includeRumors = ref(user.value.add_ons_include_rumors);
const addOnsDeliveryTimeMinutes = ref<number | null>(user.value.add_ons_delivery_time);
const onlyNotifyWhenMarketOpen = ref(user.value.add_ons_only_notify_when_market_open);

const addOnsEnabled = computed(() => includeNews.value || includeRumors.value);

watch(onlyNotifyWhenMarketOpen, (value) => {
	if (user.value.add_ons_only_notify_when_market_open === value) {
		return;
	}
	user.value = { ...user.value, add_ons_only_notify_when_market_open: value };
});

const currentTimeInTimezone = computed(() => {
	if (!isHydrated.value) {
		return null;
	}
	void tick.value;
	const tz = user.value.timezone ?? "";
	return tz !== "" ? getNowInTimezone(tz) : null;
});

const addOnsDeliveryTimeInput = computed(() => {
	if (addOnsDeliveryTimeMinutes.value === null) {
		return null;
	}
	return minutesToTimeInputValue(addOnsDeliveryTimeMinutes.value);
});

const addOnsTimepickerDisabled = computed(() => needsChannelSelection.value);

const marketOpenLocalMinutes = computed(() => {
	const tz = user.value.timezone ?? "";
	if (tz === "") return null;
	return getUsMarketOpenLocalMinutes(tz);
});

const marketOpenLabel = computed(() => {
	if (marketOpenLocalMinutes.value === null) return null;
	return formatMinutesAsLocalTime(marketOpenLocalMinutes.value);
});

const isMarketOpenTime = computed(() => {
	if (marketOpenLocalMinutes.value === null) return true;
	return addOnsDeliveryTimeMinutes.value === marketOpenLocalMinutes.value;
});

const canSetMarketOpen = computed(
	() => !addOnsTimepickerDisabled.value && !isMarketOpenTime.value,
);

const isAddOnsTimeOutsideMarketHours = computed(() => {
	if (!onlyNotifyWhenMarketOpen.value) return false;
	if (addOnsDeliveryTimeMinutes.value === null) return false;
	const tz = user.value.timezone ?? "";
	if (tz === "") return false;
	return isOutsideMarketHours(addOnsDeliveryTimeMinutes.value, tz);
});

function handleClearDeliveryTime() {
	if (addOnsTimepickerDisabled.value) return;
	addOnsDeliveryTimeMinutes.value = null;
	notifyChange();
}

function handleSetMarketOpen() {
	if (!canSetMarketOpen.value || marketOpenLocalMinutes.value === null) {
		return;
	}
	addOnsDeliveryTimeMinutes.value = marketOpenLocalMinutes.value;
	notifyChange();
}

const nextAddOnsDeliveryText = computed(() => {
	if (!isHydrated.value || !addOnsEnabled.value) return null;
	void tick.value;

	const tz = user.value.timezone ?? "";
	if (tz === "") return null;

	const secondsUntil = getSecondsUntilNextSend({
		nextSendAtIso: user.value.add_ons_next_send_at,
		timeInput: addOnsDeliveryTimeInput.value,
		timezone: tz,
		now: DateTime.utc(),
	});
	if (secondsUntil === null) return null;
	return secondsUntil <= 0 ? "is due soon" : `in ${formatCountdownWithSeconds(secondsUntil)}`;
});

watch(
	[includeNews, includeRumors, onlyNotifyWhenMarketOpen],
	() => {
		notifyChange();
	},
);

function handleAddOnsTimeChange(value: string) {
	const parsed = parseTimeToMinutes(value);
	if (parsed === null) return;
	addOnsDeliveryTimeMinutes.value = parsed;
	notifyChange();
}

watch(
	() => user.value.add_ons_include_news,
	(value) => {
		includeNews.value = value;
	},
);
watch(
	() => user.value.add_ons_include_rumors,
	(value) => {
		includeRumors.value = value;
	},
);
watch(
	() => user.value.add_ons_delivery_time,
	(value) => {
		addOnsDeliveryTimeMinutes.value = value;
	},
);
watch(
	() => user.value.add_ons_only_notify_when_market_open,
	(value) => {
		onlyNotifyWhenMarketOpen.value = value;
	},
);

/* =============
Keep dashboard user state aligned with autosave responses
============= */
watch(
	() => savedData.value,
	(newData) => {
		if (!newData) {
			return;
		}
		user.value = {
			...user.value,
			add_ons_include_news: newData.add_ons_include_news,
			add_ons_include_rumors:
				newData.add_ons_include_rumors,
			add_ons_delivery_time: newData.add_ons_delivery_time,
			add_ons_next_send_at: newData.add_ons_next_send_at,
			add_ons_only_notify_when_market_open: newData.add_ons_only_notify_when_market_open,
		};
	},
);
</script>

