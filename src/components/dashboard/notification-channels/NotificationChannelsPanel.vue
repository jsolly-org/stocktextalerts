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

			<div class="card-accent card-accent-primary"></div>
			<div class="card-body">

			<NotificationChannelsFieldset
				v-model:email-enabled="emailEnabledModel"
				:email-notifications-enabled-id="emailNotificationsEnabledId"
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
					<span>Next delivery <span class="font-medium text-heading">{{ nextDailyDeliveryText }}</span>.</span>
				</p>
			</div>
			</div>
		</section>
	</form>

	<!-- Notification Preview -->
	<section class="card">
		<div class="card-accent card-accent-gray"></div>
		<div class="card-body">
			<header class="mb-4">
				<h2 class="text-xl sm:text-2xl font-bold text-heading">
					Notification Preview
				</h2>
				<p class="text-sm text-body-secondary mt-1">
					See how your asset updates appear when delivered. Sent to whichever channels you enable — email or Telegram.
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
import { computed, onMounted, onUnmounted, ref, toRefs, watch } from "vue";
import BellAlertIcon from "../../../icons/bell-alert.svg?component";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
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
	emailEnabled: boolean;
	initialAssets: InitialAsset[];
	hasTrackedAssets: boolean;
}

const props = defineProps<Props>();
const { emailEnabled: emailEnabledProp } = toRefs(props);

const emit = defineEmits<(event: "update:emailEnabled", value: boolean) => void>();

// Inject the shared mutable user ref from DashboardPanels
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

/* ============= Auto-save composable ============= */
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

/* ============= Channel state ============= */
const emailNotificationsEnabledId = `${DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID}-email_notifications_enabled`;
const notificationChannelsDescId = `${DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID}-notification-channels-desc`;

const emailEnabledModel = computed({
	get: () => emailEnabledProp.value,
	set: (value: boolean) => emit("update:emailEnabled", value),
});

watch(emailEnabledModel, () => {
	notifyChange();
});

// Watch savedData and update shared user ref directly (no more event bubbling)
watch(
	() => savedNotificationPreferencesData.value,
	(newData) => {
		if (newData) {
			// Update shared user ref directly
			user.value = {
				...user.value,
				email_notifications_enabled: newData.email_notifications_enabled,
				daily_notification_time: newData.daily_notification_time,
				daily_notification_next_send_at: newData.daily_notification_next_send_at,
				market_scheduled_asset_price_next_send_at: newData.market_scheduled_asset_price_next_send_at,
			};
			// Sync channel state with parent
			emit("update:emailEnabled", newData.email_notifications_enabled);
		}
	},
);

/* ============= Daily Delivery Time ============= */

/**
 * Stored `market_scheduled_asset_price_times` are ET-canonical minutes (Phase 9
 * migration). Convert each to user-local before deriving the earliest, so the
 * fallback delivery-time display matches what the user sees in the market
 * notifications picker.
 */
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

// Sync delivery time from user state (e.g. after save from another panel)
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

/* ============= Next delivery countdown ============= */
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

/* ============= Notification Preview ============= */
const needsTrackedAssets = computed(() => !props.hasTrackedAssets);
const needsChannelSelection = computed(() => !emailEnabledProp.value);
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

