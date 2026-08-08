<template>
	<div class="flex flex-col gap-6">
	<form
		ref="notificationPreferencesFormElement"
		:id="DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID"
		method="POST"
		action="/api/notification-preferences/update"
		aria-label="Notification preferences"
		:aria-busy="isSaving"
		:data-hydrated="isHydrated || undefined"
		@input="handleFormInput"
		@change="handleFormChange"
		@submit="handleFormSubmit"
	>
		<section
			class="card relative"
			data-notification-channels-card
			:data-form-id="DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID"
		>
			<FormStatusBadge
				:status-message="statusMessage"
				:status-tone="statusTone"
				:is-saving="isSaving"
				:id="DASHBOARD_NOTIFICATION_PREFERENCES_STATUS_ID"
			/>

			<div class="card-body">

			<NotificationChannelsFieldset
				v-model:delivery-channel="deliveryChannelModel"
				:notification-channels-desc-id="notificationChannelsDescId"
				:daily-delivery-time-input="dailyDeliveryTimeInput"
				:daily-delivery-time-minutes="dailyDeliveryTimeMinutes"
				:is24="user.use_24_hour_time"
				:before-open-label="beforeOpenLabel"
				:is-before-open-time="isBeforeOpenTime"
				@daily-time-change="handleDailyTimeChange"
				@clear-delivery-time="handleClearDeliveryTime"
				@set-before-open="handleSetBeforeOpen"
			/>

			<div v-if="isHydrated && nextDailyDeliveryText" class="mt-4">
				<p class="inline-flex items-center gap-2 text-sm text-body-secondary">
					<BellAlertIcon class="size-4 shrink-0 text-success-strong" aria-hidden="true" />
					<span>Next delivery <span class="font-medium text-heading">{{ nextDailyDeliveryText }}</span>. It can take a minute or two for the notification to arrive.</span>
				</p>
			</div>
			</div>
		</section>
	</form>

	<section class="card">
		<div class="card-body">
			<header class="mb-4">
				<h2 class="text-xl sm:text-2xl font-bold text-heading">
					Notification Preview
				</h2>
				<p class="text-sm text-body-secondary mt-1">
					See how your asset updates appear when delivered on your selected channel.
				</p>
			</header>

			<SetupRequiredNotice
				:needs-tracked-assets="needsTrackedAssets"
				:needs-channel-selection="needsChannelSelection"
			/>

			<div
				class="transition-opacity duration-200"
				:class="{ 'opacity-50': notificationSetupBlocked }"
			>
				<div class="mb-6">
					<div class="flex min-w-0 justify-center">
						<NotificationPreview :assets="previewAssets" />
					</div>
				</div>
			</div>
		</div>
	</section>
	</div>
</template>

<script lang="ts" setup>
import { DateTime } from "luxon";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import BellAlertIcon from "../../../icons/bell-alert.svg?component";
import type { DeliveryChannelMode } from "../../../lib/constants";
import { needsNotificationChannelSelection } from "../../../lib/messaging/delivery-channel";
import { etMinuteToUserLocal, getUsBeforeOpenLocalMinutes } from "../../../lib/time/conversion";
import {
	formatCountdownWithSeconds,
	formatMinutesAsLocalTime,
	getSecondsUntilNextSend,
	minutesToTimeInputValue,
} from "../../../lib/time/display";
import { parseTimeToMinutes } from "../../../lib/time/parse";
import { useHydrated } from "../../useHydrated";
import { useAutoSaveForm } from "../composables/useAutoSaveNotificationPreferences";
import { useDashboardUser } from "../composables/useDashboardUser";
import {
	DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID,
	DASHBOARD_NOTIFICATION_PREFERENCES_STATUS_ID,
} from "../constants";
import FormStatusBadge from "../shared/FormStatusBadge.vue";
import SetupRequiredNotice from "../shared/SetupRequiredNotice.vue";
import type { InitialAsset, NotificationPreferencesData } from "../types";
import NotificationChannelsFieldset from "./NotificationChannelsFieldset.vue";
import NotificationPreview from "./preview/NotificationPreview.vue";
import { DEMO_ASSETS } from "./preview/preview-data";
import type { PreviewAsset } from "./preview/types";

interface Props {
	initialAssets: InitialAsset[];
	hasTrackedAssets: boolean;
}

const props = defineProps<Props>();

const user = useDashboardUser();

const isHydrated = useHydrated();
const tick = ref(0);
let intervalId: number | null = null;

