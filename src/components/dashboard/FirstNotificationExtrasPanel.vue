<template>
	<form
		ref="extrasFormElement"
		:id="DASHBOARD_FIRST_NOTIFICATION_EXTRAS_FORM_ID"
		method="POST"
		action="/api/notification-preferences/update"
		class="space-y-6"
		aria-label="Notification add-ons"
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
				<header class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
					<div class="flex items-start gap-3 min-w-0">
						<input
							type="hidden"
							name="add_ons_notifications_enabled"
							:value="addOnsNotificationsEnabled ? 'on' : 'off'"
						/>
						<input
							type="checkbox"
							value="on"
							id="add_ons_notifications_enabled"
							class="mt-1 h-5 w-5 shrink-0 cursor-pointer rounded border-gray-300 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed"
							:checked="needsChannelSelection || addOnsNotificationsEnabled"
							:disabled="needsChannelSelection"
							@change="
								addOnsNotificationsEnabled = ($event.target as HTMLInputElement).checked
							"
							:aria-labelledby="DASHBOARD_SECTION_IDS.firstNotificationExtras"
							aria-describedby="add_ons_notifications_enabled_description"
						/>
						<div class="min-w-0">
							<h2
								:id="DASHBOARD_SECTION_IDS.firstNotificationExtras"
								class="text-xl sm:text-2xl font-bold text-gray-900"
							>
								<label for="add_ons_notifications_enabled" class="cursor-pointer">
									Notification Add-ons
								</label>
							</h2>
						<p
							id="add_ons_notifications_enabled_description"
							class="text-sm text-gray-600 mt-1"
						>
							A daily notification with your selected add-ons, sent at the time below — separate from scheduled price alerts.
						</p>
						<p
						class="text-sm text-gray-600 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 transition-opacity duration-200"
						:class="{ 'opacity-50': needsChannelSelection || !addOnsNotificationsEnabled }"
					>
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
					</div>
				</header>

			<SetupRequiredNotice
				class="pl-8"
				:needsChannelSelection="needsChannelSelection"
				:needsPhoneVerification="needsPhoneVerification"
				:phoneVerificationSectionId="phoneVerificationSectionId"
			/>

			<fieldset
				class="pl-8 divide-y divide-gray-100 transition-opacity duration-200"
					:class="{ 'opacity-50': needsChannelSelection || !addOnsNotificationsEnabled }"
					:aria-disabled="needsChannelSelection || !addOnsNotificationsEnabled ? 'true' : undefined"
				>
					<legend class="sr-only">Notification add-ons settings</legend>

					<div class="flex items-start justify-between gap-3 py-3">
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
								Choose the daily delivery time.
							</p>
						</div>
						<TimePicker
							:inputId="`add_ons_delivery_time`"
							:inputName="`add_ons_delivery_time`"
							:initialTime="addOnsDeliveryTimeInput"
							inputAriaLabel="Daily add-ons delivery time"
							:disabled="needsChannelSelection || !addOnsNotificationsEnabled"
							@time-change="handleAddOnsTimeChange"
						/>
					</div>

					<div class="flex items-center justify-between gap-3 py-3">
						<input
							type="hidden"
							name="only_notify_when_market_open"
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
							:disabled="needsChannelSelection || !addOnsNotificationsEnabled"
							sr-label="Only notify when market is open"
							aria-labelledby="only_notify_when_market_open_label_add_ons"
							aria-describedby="only_notify_when_market_open_description_add_ons"
						/>
					</div>

					<div class="flex items-center justify-between gap-3 py-3">
						<input
							type="hidden"
							name="first_notification_include_news"
							:value="includeNews ? 'on' : 'off'"
						/>
						<div class="min-w-0">
							<div class="flex items-center gap-2">
								<span
									id="first_notification_include_news_label"
									class="text-base font-semibold text-gray-900"
								>
									🗞️ News
								</span>
								<GrokLogoIcon class="h-4.5 w-auto shrink-0" aria-label="Powered by Grok" role="img" />
							</div>
							<p
								id="first_notification_include_news_description"
								class="text-sm text-gray-600 mt-0.5"
							>
								Add a short news summary about the stocks you’re tracking.
							</p>
						</div>
						<ToggleSwitch
							v-model="includeNews"
							:disabled="needsChannelSelection || !addOnsNotificationsEnabled"
							sr-label="Include news 🗞️"
							aria-labelledby="first_notification_include_news_label"
							aria-describedby="first_notification_include_news_description"
						/>
					</div>

					<div class="flex items-center justify-between gap-3 py-3">
						<input
							type="hidden"
							name="first_notification_include_rumors"
							:value="includeRumors ? 'on' : 'off'"
						/>
						<div class="min-w-0">
							<div class="flex items-center gap-2">
								<span
									id="first_notification_include_rumors_label"
									class="text-base font-semibold text-gray-900"
								>
									🤫 Rumors
								</span>
								<GrokLogoIcon class="h-4.5 w-auto shrink-0" aria-label="Powered by Grok" role="img" />
							</div>
							<p
								id="first_notification_include_rumors_description"
								class="text-sm text-gray-600 mt-0.5"
							>
								Add a short rumors/chatter summary about the stocks you’re tracking.
							</p>
						</div>
						<ToggleSwitch
							v-model="includeRumors"
							:disabled="needsChannelSelection || !addOnsNotificationsEnabled"
							sr-label="Include rumors 🤫"
							aria-labelledby="first_notification_include_rumors_label"
							aria-describedby="first_notification_include_rumors_description"
						/>
					</div>
				</fieldset>

				<div v-if="isHydrated && nextAddOnsDeliveryText" class="pl-8 mt-4 border-t border-gray-200 pt-4">
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
import {
	CARD_GRADIENT_ACCENTS,
	DASHBOARD_FIRST_NOTIFICATION_EXTRAS_FORM_ID,
	DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID,
	DASHBOARD_SECTION_IDS,
	STATUS_TONE_CLASSES,
} from "../../lib/constants";
import {
	formatCountdownWithSeconds,
	getNowInTimezone,
	getSecondsUntilNextSend,
	minutesToTimeInputValue,
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

const includeNews = ref(user.value.first_notification_include_news);
const includeRumors = ref(user.value.first_notification_include_rumors);
const addOnsNotificationsEnabled = ref(user.value.add_ons_notifications_enabled);
const addOnsDeliveryTimeMinutes = ref<number | null>(user.value.add_ons_delivery_time);
const onlyNotifyWhenMarketOpen = ref(user.value.only_notify_when_market_open);

const addOnsEnabled = computed(() => includeNews.value || includeRumors.value);

watch(onlyNotifyWhenMarketOpen, (value) => {
	if (user.value.only_notify_when_market_open === value) {
		return;
	}
	user.value = { ...user.value, only_notify_when_market_open: value };
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

const nextAddOnsDeliveryText = computed(() => {
	if (!isHydrated.value) {
		return null;
	}
	void tick.value;

	if (!addOnsNotificationsEnabled.value) {
		return null;
	}
	if (!addOnsEnabled.value) {
		return null;
	}
	const tz = user.value.timezone ?? "";
	if (tz === "") {
		return null;
	}

	const secondsUntil = getSecondsUntilNextSend({
		nextSendAtIso: user.value.add_ons_next_send_at,
		timeInput: addOnsDeliveryTimeInput.value,
		timezone: tz,
		now: DateTime.utc(),
	});
	if (secondsUntil === null) {
		return null;
	}
	if (secondsUntil <= 0) {
		return "is due soon";
	}
	return `in ${formatCountdownWithSeconds(secondsUntil)}`;
});

watch(
	[
		includeNews,
		includeRumors,
		onlyNotifyWhenMarketOpen,
	],
	() => {
	notifyChange();
	},
);

function handleAddOnsTimeChange(value: string) {
	const parts = value.split(":");
	if (parts.length !== 2) {
		return;
	}
	const hours = Number.parseInt(parts[0] ?? "", 10);
	const minutes = Number.parseInt(parts[1] ?? "", 10);
	if (
		Number.isNaN(hours) ||
		Number.isNaN(minutes) ||
		hours < 0 ||
		hours > 23 ||
		minutes < 0 ||
		minutes > 59
	) {
		return;
	}
	addOnsDeliveryTimeMinutes.value = hours * 60 + minutes;
	notifyChange();
}

watch(
	() => user.value.first_notification_include_news,
	(value) => {
		includeNews.value = value;
	},
);
watch(
	() => user.value.first_notification_include_rumors,
	(value) => {
		includeRumors.value = value;
	},
);
watch(
	() => user.value.add_ons_notifications_enabled,
	(value) => {
		addOnsNotificationsEnabled.value = value;
	},
);
watch(
	() => user.value.add_ons_delivery_time,
	(value) => {
		addOnsDeliveryTimeMinutes.value = value;
	},
);
watch(
	() => user.value.only_notify_when_market_open,
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
			first_notification_include_news: newData.first_notification_include_news,
			first_notification_include_rumors:
				newData.first_notification_include_rumors,
			add_ons_notifications_enabled: newData.add_ons_notifications_enabled,
			add_ons_delivery_time: newData.add_ons_delivery_time,
			add_ons_next_send_at: newData.add_ons_next_send_at,
			only_notify_when_market_open: newData.only_notify_when_market_open,
		};
	},
);
</script>