onMounted(() => {
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

const notificationPreferencesFormElement = ref<HTMLFormElement | null>(null);
const {
	handleFormChange,
	handleFormInput,
	handleFormSubmit,
	isSaving,
	notifyChange,
	savedData: savedNotificationPreferencesData,
	statusMessage,
	statusTone,
} = useAutoSaveForm<NotificationPreferencesData>({
	formRef: notificationPreferencesFormElement,
});

const notificationChannelsDescId = `${DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID}-notification-channels-desc`;

const deliveryChannelModel = computed({
	get: () => user.value.delivery_channel,
	set: (value: DeliveryChannelMode) => {
		user.value = { ...user.value, delivery_channel: value };
		notifyChange();
	},
});

watch(
	() => savedNotificationPreferencesData.value,
	(newData) => {
		if (newData) {
			user.value = {
				...user.value,
				delivery_channel: newData.delivery_channel,
				daily_notification_time: newData.daily_notification_time,
				daily_notification_next_send_at: newData.daily_notification_next_send_at,
				market_scheduled_asset_price_next_send_at: newData.market_scheduled_asset_price_next_send_at,
			};
		}
	},
);

function getEarliestMarketNotificationTime(): number | null {
	const times = user.value.market_scheduled_asset_price_times;
	if (!times || times.length === 0) return null;
	const local = times.map((et) => etMinuteToUserLocal(et, user.value.timezone));
	return Math.min(...local);
}

const dailyDeliveryTimeMinutes = ref<number | null>(
	user.value.daily_notification_time ?? getEarliestMarketNotificationTime(),
);

const dailyDeliveryTimeInput = computed(() =>
	dailyDeliveryTimeMinutes.value !== null
		? minutesToTimeInputValue(dailyDeliveryTimeMinutes.value)
		: null,
);

const beforeOpenLocalMinutes = computed(() => getUsBeforeOpenLocalMinutes(user.value.timezone));

const beforeOpenLabel = computed(() =>
	formatMinutesAsLocalTime(beforeOpenLocalMinutes.value, user.value.use_24_hour_time),
);

const isBeforeOpenTime = computed(
	() => dailyDeliveryTimeMinutes.value === beforeOpenLocalMinutes.value,
);

function handleDailyTimeChange(value: string) {
	const parsed = parseTimeToMinutes(value);
	if (parsed === null) return;
	dailyDeliveryTimeMinutes.value = parsed;
	notifyChange();
}

function handleClearDeliveryTime() {
	dailyDeliveryTimeMinutes.value = null;
	notifyChange();
}

function handleSetBeforeOpen() {
	if (beforeOpenLocalMinutes.value === null || isBeforeOpenTime.value) return;
	dailyDeliveryTimeMinutes.value = beforeOpenLocalMinutes.value;
	notifyChange();
}

watch(
	() => user.value.daily_notification_time,
	(value) => {
		dailyDeliveryTimeMinutes.value = value ?? getEarliestMarketNotificationTime();
	},
);
watch(
	() => user.value.market_scheduled_asset_price_times,
	(times) => {
		if (user.value.daily_notification_time !== null) return;
		dailyDeliveryTimeMinutes.value =
			times && times.length > 0 ? getEarliestMarketNotificationTime() : null;
	},
);

const nextDailyDeliveryText = computed(() => {
	if (!isHydrated.value) return null;
	void tick.value;
	const hasDeliveryTime =
		user.value.daily_notification_next_send_at != null ||
		dailyDeliveryTimeInput.value != null;
	if (!hasDeliveryTime) return null;

	const secondsUntil = getSecondsUntilNextSend({
		nextSendAtIso: user.value.daily_notification_next_send_at,
		timeInput: dailyDeliveryTimeInput.value,
		timezone: user.value.timezone,
		now: DateTime.utc(),
	});
	if (secondsUntil === null) return null;
	return secondsUntil <= 0 ? "is due soon" : `in ${formatCountdownWithSeconds(secondsUntil)}`;
});

const needsTrackedAssets = computed(() => !props.hasTrackedAssets);
const needsChannelSelection = computed(() => needsNotificationChannelSelection(user.value));
const notificationSetupBlocked = computed(
	() => needsChannelSelection.value || needsTrackedAssets.value,
);

const previewAssets = computed<PreviewAsset[]>(() => {
	const assets = props.initialAssets;
	if (assets.length === 0) {
		return DEMO_ASSETS;
	}
	return assets.slice(0, 3).map((asset, i) => {
		const demo = DEMO_ASSETS[i % DEMO_ASSETS.length];
		return {
			symbol: asset.symbol,
			name: asset.name,
			price: demo.price,
			changePercent: demo.changePercent,
			sparkline: demo.sparkline,
			sparklineValues: demo.sparklineValues,
		};
	});
});
</script>
